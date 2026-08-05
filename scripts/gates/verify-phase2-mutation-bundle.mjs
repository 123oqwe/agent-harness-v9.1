#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { validateSchemaDocument } from "./json-schema.mjs";
import { securePublish } from "./secure-publish.mjs";
import { runTrustedGit, validateProtectedExecutable } from "./trusted-git.mjs";
import { workflowAstSha256 } from "./workflow-contract.mjs";

const HASH_64 = /^[a-f0-9]{64}$/u;
const SHA_40 = /^[a-f0-9]{40}$/u;
const PUBLICATION_SCHEMA = "phase2-mutation-publication-receipt/v2";
const ATTESTATION_SCHEMA = "phase2-mutation-attestation-receipt/v1";
const REPOSITORY = "123oqwe/agentharness91";
const WORKFLOW_PATH = ".github/workflows/phase2-mutation.yml";
const API_HOST = "api.github.com";
const FORMAL_SIGNER_WORKFLOW = "123oqwe/phase2-authority/.github/workflows/verify.yml";
const WORKFLOW_AST_SHA256 = "c76971d2ab2ef7ced7c47c4bcb95a938b978935cc02458720cbdda9729a4a09c";
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 120_000;
const schemaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../verification/schemas");
const schemaNames = [
  "phase2-mutation-publication-receipt.schema.json", "phase2-mutation-draft.schema.json",
  "phase2-mutation-candidate.schema.json", "phase2-mutation-execution-receipt.schema.json",
  "phase2-mutation-attestation-receipt.schema.json",
];
const localSchemas = schemaNames.map((name) => JSON.parse(readFileSync(join(schemaDirectory, name), "utf8")));
const localSchemasById = new Map(localSchemas.map((schema) => [schema.$id, schema]));
const localSchema = (suffix) => localSchemas.find((schema) => schema.$id.endsWith(suffix));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const exactKeys = (value, expected) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const publicationFields = [
  "schema_version", "commit_sha", "tree_sha", "batch_sha256", "publication_path",
  "publication_set_sha256", "candidate_report_sha256", "execution_receipt_sha256",
];
const attestationFields = [
  "schema_version", "repository", "workflow_ref", "run_id", "run_attempt", "head_sha",
  "conclusion", "artifact_name", "artifact_id", "artifact_size", "artifact_digest", "verification_method", "issuer",
];
const expectedArtifactPath = (result, chunk, kind) =>
  ["raw", result.requirement_id, chunk.chunk_id, kind === "raw" ? "mutation.json" : "stryker.config.json"].join("/");
const fileSetSha256 = (entries) => {
  const hash = createHash("sha256");
  for (const [path, bytes] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path); hash.update("\0"); hash.update(bytes); hash.update("\0");
  }
  return hash.digest("hex");
};

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const safeZipPath = (name) => typeof name === "string" && name.length > 0 && name.length <= 4096 &&
  !name.startsWith("/") && !name.includes("\\") && !name.includes("\0") &&
  name.split("/").every((part, index, parts) => (part.length > 0 || index === parts.length - 1) && part !== "." && part !== "..");

export const extractPhase2ArtifactZip = (archive) => {
  const bytes = Buffer.from(archive ?? []);
  if (bytes.length < 22 || bytes.length > MAX_ARTIFACT_BYTES) throw new Error("ZIP size is outside verifier bounds");
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1)
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  if (eocd < 0) throw new Error("ZIP end record is missing");
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || entries > 10_000 || entries === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff || eocd + 22 + commentLength !== bytes.length ||
      centralOffset + centralSize !== eocd)
    throw new Error("ZIP central directory is unsupported or inconsistent");
  const output = new Map();
  const localRanges = [];
  let total = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP central entry is invalid");
    const creator = bytes.readUInt16LE(cursor + 4) >>> 8;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > eocd || (flags & 1) !== 0 || ![0, 8].includes(method) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      throw new Error("ZIP entry uses an unsafe or unsupported feature");
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (!safeZipPath(name)) throw new Error(`ZIP path is unsafe or traversal-like: ${name}`);
    const directory = name.endsWith("/");
    const unixMode = creator === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    if (fileType !== 0 && fileType !== (directory ? 0o040000 : 0o100000))
      throw new Error(`ZIP entry is not a regular file: ${name}`);
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error("ZIP local entry is invalid");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameBytes = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const localName = localNameBytes.toString("utf8");
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (localName !== name || localFlags !== flags || localMethod !== method || dataEnd > centralOffset ||
        ((flags & 0x08) === 0 && (localCrc !== expectedCrc || localCompressedSize !== compressedSize ||
          localUncompressedSize !== uncompressedSize)))
      throw new Error("ZIP local and central entries disagree");
    let rangeEnd = dataEnd;
    if ((flags & 0x08) !== 0) {
      if (rangeEnd + 12 > centralOffset) throw new Error("ZIP data descriptor is truncated");
      const signed = bytes.readUInt32LE(rangeEnd) === 0x08074b50;
      const descriptor = rangeEnd + (signed ? 4 : 0);
      if (descriptor + 12 > centralOffset || bytes.readUInt32LE(descriptor) !== expectedCrc ||
          bytes.readUInt32LE(descriptor + 4) !== compressedSize || bytes.readUInt32LE(descriptor + 8) !== uncompressedSize)
        throw new Error("ZIP data descriptor disagrees with the central directory");
      rangeEnd = descriptor + 12;
    }
    localRanges.push([localOffset, rangeEnd]);
    if (!directory) {
      if (output.has(name)) throw new Error(`ZIP contains duplicate path: ${name}`);
      total += uncompressedSize;
      if (uncompressedSize > MAX_ARTIFACT_BYTES || total > MAX_ARTIFACT_BYTES ||
          (compressedSize > 0 && uncompressedSize > 1024 * 1024 && uncompressedSize / compressedSize > 100))
        throw new Error("ZIP expansion exceeds verifier bounds");
      const content = method === 0 ? Buffer.from(bytes.subarray(dataStart, dataEnd)) :
        inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: uncompressedSize + 1 });
      if (content.length !== uncompressedSize || crc32(content) !== expectedCrc)
        throw new Error(`ZIP content integrity failed: ${name}`);
      output.set(name, content);
    }
    cursor = end;
  }
  if (cursor !== eocd) throw new Error("ZIP central directory has trailing ambiguity");
  localRanges.sort((left, right) => left[0] - right[0]);
  let expectedOffset = 0;
  for (const [start, end] of localRanges) {
    if (start !== expectedOffset || end <= start) throw new Error("ZIP local entries overlap or contain hidden trailing data");
    expectedOffset = end;
  }
  if (expectedOffset !== centralOffset) throw new Error("ZIP contains hidden data before the central directory");
  return output;
};

export const rebuildRawMutationCounts = (raw) => {
  const counts = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
  const files = raw?.files;
  if (files === null || typeof files !== "object" || Array.isArray(files))
    throw new Error("raw Stryker files must be an object");
  for (const file of Object.values(files)) {
    if (!Array.isArray(file?.mutants)) throw new Error("raw Stryker mutants must be an array");
    for (const mutant of file.mutants) {
      counts.total += 1;
      const field = { Killed: "killed", Timeout: "timeout", Survived: "survived", NoCoverage: "noCoverage" }[mutant?.status];
      if (field === undefined) throw new Error(`raw Stryker mutant has non-terminal status: ${String(mutant?.status)}`);
      counts[field] += 1;
    }
  }
  return counts;
};

const scoreFromCounts = (counts) => {
  const testable = counts.total - counts.ignored;
  return testable <= 0 ? 0 : Number((((counts.killed + counts.timeout) / testable) * 100).toFixed(2));
};

const quotedValues = (source) => [...source.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/gu)]
  .map((match) => JSON.parse(`"${match[1]}"`));

const parseCommittedMutationRegistry = (source) => {
  const requirements = [];
  const call = /requirement\(\s*"([A-Z0-9-]+)"\s*(?:,\s*\{([\s\S]*?)\})?\s*\),/gu;
  for (const match of source.matchAll(call)) {
    const options = match[2] ?? "";
    const array = (field) => {
      const found = new RegExp(`${field}\\s*:\\s*(\\[[\\s\\S]*?\\])`, "u").exec(options);
      return found ? quotedValues(found[1]) : [];
    };
    requirements.push({ id: match[1], sources: array("sources"),
      integration_sources: array("integrationSources") });
  }
  if (requirements.length !== 64 || new Set(requirements.map((entry) => entry.id)).size !== 64)
    throw new Error(`committed mutation registry must contain 64 unique restricted entries; received ${requirements.length}`);
  return requirements;
};

const loadCommittedMutationAuthority = (root, commitSha) => {
  const manifest = JSON.parse(runTrustedGit(root, ["cat-file", "blob", `${commitSha}:verification/gates/phase2-gate.json`], { encoding: "utf8" }));
  const registrySource = runTrustedGit(root, ["cat-file", "blob", `${commitSha}:mutation/phase2-modules.mjs`], { encoding: "utf8" });
  const registry = parseCommittedMutationRegistry(registrySource);
  if (!Array.isArray(manifest?.requirements) || manifest.requirements.length !== 64)
    throw new Error("committed Phase 2 manifest must contain exactly 64 requirements");
  const manifestById = new Map(manifest.requirements.map((entry) => [entry.id, entry]));
  const registryById = new Map(registry.map((entry) => [entry.id, entry]));
  if (manifestById.size !== 64 || [...manifestById.keys()].some((id) => !registryById.has(id)))
    throw new Error("committed manifest and mutation registry requirement sets differ");
  return { manifest, manifestById, registryById,
    manifest_sha256: sha256(Buffer.from(JSON.stringify(manifest))), registry_sha256: sha256(Buffer.from(registrySource)) };
};

const validateIndependentCandidateSemantics = ({ report, files, authority }) => {
  const errors = [];
  const ids = (report.results ?? []).map((result) => result?.requirement_id);
  if (new Set(ids).size !== ids.length) errors.push("duplicate mutation requirement result");
  const expectedIds = [...authority.manifestById.keys()].sort();
  if (canonicalJson([...new Set(ids)].sort()) !== canonicalJson(expectedIds))
    errors.push("candidate requirement IDs differ from the frozen 64-ID authority");
  const aggregate = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
  let completed = 0;
  const completenessRows = [];
  for (const result of report.results ?? []) {
    const manifest = authority.manifestById.get(result?.requirement_id);
    const registry = authority.registryById.get(result?.requirement_id);
    if (!manifest || !registry) { errors.push(`unknown requirement ${String(result?.requirement_id)}`); continue; }
    const threshold = authority.manifest.mutation_thresholds?.[manifest.mutation_class];
    if (result.mutation_class !== manifest.mutation_class || result.threshold !== threshold)
      errors.push(`${result.requirement_id} threshold authority mismatch`);
    // When the manifest declares owned_sources, registry must match exactly.
    // When the manifest does not declare owned_sources (candidate-only state),
    // registry sources are accepted as candidate sources without manifest match.
    const manifestOwned = Object.hasOwn(manifest, "owned_sources") ? manifest.owned_sources : null;
    const manifestIntegration = Object.hasOwn(manifest, "integration_sources") ? manifest.integration_sources : null;
    if ((manifestOwned !== null && canonicalJson(registry.sources) !== canonicalJson(manifestOwned)) ||
        (manifestIntegration !== null && canonicalJson(registry.integration_sources) !== canonicalJson(manifestIntegration)))
      errors.push(`${result.requirement_id} registry/gate source authority mismatch`);
    if (canonicalJson(result.tests) !== canonicalJson(manifest.test_suites) ||
        canonicalJson(result.sources) !== canonicalJson(registry.sources) ||
        canonicalJson(result.integration_sources) !== canonicalJson(registry.integration_sources))
      errors.push(`${result.requirement_id} source/test authority mismatch`);
    if (!Array.isArray(result.sources) || result.sources.length === 0)
      errors.push(`${result.requirement_id} has an empty source authority`);
    if (!Array.isArray(result.chunks) || result.chunks.length === 0 || result.expected_chunk_count !== result.chunks.length)
      errors.push(`${result.requirement_id} has a partial chunk set`);
    const rebuilt = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
    const perFile = new Map((result.sources ?? []).map((path) => [path, { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 }]));
    const mutantIds = [];
    for (const chunk of result.chunks ?? []) {
      const rawPath = expectedArtifactPath(result, chunk, "raw");
      try {
        const raw = JSON.parse(files.get(rawPath)?.toString("utf8") ?? "null");
        const counts = rebuildRawMutationCounts(raw);
        if (counts.total === 0) errors.push(`${chunk.chunk_id} contains zero mutants`);
        for (const key of Object.keys(rebuilt)) rebuilt[key] += counts[key];
        const rawFiles = Object.entries(raw.files ?? {});
        if (rawFiles.length !== 1 || rawFiles[0][0] !== chunk.source_file)
          errors.push(`${chunk.chunk_id} raw source authority mismatch`);
        const target = perFile.get(chunk.source_file);
        if (!target) errors.push(`${chunk.chunk_id} source is outside requirement authority`);
        else for (const key of Object.keys(target)) target[key] += counts[key];
        for (const mutant of rawFiles[0]?.[1]?.mutants ?? [])
          mutantIds.push([result.requirement_id, chunk.chunk_id, chunk.source_file, mutant.id, mutant.mutatorName,
            mutant.location, mutant.replacement, mutant.status]);
      } catch (error) { errors.push(`${chunk.chunk_id} raw reconstruction failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (new Set(mutantIds.map((row) => canonicalJson(row))).size !== mutantIds.length)
      errors.push(`${result.requirement_id} contains duplicate mutant identities`);
    if (canonicalJson(rebuilt) !== canonicalJson(result.counts) || scoreFromCounts(rebuilt) !== result.score)
      errors.push(`${result.requirement_id} reconstructed mutation metrics mismatch`);
    for (const [path, counts] of perFile) {
      if (canonicalJson(counts) !== canonicalJson(result.per_file?.[path]) || scoreFromCounts(counts) < threshold)
        errors.push(`${result.requirement_id} per-file threshold failed for ${path}`);
    }
    const passed = rebuilt.total > 0 && scoreFromCounts(rebuilt) >= threshold &&
      [...perFile.values()].every((counts) => counts.total > 0 && scoreFromCounts(counts) >= threshold);
    if (result.status !== (passed ? "PASS" : "FAIL")) errors.push(`${result.requirement_id} PASS is not derivable`);
    if (passed) completed += 1;
    for (const key of Object.keys(aggregate)) aggregate[key] += rebuilt[key];
    completenessRows.push([result.requirement_id, sha256(canonicalJson(mutantIds.sort()))]);
  }
  if (canonicalJson(aggregate) !== canonicalJson(report.aggregate) || scoreFromCounts(aggregate) !== report.aggregate_score)
    errors.push("candidate aggregate metrics mismatch");
  if (completed !== report.completed || report.completed !== 64 || report.required !== 64 || report.status !== "PASS")
    errors.push("candidate completion/PASS mismatch");
  const receiptBytes = files.get("mutant-completeness-receipt.json");
  if (!receiptBytes) errors.push("mutant completeness receipt body is missing");
  else try {
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    const expected = sha256(canonicalJson(completenessRows.sort()));
    if (receipt?.schema_version !== "phase2-mutant-completeness/v1" || receipt?.requirements !== 64 ||
        receipt?.mutant_identity_sha256 !== expected || sha256(canonicalJson(receipt)) !== report.execution_receipt?.mutant_completeness_sha256)
      errors.push("mutant completeness receipt cannot be independently reconstructed");
  } catch { errors.push("mutant completeness receipt is invalid JSON"); }
  return errors;
};

const exactPublicationReceipt = (receipt) =>
  exactKeys(receipt, publicationFields) && receipt.schema_version === PUBLICATION_SCHEMA &&
  SHA_40.test(receipt.commit_sha ?? "") && SHA_40.test(receipt.tree_sha ?? "") &&
  HASH_64.test(receipt.batch_sha256 ?? "") && HASH_64.test(receipt.publication_set_sha256 ?? "") &&
  HASH_64.test(receipt.candidate_report_sha256 ?? "") && HASH_64.test(receipt.execution_receipt_sha256 ?? "") &&
  receipt.publication_path === `reports/phase2/mutation-publications/${receipt.batch_sha256}`;

const validateCandidateBuiltins = (report) => {
  const errors = [];
  if (!exactKeys(report, [
    "schema_version", "phase", "target", "status", "evidence_eligible", "commit_sha", "tree_sha",
    "registry_sha256", "manifest_sha256", "phase1_mutation_registry_sha256", "configuration_hash",
    "thresholds", "completed", "required", "aggregate", "aggregate_score", "results", "errors",
    "batch_sha256", "source_root", "artifact_root", "execution_receipt",
  ])) errors.push("candidate exact field schema mismatch");
  if (report?.schema_version !== "phase2-mutation-candidate/v1" || report?.phase !== 2 ||
      report?.target !== "phase2" || report?.status !== "PASS" || report?.evidence_eligible !== false)
    errors.push("candidate fixed identity mismatch");
  if (!SHA_40.test(report?.commit_sha ?? "") || !SHA_40.test(report?.tree_sha ?? "") ||
      !HASH_64.test(report?.batch_sha256 ?? "") || report?.source_root !== `commit://${report?.commit_sha}/` ||
      report?.artifact_root !== `bundle://${report?.batch_sha256}/`)
    errors.push("candidate content address mismatch");
  if (!Array.isArray(report?.results) || report.results.length !== 64 || report?.completed !== 64 || report?.required !== 64)
    errors.push("candidate requirement set is incomplete");
  if (!Array.isArray(report?.errors) || report.errors.length !== 0) errors.push("candidate PASS contains errors");
  const receipt = report?.execution_receipt;
  if (!exactKeys(receipt, ["schema_version", "child_exit_status", "runner_sha256", "configuration_sha256",
    "source_snapshot_sha256", "dependency_snapshot_sha256", "dependency_manifest_sha256",
    "authority_closure_sha256", "mutant_completeness_sha256", "toolchain", "isolation_mechanism"]) ||
      receipt?.schema_version !== "phase2-mutation-execution-receipt/v1" || receipt?.child_exit_status !== 0 ||
      receipt?.configuration_sha256 !== report?.configuration_hash || receipt?.isolation_mechanism !== "bubblewrap")
    errors.push("candidate execution receipt mismatch");
  if (!HASH_64.test(receipt?.mutant_completeness_sha256 ?? "")) errors.push("candidate mutant completeness receipt mismatch");
  return errors;
};

export const validatePhase2MutationWorkflow = (source) => {
  if (typeof source !== "string") return ["workflow source is required"];
  try {
    return workflowAstSha256(source) === WORKFLOW_AST_SHA256 ? [] : ["workflow AST differs from the canonical workflow contract"];
  } catch (error) {
    return [`workflow restricted YAML is invalid: ${error instanceof Error ? error.message : String(error)}`];
  }
};

export const validateExternalArtifactAttestation = (receipt, expected = {}) => {
  const errors = validateSchemaDocument(receipt, localSchema("phase2-mutation-attestation-receipt/v1"), localSchemasById);
  if (!exactKeys(receipt, attestationFields)) errors.push("attestation receipt schema mismatch");
  if (receipt.schema_version !== ATTESTATION_SCHEMA) errors.push("attestation schema version mismatch");
  if (receipt.repository !== REPOSITORY) errors.push("attestation repository mismatch");
  if (!receipt.workflow_ref?.startsWith(`${REPOSITORY}/${WORKFLOW_PATH}@refs/`)) errors.push("attestation workflow ref mismatch");
  if (!Number.isSafeInteger(receipt.run_id) || receipt.run_id < 1) errors.push("attestation run id mismatch");
  if (!Number.isSafeInteger(receipt.run_attempt) || receipt.run_attempt < 1) errors.push("attestation run attempt mismatch");
  if (expected.runAttempt !== undefined && receipt.run_attempt !== expected.runAttempt)
    errors.push("attestation run attempt mismatch");
  if (!SHA_40.test(receipt.head_sha ?? "") || (expected.headSha && receipt.head_sha !== expected.headSha)) errors.push("attestation head SHA mismatch");
  if (receipt.conclusion !== "success") errors.push("attestation run did not succeed");
  if (receipt.artifact_name !== `phase2-mutation-${receipt.head_sha}` ||
      (expected.artifactName && receipt.artifact_name !== expected.artifactName)) errors.push("attestation artifact name mismatch");
  if (!Number.isSafeInteger(receipt.artifact_id) || receipt.artifact_id < 1 ||
      (expected.artifactId && receipt.artifact_id !== expected.artifactId)) errors.push("attestation artifact id mismatch");
  if (!Number.isSafeInteger(receipt.artifact_size) || receipt.artifact_size < 1 ||
      (expected.artifactSize !== undefined && receipt.artifact_size !== expected.artifactSize))
    errors.push("attestation artifact size mismatch");
  if (!/^sha256:[a-f0-9]{64}$/u.test(receipt.artifact_digest ?? "") ||
      (expected.artifactDigest && receipt.artifact_digest !== expected.artifactDigest)) errors.push("attestation artifact digest mismatch");
  if (expected.workflowRef !== undefined && receipt.workflow_ref !== expected.workflowRef)
    errors.push("attestation workflow ref mismatch");
  if (receipt.verification_method === "github_sigstore") {
    if (receipt.issuer !== "https://token.actions.githubusercontent.com") errors.push("Sigstore issuer mismatch");
  } else if (receipt.verification_method === "github_actions_api") {
    if (receipt.issuer !== "https://api.github.com") errors.push("GitHub API issuer mismatch");
  } else errors.push("attestation verification method mismatch");
  return errors;
};

export const validateStructuredSigstoreClaims = (claims, expected = {}) => {
  const errors = [];
  if (!exactKeys(claims, ["issuer", "repository", "workflow_ref", "head_sha", "run_id", "run_attempt", "subject_digest"]))
    return ["Sigstore claims schema mismatch"];
  if (claims.issuer !== "https://token.actions.githubusercontent.com") errors.push("Sigstore issuer mismatch");
  if (claims.repository !== REPOSITORY) errors.push("Sigstore repository mismatch");
  for (const [field, expectedValue] of [
    ["workflow_ref", expected.workflowRef], ["head_sha", expected.headSha],
    ["run_id", expected.runId], ["run_attempt", expected.runAttempt],
    ["subject_digest", expected.subjectDigest],
  ]) if (expectedValue !== undefined && claims[field] !== expectedValue) errors.push(`Sigstore ${field} mismatch`);
  return errors;
};

export const parseGitHubAttestationVerification = (verified) => {
  if (!Array.isArray(verified) || verified.length !== 1)
    throw new Error("GitHub attestation must contain exactly one verificationResult");
  const result = verified[0]?.verificationResult;
  const subject = result?.statement?.subject;
  const certificate = result?.signature?.certificate;
  if (!Array.isArray(subject) || subject.length !== 1 ||
      !/^([a-f0-9]{64})$/u.test(subject[0]?.digest?.sha256 ?? "") ||
      certificate === null || typeof certificate !== "object")
    throw new Error("GitHub attestation verificationResult is incomplete");
  return {
    issuer: certificate.issuer,
    repository: certificate.sourceRepository,
    source_ref: certificate.sourceRepositoryRef,
    workflow_ref: certificate.workflowRef,
    subject_name: subject[0].name,
    subject_digest: `sha256:${subject[0].digest.sha256}`,
  };
};

export const verifyGitHubSigstoreAttestation = ({ artifactPath, expectedHeadSha, token } = {}) => {
  const fail = (message) => ({ ok: false, verdict: "UNVERIFIED", errors: [message] });
  if (typeof artifactPath !== "string" || !artifactPath.startsWith("/") || !SHA_40.test(expectedHeadSha ?? "") ||
      typeof token !== "string" || token.length < 20) return fail("Sigstore verification identity is invalid");
  try {
    const metadata = lstatSync(artifactPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return fail("Sigstore subject must be a regular file");
    const gh = validateProtectedExecutable("/usr/bin/gh");
    const home = mkdtempSync(join(tmpdir(), "phase2-sigstore-gh-"));
    try {
      const verification = spawnSync(gh, ["attestation", "verify", artifactPath, "--repo", REPOSITORY,
        "--signer-workflow", FORMAL_SIGNER_WORKFLOW, "--source-ref", `refs/heads/${process.env.PHASE2_FORMAL_SOURCE_BRANCH ?? "release"}`,
        "--source-digest", expectedHeadSha,
        "--format", "json"], {
        encoding: "utf8", env: { HOME: home, XDG_CONFIG_HOME: home, GH_TOKEN: token, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        shell: false, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (verification.error || verification.status !== 0) return fail("GitHub Sigstore verification failed");
      const verified = JSON.parse(verification.stdout);
      const digest = sha256(readFileSync(artifactPath));
      const claims = parseGitHubAttestationVerification(verified);
      const claimErrors = [];
      if (claims.issuer !== "https://token.actions.githubusercontent.com") claimErrors.push("Sigstore issuer mismatch");
      if (claims.repository !== REPOSITORY) claimErrors.push("Sigstore repository mismatch");
      if (claims.workflow_ref !== FORMAL_SIGNER_WORKFLOW) claimErrors.push("Sigstore signer workflow mismatch");
      if (claims.subject_digest !== `sha256:${digest}`) claimErrors.push("Sigstore subject digest mismatch");
      if (claimErrors.length > 0) return fail(`GitHub Sigstore structured claims mismatch: ${claimErrors.join("; ")}`);
      return { ok: true, verdict: "VERIFIED", errors: [], verification_method: "github_sigstore" };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  } catch (error) {
    return fail(`GitHub Sigstore verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const downloadGitHubArtifact = (location) => new Promise((resolveDownload, rejectDownload) => {
  const url = new URL(location);
  const trusted = url.protocol === "https:" && (
    url.hostname.endsWith(".actions.githubusercontent.com") ||
    url.hostname.endsWith(".blob.core.windows.net")
  );
  if (!trusted) return rejectDownload(new Error("GitHub artifact redirect authority is invalid"));
  const call = request(url, { method: "GET", headers: { "User-Agent": "phase2-mutation-verifier" } }, (response) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) response.destroy(new Error("GitHub artifact exceeds the bounded verifier size"));
      else chunks.push(Buffer.from(chunk));
    });
    response.on("end", () => {
      if (response.statusCode < 200 || response.statusCode >= 300)
        return rejectDownload(new Error(`GitHub artifact download failed with ${String(response.statusCode)}`));
      resolveDownload({ body: Buffer.concat(chunks), headers: response.headers });
    });
  });
  call.setTimeout(HTTP_TIMEOUT_MS, () => call.destroy(new Error("GitHub artifact download timed out")));
  call.once("error", rejectDownload); call.end();
});

const githubApi = ({ token, path, accept = "application/vnd.github+json", download = false }) => new Promise((resolveRequest, rejectRequest) => {
  if (typeof token !== "string" || token.length < 20) return rejectRequest(new Error("private GitHub token is required"));
  const call = request({
    protocol: "https:", hostname: API_HOST, port: 443, method: "GET", path,
    headers: { Accept: accept, Authorization: `Bearer ${token}`, "User-Agent": "phase2-mutation-verifier", "X-GitHub-Api-Version": "2022-11-28" },
  }, (response) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) response.destroy(new Error("GitHub API response exceeds the bounded verifier size"));
      else chunks.push(Buffer.from(chunk));
    });
    response.on("end", async () => {
      const body = Buffer.concat(chunks);
      if (download && [301, 302, 303, 307, 308].includes(response.statusCode) && typeof response.headers.location === "string") {
        try { return resolveRequest(await downloadGitHubArtifact(response.headers.location)); }
        catch (error) { return rejectRequest(error); }
      }
      if (response.statusCode < 200 || response.statusCode >= 300)
        return rejectRequest(new Error(`GitHub API request failed with ${String(response.statusCode)}`));
      resolveRequest({ body, headers: response.headers });
    });
  });
  call.setTimeout(HTTP_TIMEOUT_MS, () => call.destroy(new Error("GitHub API request timed out")));
  call.once("error", rejectRequest);
  call.end();
});

export async function verifyExternalPhase2MutationAttestation({ token, runId, artifactId, expectedHeadSha,
  expectedWorkflowRef, expectedRunAttempt, expectedArtifactSize } = {}) {
  const fail = (message) => ({ ok: false, verdict: "UNVERIFIED", errors: [message] });
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(artifactId) || !SHA_40.test(expectedHeadSha ?? "") ||
      typeof expectedWorkflowRef !== "string" || !expectedWorkflowRef.startsWith(`${REPOSITORY}/${WORKFLOW_PATH}@refs/`) ||
      !Number.isSafeInteger(expectedRunAttempt) || !Number.isSafeInteger(expectedArtifactSize))
    return fail("external verification identity is invalid");
  try {
    const runResponse = await githubApi({ token, path: `/repos/${REPOSITORY}/actions/runs/${runId}` });
    const run = JSON.parse(runResponse.body.toString("utf8"));
    const artifactResponse = await githubApi({ token, path: `/repos/${REPOSITORY}/actions/artifacts/${artifactId}` });
    const artifact = JSON.parse(artifactResponse.body.toString("utf8"));
    const archiveResponse = await githubApi({ token, path: `/repos/${REPOSITORY}/actions/artifacts/${artifactId}/zip`, accept: "application/octet-stream", download: true });
    const downloadedDigest = `sha256:${sha256(archiveResponse.body)}`;
    const receipt = {
      schema_version: ATTESTATION_SCHEMA,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/${WORKFLOW_PATH}@${run.head_branch ? `refs/heads/${run.head_branch}` : "refs/unknown"}`,
      run_id: run.id,
      run_attempt: run.run_attempt,
      head_sha: run.head_sha,
      conclusion: run.conclusion,
      artifact_name: artifact.name,
      artifact_id: artifact.id,
      artifact_size: artifact.size_in_bytes,
      artifact_digest: downloadedDigest,
      verification_method: "github_actions_api",
      issuer: "https://api.github.com",
    };
    const errors = validateExternalArtifactAttestation(receipt, {
      headSha: expectedHeadSha, artifactId,
      workflowRef: expectedWorkflowRef, runAttempt: expectedRunAttempt,
      artifactName: `phase2-mutation-${expectedHeadSha}`,
      artifactSize: expectedArtifactSize,
      artifactDigest: artifact.digest,
    });
    if (run.path !== WORKFLOW_PATH || artifact.workflow_run?.id !== runId || artifact.expired === true)
      errors.push("GitHub run/artifact metadata binding mismatch");
    if (!/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? "") || artifact.digest !== downloadedDigest)
      errors.push("GitHub artifact metadata digest does not bind the downloaded bytes");
    if (artifact.size_in_bytes !== archiveResponse.body.length)
      errors.push("GitHub artifact metadata size does not bind the downloaded bytes");
    return { ok: errors.length === 0, verdict: errors.length === 0 ? "VERIFIED" : "UNVERIFIED", errors, receipt,
      archive: errors.length === 0 ? archiveResponse.body : null };
  } catch (error) {
    return fail(`GitHub external verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function verifyExternalPhase2MutationEvidence({
  token,
  runId,
  artifactId,
  artifactPath,
  expectedHeadSha,
  expectedWorkflowRef,
  expectedRunAttempt,
  expectedArtifactSize,
  repositoryRoot,
} = {}) {
  const sigstore = verifyGitHubSigstoreAttestation({ artifactPath, expectedHeadSha, token });
  const api = await verifyExternalPhase2MutationAttestation({ token, runId, artifactId, expectedHeadSha,
    expectedWorkflowRef, expectedRunAttempt, expectedArtifactSize });
  let localDigest = null;
  try {
    const metadata = typeof artifactPath === "string" && artifactPath.startsWith("/") ? lstatSync(artifactPath) : null;
    if (metadata?.isFile() && !metadata.isSymbolicLink()) localDigest = `sha256:${sha256(readFileSync(artifactPath))}`;
  } catch { /* A missing or unsafe local subject remains UNVERIFIED. */ }
  const downloaded = api.ok === true && api.archive !== null
    ? verifyDownloadedPhase2MutationArtifact({ repositoryRoot, archive: api.archive, expectedHeadSha })
    : { ok: false, errors: ["downloaded candidate publication was not available for content verification"] };
  const sigstoreBindsDownload = sigstore.ok === true && localDigest !== null &&
    localDigest === api.receipt?.artifact_digest;
  const apiFallbackBindsDownload = api.ok === true;
  if ((sigstoreBindsDownload || apiFallbackBindsDownload) && downloaded.ok === true)
    return { ok: true, verdict: "EXTERNAL_CANDIDATE_VERIFIED", formal_evidence_eligible: false,
      external_authority_required: true, errors: [], sigstore, receipt: api.receipt, candidate: downloaded };
  return {
    ok: false,
    verdict: "UNVERIFIED",
    errors: [...sigstore.errors, ...api.errors, ...downloaded.errors,
      ...(localDigest === api.receipt?.artifact_digest ? [] : ["local artifact and GitHub download digest mismatch"]),
      "Sigstore, GitHub metadata, and exact downloaded publication bytes must all verify"],
  };
}

export const verifyPhase2MutationPublicationFiles = ({ repositoryRoot, files, publicationReceiptPath, headCommit, headTree }) => {
  const errors = [];
  const root = resolve(repositoryRoot);
  const receiptBytes = files.get("publication-receipt.json");
  const reportBytes = files.get("candidate-report.json");
  if (!receiptBytes || !reportBytes) return { ok: false, errors: ["publication must contain candidate-report.json and publication-receipt.json"] };
  let receipt; let report;
  try { receipt = JSON.parse(receiptBytes.toString("utf8")); } catch { return { ok: false, errors: ["publication receipt is invalid JSON"] }; }
  try { report = JSON.parse(reportBytes.toString("utf8")); } catch { return { ok: false, errors: ["candidate report is invalid JSON"] }; }
  errors.push(...validateSchemaDocument(receipt, localSchema("phase2-mutation-publication-receipt/v2"), localSchemasById));
  errors.push(...validateSchemaDocument(report, localSchema("phase2-mutation-candidate/v1"), localSchemasById));
  if (!exactPublicationReceipt(receipt)) errors.push("publication receipt schema mismatch");
  if (receipt.publication_path !== publicationReceiptPath) errors.push("publication path mismatch");
  if (receipt.commit_sha !== headCommit || receipt.tree_sha !== headTree) errors.push("publication exact-SHA identity mismatch");
  if (sha256(reportBytes) !== receipt.candidate_report_sha256) errors.push("candidate report hash mismatch");
  if (sha256(canonicalJson(report.execution_receipt)) !== receipt.execution_receipt_sha256) errors.push("execution receipt hash mismatch");
  const payloadFiles = [...files.entries()].filter(([path]) => path !== "publication-receipt.json");
  if (fileSetSha256(payloadFiles) !== receipt.publication_set_sha256) errors.push("publication set digest mismatch");
  if (report.batch_sha256 !== receipt.batch_sha256 || report.commit_sha !== receipt.commit_sha || report.tree_sha !== receipt.tree_sha)
    errors.push("candidate and publication identity mismatch");
  for (const result of report.results ?? []) for (const chunk of result.chunks ?? []) {
    for (const [kind, field, label] of [["raw", "raw_report_sha256", "raw report"], ["config", "config_sha256", "Stryker config"]]) {
      const path = expectedArtifactPath(result, chunk, kind);
      const bytes = files.get(path);
      if (!bytes || sha256(bytes) !== chunk?.[field]) errors.push(`${label} hash mismatch for ${String(chunk?.chunk_id)}`);
      if (chunk?.[kind === "raw" ? "raw_report_uri" : "config_uri"] !== `bundle://${receipt.batch_sha256}/${path}`)
        errors.push(`${label} bundle URI mismatch for ${String(chunk?.chunk_id)}`);
    }
  }
  for (const result of report.results ?? []) {
    const rebuilt = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
    for (const chunk of result.chunks ?? []) {
      try {
        const raw = JSON.parse(files.get(expectedArtifactPath(result, chunk, "raw"))?.toString("utf8") ?? "null");
        const counts = rebuildRawMutationCounts(raw);
        for (const key of Object.keys(rebuilt)) rebuilt[key] += counts[key];
        const rawFiles = Object.values(raw.files);
        if (rawFiles.length > 1 || (rawFiles.length === 1 && rawFiles[0]?.source !==
          runTrustedGit(root, ["cat-file", "blob", `${receipt.commit_sha}:${chunk.source_file}`], { encoding: "utf8" })))
          errors.push(`raw source bytes mismatch for ${String(chunk.chunk_id)}`);
      } catch (error) {
        errors.push(`raw mutation reconstruction failed for ${String(chunk?.chunk_id)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (canonicalJson(rebuilt) !== canonicalJson(result.counts) || scoreFromCounts(rebuilt) !== result.score)
      errors.push(`raw mutation metrics mismatch for ${String(result.requirement_id)}`);
  }
  errors.push(...validateCandidateBuiltins(report));
  try {
    const authority = loadCommittedMutationAuthority(root, headCommit);
    errors.push(...validateIndependentCandidateSemantics({ report, files, authority }));
  } catch (error) {
    errors.push(`committed mutation authority validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workflow = runTrustedGit(root, ["cat-file", "blob", `${receipt.commit_sha}:${WORKFLOW_PATH}`], { encoding: "utf8" });
  errors.push(...validatePhase2MutationWorkflow(workflow));
  return { ok: errors.length === 0, verdict: "CANDIDATE_ONLY", errors, publicationReceiptPath, receipt, reportSha256: receipt.candidate_report_sha256 };
};

export const verifyDownloadedPhase2MutationArtifact = ({ repositoryRoot, archive, expectedHeadSha }) => {
  try {
    if (!SHA_40.test(expectedHeadSha ?? "")) throw new Error("downloaded artifact requires an exact head SHA");
    const entries = extractPhase2ArtifactZip(archive);
    const receipts = [...entries.keys()].filter((path) => /^mutation-publications\/[a-f0-9]{64}\/publication-receipt\.json$/u.test(path));
    if (receipts.length !== 1) throw new Error("downloaded artifact must contain exactly one candidate publication");
    const prefix = receipts[0].slice(0, -"publication-receipt.json".length);
    const files = new Map([...entries].filter(([path]) => path.startsWith(prefix)).map(([path, bytes]) => [path.slice(prefix.length), bytes]));
    const batch = prefix.split("/")[1];
    const headTree = runTrustedGit(resolve(repositoryRoot), ["rev-parse", `${expectedHeadSha}^{tree}`]).trim();
    return verifyPhase2MutationPublicationFiles({ repositoryRoot, files,
      publicationReceiptPath: `reports/phase2/mutation-publications/${batch}`, headCommit: expectedHeadSha, headTree });
  } catch (error) {
    return { ok: false, verdict: "UNVERIFIED", errors: [`downloaded artifact verification failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
};

export async function verifyPublishedPhase2MutationBundle({ repositoryRoot, publicationReceiptPath } = {}) {
  if (typeof repositoryRoot !== "string") return { ok: false, errors: ["repositoryRoot is required"] };
  const root = resolve(repositoryRoot);
  if (typeof publicationReceiptPath !== "string" ||
      !/^reports\/phase2\/mutation-publications\/[a-f0-9]{64}$/u.test(publicationReceiptPath))
    return { ok: false, errors: ["publicationReceiptPath is required"], publicationReceiptPath: publicationReceiptPath ?? null };
  let headCommit; let headTree; let publication;
  try {
    headCommit = runTrustedGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    headTree = runTrustedGit(root, ["rev-parse", "HEAD^{tree}"]).trim();
    publication = securePublish({ operation: "read_tree", path: publicationReceiptPath, authority: { repositoryRoot: root, treeSha: headTree } });
  } catch (error) {
    return { ok: false, errors: [`publication read failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const files = new Map(publication.files.map((file) => [file.path, Buffer.from(file.contentBase64, "base64")]));
  return verifyPhase2MutationPublicationFiles({ repositoryRoot: root, files, publicationReceiptPath, headCommit, headTree });
}
