#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSchemaDocument } from "./json-schema.mjs";

import {
  phase2MutationRequirements,
} from "../../mutation/phase2-modules.mjs";
import { mutationModules as phase1MutationModules } from "../../mutation/modules.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const schemaDirectory = resolve(scriptDirectory, "../../verification/schemas");
const productionSchemas = [
  "phase2-mutation-draft.schema.json",
  "phase2-mutation-candidate.schema.json",
  "phase2-mutation-execution-receipt.schema.json",
].map((name) => JSON.parse(readFileSync(join(schemaDirectory, name), "utf8")));
const productionSchemasById = new Map(productionSchemas.map((schema) => [schema.$id, schema]));
const productionSchema = (suffix) => productionSchemas.find((schema) => schema.$id.endsWith(suffix));
export const DEFAULT_PHASE2_MUTATION_ROOT = resolve(scriptDirectory, "../..");
export const PHASE2_MUTATION_MANIFEST = "verification/gates/phase2-gate.json";
export const PHASE2_MUTATION_REGISTRY = "mutation/phase2-modules.mjs";
// Keep each exact-source chunk below the runner's hard execution deadline.
// This changes only scheduling granularity; every source line remains covered.
// Keep each diagnostic mutation process bounded when the requirement owns
// integration and security suites with expensive crash/restart fixtures.
export const PHASE2_MUTATION_CHUNK_LINES = 20;
export const PHASE2_MUTATION_DRAFT_SCHEMA_VERSION =
  "phase2-mutation-draft/v1";
export const PHASE2_MUTATION_FINAL_SCHEMA_VERSION =
  "phase2-mutation-candidate/v1";
export const PHASE2_MUTATION_CANDIDATE_SCHEMA_VERSION =
  PHASE2_MUTATION_FINAL_SCHEMA_VERSION;
export const PHASE2_MUTATION_SCHEMA_VERSION =
  PHASE2_MUTATION_DRAFT_SCHEMA_VERSION;
const STATUSES = new Set(["not_started", "ready"]);
const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const exactArray = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  canonicalJson(left) === canonicalJson(right);

const safeRelativePath = (value) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0") ||
    /[*?[\]{}]/u.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== "..",
  );
};

const duplicateValues = (values) => {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
};

const DRAFT_FIELDS = new Set([
  "schema_version", "phase", "target", "status", "evidence_eligible",
  "commit_sha", "tree_sha", "registry_sha256", "manifest_sha256",
  "phase1_mutation_registry_sha256", "configuration_hash", "thresholds",
  "completed", "required", "aggregate", "aggregate_score", "results",
  "errors", "readiness", "blockers",
]);
const CANDIDATE_FIELDS = new Set([
  ...DRAFT_FIELDS,
  "batch_sha256", "source_root", "artifact_root", "execution_receipt",
]);
const RESULT_FIELDS = new Set([
  "requirement_id", "mutation_class", "threshold", "status", "evidence_eligible",
  "synthetic_fixture", "execution_provenance", "isolation_mechanism", "candidate_run_id",
  "snapshot_sha256", "batch_sha256", "commit_sha", "tree_sha", "registry_sha256",
  "manifest_sha256", "phase1_mutation_registry_sha256", "configuration_hash", "run_id",
  "vitest_config_path", "sources", "integration_sources", "integration_source_modules",
  "tests", "counts", "score", "per_file", "expected_chunk_count", "chunks",
  "mutant_identity_sha256",
]);
const CANDIDATE_CHUNK_FIELDS = new Set([
  "chunk_id", "source_file", "start_line", "end_line", "mutate_pattern", "complete",
  "raw_report_uri", "config_uri", "raw_report_sha256",
  "config_sha256", "raw_source_path_sha256", "normalized_source_file", "mutant_identity_sha256",
]);
const DRAFT_CHUNK_FIELDS = new Set([...CANDIDATE_CHUNK_FIELDS, "raw_report_path", "config_path"]);
const EXECUTION_RECEIPT_FIELDS = new Set([
  "schema_version", "child_exit_status", "runner_sha256", "configuration_sha256",
  "source_snapshot_sha256", "dependency_snapshot_sha256", "dependency_manifest_sha256",
  "authority_closure_sha256", "mutant_completeness_sha256", "toolchain", "isolation_mechanism",
]);
const TOOLCHAIN_FIELDS = new Set([
  "node_version", "node_sha256", "npm_version", "npm_sha256", "registry",
  "bubblewrap_version", "bubblewrap_sha256", "prlimit_sha256",
]);
const exactFieldErrors = (value, allowed, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [`${label} must be an object`];
  return Object.keys(value)
    .filter((field) => !allowed.has(field))
    .map((field) => `${label} unknown field: ${field}`);
};

export const validatePhase2MutationDraftSchema = (report) => {
  const errors = validateSchemaDocument(report, productionSchema("phase2-mutation-draft/v1"), productionSchemasById);
  errors.push(...exactFieldErrors(report, DRAFT_FIELDS, "draft"));
  for (const required of ["schema_version", "phase", "target", "status", "evidence_eligible", "commit_sha", "tree_sha", "results", "errors"])
    if (!Object.hasOwn(report ?? {}, required)) errors.push(`draft required field missing: ${required}`);
  if (report?.schema_version !== PHASE2_MUTATION_DRAFT_SCHEMA_VERSION)
    errors.push("draft schema_version mismatch");
  if (report?.evidence_eligible !== false)
    errors.push("draft can never be Evidence-eligible");
  if (report?.phase !== 2) errors.push("draft phase must be 2");
  if (typeof report?.target !== "string" || report.target.length === 0)
    errors.push("draft target must be a non-empty string");
  if (!['PASS', 'FAIL'].includes(report?.status))
    errors.push("draft status is invalid");
  if (!SHA_40.test(report?.commit_sha ?? ""))
    errors.push("draft commit SHA is invalid");
  if (!SHA_40.test(report?.tree_sha ?? ""))
    errors.push("draft tree SHA is invalid");
  if (!Array.isArray(report?.results)) errors.push("draft results must be an array");
  if (!Array.isArray(report?.errors) || !report.errors.every((value) => typeof value === 'string'))
    errors.push("draft errors must be an array of strings");
  for (const result of Array.isArray(report?.results) ? report.results : []) {
    errors.push(...exactFieldErrors(result, RESULT_FIELDS, `${String(result?.requirement_id)} result`));
    for (const chunk of Array.isArray(result?.chunks) ? result.chunks : [])
      errors.push(...exactFieldErrors(chunk, DRAFT_CHUNK_FIELDS, `${String(chunk?.chunk_id)} chunk`));
  }
  return errors;
};

export const validatePhase2MutationCandidateSchema = (report) => {
  const errors = validateSchemaDocument(report, productionSchema("phase2-mutation-candidate/v1"), productionSchemasById);
  errors.push(...exactFieldErrors(report, CANDIDATE_FIELDS, "candidate"));
  for (const required of ["schema_version", "phase", "target", "status", "evidence_eligible", "commit_sha", "tree_sha", "batch_sha256", "source_root", "artifact_root", "execution_receipt", "results", "errors"])
    if (!Object.hasOwn(report ?? {}, required)) errors.push(`candidate required field missing: ${required}`);
  if (report?.schema_version !== PHASE2_MUTATION_CANDIDATE_SCHEMA_VERSION)
    errors.push("candidate schema_version mismatch");
  if (report?.evidence_eligible !== false)
    errors.push("candidate can never be Evidence-eligible");
  if (report?.phase !== 2) errors.push("candidate phase must be 2");
  if (report?.target !== "phase2") errors.push("candidate target must be phase2");
  if (!Array.isArray(report?.results)) errors.push("candidate results must be an array");
  if (!Array.isArray(report?.errors) || !report.errors.every((value) => typeof value === 'string'))
    errors.push("candidate errors must be an array of strings");
  if (!/^commit:\/\/[a-f0-9]{40}\/$/u.test(report?.source_root ?? ""))
    errors.push("candidate source_root mismatch");
  if (!/^bundle:\/\/[a-f0-9]{64}\/$/u.test(report?.artifact_root ?? ""))
    errors.push("candidate artifact_root mismatch");
  for (const result of Array.isArray(report?.results) ? report.results : []) {
    errors.push(...exactFieldErrors(result, RESULT_FIELDS, `${String(result?.requirement_id)} result`));
    if (result?.evidence_eligible !== false || result?.synthetic_fixture !== false ||
        result?.execution_provenance !== "isolated_candidate" || result?.isolation_mechanism !== "bubblewrap" ||
        !UUID_V4.test(result?.candidate_run_id ?? "") || result?.snapshot_sha256 !== report?.execution_receipt?.source_snapshot_sha256 ||
        result?.batch_sha256 !== report?.batch_sha256 || result?.commit_sha !== report?.commit_sha || result?.tree_sha !== report?.tree_sha)
      errors.push(`${String(result?.requirement_id)} candidate execution identity mismatch`);
    for (const chunk of Array.isArray(result?.chunks) ? result.chunks : []) {
      errors.push(...exactFieldErrors(chunk, CANDIDATE_CHUNK_FIELDS, `${String(chunk?.chunk_id)} chunk`));
      if (chunk?.raw_report_uri !== `bundle://${report?.batch_sha256}/raw/${result?.requirement_id}/${chunk?.chunk_id}/mutation.json` ||
          chunk?.config_uri !== `bundle://${report?.batch_sha256}/raw/${result?.requirement_id}/${chunk?.chunk_id}/stryker.config.json`)
        errors.push(`${String(chunk?.chunk_id)} candidate bundle URI mismatch`);
    }
  }
  const receipt = report?.execution_receipt;
  errors.push(...exactFieldErrors(receipt, EXECUTION_RECEIPT_FIELDS, "execution receipt"));
  errors.push(...exactFieldErrors(receipt?.toolchain, TOOLCHAIN_FIELDS, "execution toolchain"));
  if (receipt?.toolchain?.node_version !== "v20.19.0" || !HASH_64.test(receipt?.toolchain?.node_sha256 ?? "") ||
      receipt?.toolchain?.npm_version !== "10.8.2" || !HASH_64.test(receipt?.toolchain?.npm_sha256 ?? "") ||
      receipt?.toolchain?.registry !== "https://registry.npmjs.org/" ||
      receipt?.toolchain?.bubblewrap_version !== "bubblewrap 0.6.1" ||
      !HASH_64.test(receipt?.toolchain?.bubblewrap_sha256 ?? "") || !HASH_64.test(receipt?.toolchain?.prlimit_sha256 ?? ""))
    errors.push("execution toolchain authority mismatch");
  return errors;
};

const readManifest = (repositoryRoot) =>
  JSON.parse(
    readFileSync(join(repositoryRoot, PHASE2_MUTATION_MANIFEST), "utf8"),
  );

const phase1MutationCoverage = () => {
  const coverage = new Map();
  for (const [moduleName, definition] of Object.entries(
    phase1MutationModules,
  )) {
    for (const source of definition.mutate ?? []) {
      const modules = coverage.get(source) ?? [];
      modules.push(moduleName);
      coverage.set(source, modules.sort());
    }
  }
  return coverage;
};

export function loadPhase2MutationAuthority({
  repositoryRoot = DEFAULT_PHASE2_MUTATION_ROOT,
  manifest = readManifest(resolve(repositoryRoot)),
  registry = phase2MutationRequirements,
} = {}) {
  const errors = [];
  const thresholds = manifest?.mutation_thresholds ?? {};
  if (thresholds.critical !== 90) {
    errors.push(
      `Phase 2 critical threshold must be exactly 90; received ${String(thresholds.critical)}`,
    );
  }
  if (thresholds.core !== 85) {
    errors.push(
      `Phase 2 core threshold must be exactly 85; received ${String(thresholds.core)}`,
    );
  }

  const manifestEntries = Array.isArray(manifest?.requirements)
    ? manifest.requirements
    : [];
  const registryEntries = Array.isArray(registry) ? registry : [];
  if (manifestEntries.length !== 64) {
    errors.push(
      `Phase 2 manifest must contain exactly 64 mutation requirements; received ${manifestEntries.length}`,
    );
  }
  if (registryEntries.length !== 64) {
    errors.push(
      `Phase 2 mutation registry must contain exactly 64 requirements; received ${registryEntries.length}`,
    );
  }

  const manifestIds = manifestEntries.map((entry) => entry?.id);
  const registryIds = registryEntries.map((entry) => entry?.id);
  for (const id of duplicateValues(manifestIds)) {
    errors.push(`duplicate manifest requirement: ${String(id)}`);
  }
  for (const id of duplicateValues(registryIds)) {
    errors.push(
      `duplicate requirement in Phase 2 mutation registry: ${String(id)}`,
    );
  }

  const manifestById = new Map(
    manifestEntries
      .filter((entry) => entry && typeof entry.id === "string")
      .map((entry) => [entry.id, entry]),
  );
  const registryById = new Map(
    registryEntries
      .filter((entry) => entry && typeof entry.id === "string")
      .map((entry) => [entry.id, entry]),
  );
  for (const id of manifestById.keys()) {
    if (!registryById.has(id))
      errors.push(`missing requirement in mutation registry: ${id}`);
  }
  for (const id of registryById.keys()) {
    if (!manifestById.has(id))
      errors.push(`unknown requirement in mutation registry: ${id}`);
  }

  const requirements = [];
  const integrationCoverage = phase1MutationCoverage();
  for (const manifestEntry of manifestEntries) {
    if (!manifestEntry || typeof manifestEntry.id !== "string") continue;
    const entry = registryById.get(manifestEntry.id);
    if (!entry) continue;
    const entryKeys = Object.keys(entry).sort();
    if (!exactArray(entryKeys, ["id", "integrationSources", "sources", "status"])) {
      errors.push(
        `requirement ${manifestEntry.id} mutation registry fields must be exactly id, integrationSources, sources, status`,
      );
    }
    const mutationClass = manifestEntry.mutation_class;
    if (!Object.hasOwn(thresholds, mutationClass)) {
      errors.push(
        `requirement ${manifestEntry.id} has unknown mutation class ${String(mutationClass)}`,
      );
    }
    if (!STATUSES.has(entry.status)) {
      errors.push(
        `requirement ${manifestEntry.id} has invalid mutation status ${String(entry.status)}`,
      );
    }
    if (
      !Array.isArray(entry.sources) ||
      !entry.sources.every(safeRelativePath)
    ) {
      errors.push(
        `requirement ${manifestEntry.id} sources must be explicit safe paths`,
      );
    }
    if (
      !Array.isArray(entry.integrationSources) ||
      !entry.integrationSources.every(safeRelativePath)
    ) {
      errors.push(
        `requirement ${manifestEntry.id} integration sources must be explicit safe paths`,
      );
    }
    if (!Array.isArray(manifestEntry.test_suites) || !manifestEntry.test_suites.every(safeRelativePath)) {
      errors.push(
        `requirement ${manifestEntry.id} tests must be explicit safe paths`,
      );
    }
    // When the manifest declares owned_sources, registry sources must match exactly.
    // When the manifest does not declare owned_sources (non-Batch1 requirements
    // in candidate-only state), registry sources are accepted as candidate sources.
    const manifestOwnedSources = Object.hasOwn(manifestEntry, "owned_sources")
      ? manifestEntry.owned_sources
      : null;
    if (manifestOwnedSources !== null && !exactArray(entry.sources, manifestOwnedSources)) {
      errors.push(
        `requirement ${manifestEntry.id} owned mutation sources must exactly match gate owned_sources`,
      );
    }
    const manifestIntegrationSources = Object.hasOwn(manifestEntry, "integration_sources")
      ? manifestEntry.integration_sources
      : null;
    if (manifestIntegrationSources !== null && !exactArray(entry.integrationSources, manifestIntegrationSources)) {
      errors.push(
        `requirement ${manifestEntry.id} integration sources must exactly match gate integration_sources`,
      );
    }
    if (duplicateValues(entry.sources ?? []).length > 0) {
      errors.push(
        `requirement ${manifestEntry.id} contains duplicate source files`,
      );
    }
    if (duplicateValues(entry.integrationSources ?? []).length > 0) {
      errors.push(
        `requirement ${manifestEntry.id} contains duplicate integration sources`,
      );
    }
    const overlap = (entry.integrationSources ?? []).filter((source) =>
      (entry.sources ?? []).includes(source),
    );
    if (overlap.length > 0) {
      errors.push(
        `requirement ${manifestEntry.id} sources and integration sources overlap: ${overlap.join(", ")}`,
      );
    }
    const integrationSourceModules = {};
    for (const source of entry.integrationSources ?? []) {
      const modules = integrationCoverage.get(source) ?? [];
      if (modules.length === 0) {
        errors.push(
          `requirement ${manifestEntry.id} integration source ${source} is not covered by a Phase 1 mutation module`,
        );
      }
      integrationSourceModules[source] = [...modules];
    }
    if (duplicateValues(manifestEntry.test_suites ?? []).length > 0) {
      errors.push(
        `requirement ${manifestEntry.id} contains duplicate test files`,
      );
    }
    if (entry.status === "ready" && entry.sources.length === 0) {
      errors.push(
        `ready requirement ${manifestEntry.id} has no mutation source files`,
      );
    }
    requirements.push({
      id: entry.id,
      mutationClass,
      threshold: thresholds[mutationClass],
      status: entry.status,
      sources: [...entry.sources],
      integrationSources: [...entry.integrationSources],
      integrationSourceModules,
      tests: [...manifestEntry.test_suites],
    });
  }

  return {
    errors,
    thresholds: { ...thresholds },
    requirements,
    manifestSha256: sha256(canonicalJson(manifest)),
    registrySha256: sha256(canonicalJson(registryEntries)),
    phase1MutationSha256: sha256(canonicalJson(phase1MutationModules)),
  };
}

const fileIsRegular = (path) => {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
};

export function inspectPhase2MutationReadiness({
  authority = loadPhase2MutationAuthority(),
  repositoryRoot = DEFAULT_PHASE2_MUTATION_ROOT,
} = {}) {
  const root = resolve(repositoryRoot);
  const errors = [...authority.errors];
  const ready = [];
  const incomplete = [];
  for (const requirement of authority.requirements) {
    const missingSources = requirement.sources.filter(
      (path) => !fileIsRegular(join(root, path)),
    );
    const missingTests = requirement.tests.filter(
      (path) => !fileIsRegular(join(root, path)),
    );
    const missingIntegrationSources = (
      requirement.integrationSources ?? []
    ).filter((path) => !fileIsRegular(join(root, path)));
    if (
      requirement.status === "ready" &&
      requirement.sources.length > 0 &&
      missingSources.length === 0 &&
      missingIntegrationSources.length === 0 &&
      missingTests.length === 0
    ) {
      ready.push(requirement.id);
    } else {
      incomplete.push({
        id: requirement.id,
        status: requirement.status,
        missingSources,
        missingIntegrationSources,
        missingTests,
      });
    }
  }
  const completed = ready.length;
  const required = 64;
  const blockers = [];
  if (errors.length > 0) {
    blockers.push({ code: "mutation_configuration_invalid" });
  }
  if (completed !== required) {
    blockers.push({
      code: "mutation_incomplete",
      completed,
      required,
    });
  }
  return {
    ok: errors.length === 0 && completed === required,
    completed,
    required,
    ready,
    incomplete,
    errors,
    blockers,
    manifestSha256: authority.manifestSha256,
    registrySha256: authority.registrySha256,
    phase1MutationSha256: authority.phase1MutationSha256,
  };
}

export function resolvePhase2MutationTarget(target, authority) {
  if (target === "phase2") return { id: "phase2", full: true };
  const requirement = authority.requirements.find(
    (entry) => entry.id === target,
  );
  if (!requirement) {
    throw new Error(`unknown Phase 2 mutation target: ${String(target)}`);
  }
  return requirement;
}

const emptyCounts = () => ({
  total: 0,
  killed: 0,
  timeout: 0,
  survived: 0,
  noCoverage: 0,
  ignored: 0,
});

const addCounts = (target, source) => {
  for (const key of Object.keys(target))
    target[key] += Number(source?.[key] ?? 0);
  return target;
};

const scoreFromCounts = (counts) => {
  const testable = counts.total - counts.ignored;
  if (testable <= 0) return 0;
  return Number(
    (((counts.killed + counts.timeout) / testable) * 100).toFixed(2),
  );
};

const validCounts = (counts) => {
  if (!counts || typeof counts !== "object") return false;
  const keys = [
    "total",
    "killed",
    "timeout",
    "survived",
    "noCoverage",
    "ignored",
  ];
  if (
    !keys.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
  ) {
    return false;
  }
  return (
    counts.total ===
    counts.killed +
      counts.timeout +
      counts.survived +
      counts.noCoverage +
      counts.ignored
  );
};

const reportErrors = (
  report,
  authority,
  { ignoreReportedStatus = false, final = false } = {},
) => {
  const errors = [
    ...authority.errors,
    ...(final
      ? validatePhase2MutationCandidateSchema(report)
      : validatePhase2MutationDraftSchema(report)),
  ];
  const expectedSchema = final
    ? PHASE2_MUTATION_FINAL_SCHEMA_VERSION
    : PHASE2_MUTATION_DRAFT_SCHEMA_VERSION;
  if (report.schema_version !== expectedSchema) {
    errors.push("Phase 2 mutation report schema mismatch");
  }
  if (!SHA_40.test(report.commit_sha ?? ""))
    errors.push("invalid report commit SHA");
  if (!SHA_40.test(report.tree_sha ?? ""))
    errors.push("invalid report tree SHA");
  if (!HASH_64.test(report.configuration_hash ?? "")) {
    errors.push("invalid report configuration hash");
  }
  if (report.registry_sha256 !== authority.registrySha256) {
    errors.push("report registry hash mismatch");
  }
  if (report.manifest_sha256 !== authority.manifestSha256) {
    errors.push("report manifest hash mismatch");
  }
  if (
    report.phase1_mutation_registry_sha256 !== authority.phase1MutationSha256
  ) {
    errors.push("report Phase 1 mutation registry hash mismatch");
  }
  if (
    canonicalJson(report.thresholds) !== canonicalJson(authority.thresholds)
  ) {
    errors.push("report mutation thresholds mismatch");
  }
  const expectedEvidenceEligibility = false;
  if (
    !ignoreReportedStatus &&
    report.evidence_eligible !== expectedEvidenceEligibility
  ) {
    errors.push("report Evidence eligibility does not match its scope");
  }
  const results = Array.isArray(report.results) ? report.results : [];
  if (report.evidence_eligible === true) {
    if (
      report.execution_provenance !== "formal_isolated" ||
      !["seatbelt", "bubblewrap"].includes(report.isolation_mechanism) ||
      !UUID_V4.test(report.formal_run_id ?? "") ||
      !HASH_64.test(report.snapshot_sha256 ?? "") ||
      !HASH_64.test(report.batch_sha256 ?? "")
    ) {
      errors.push("final Evidence lacks a valid formal isolated run identity");
    }
    for (const result of results) {
      if (
        result?.execution_provenance !== "formal_isolated" ||
        result?.isolation_mechanism !== report.isolation_mechanism ||
        result?.formal_run_id !== report.formal_run_id ||
        result?.snapshot_sha256 !== report.snapshot_sha256 ||
        result?.batch_sha256 !== report.batch_sha256 ||
        result?.synthetic_fixture !== false
      ) {
        errors.push(
          `${String(result?.requirement_id)} formal run identity mismatch`,
        );
      }
    }
  }
  const syntheticResults = results.filter(
    (result) => result?.synthetic_fixture !== false,
  );
  if (report.target === "phase2" && syntheticResults.length > 0) {
    errors.push(
      "full Phase 2 Evidence cannot contain synthetic mutation results",
    );
  }
  if (
    (report.evidence_eligible === true ||
      results.some((result) => result?.evidence_eligible === true)) &&
    syntheticResults.length > 0
  ) {
    errors.push("Evidence-eligible mutation results must be non-synthetic");
  }
  if (
    report.target !== "phase2" &&
    (report.evidence_eligible === true ||
      results.some((result) => result?.evidence_eligible === true))
  ) {
    errors.push("diagnostic mutation results are never Evidence-eligible");
  }
  if (!ignoreReportedStatus) {
    for (const result of results) {
      if (result?.evidence_eligible !== expectedEvidenceEligibility) {
        errors.push(
          `${String(result?.requirement_id)} result Evidence eligibility does not match its scope`,
        );
      }
    }
  }
  const ids = results.map((result) => result?.requirement_id);
  for (const id of duplicateValues(ids))
    errors.push(`duplicate mutation result: ${String(id)}`);
  const authorityById = new Map(
    authority.requirements.map((requirement) => [requirement.id, requirement]),
  );
  for (const id of ids) {
    if (!authorityById.has(id))
      errors.push(`unknown mutation result: ${String(id)}`);
  }
  if (report.target === "phase2") {
    if (results.length === 0)
      errors.push("empty full Phase 2 mutation report is forbidden");
    const expectedIds = authority.requirements.map((entry) => entry.id);
    const actualIds = [...new Set(ids.filter((id) => authorityById.has(id)))];
    for (const id of expectedIds) {
      if (!actualIds.includes(id))
        errors.push(`partial full report is missing ${id}`);
    }
    if (actualIds.length !== expectedIds.length) {
      errors.push(
        `partial full report contains ${actualIds.length}/${expectedIds.length} requirements`,
      );
    }
  } else if (
    results.length !== 1 ||
    results[0]?.requirement_id !== report.target
  ) {
    errors.push(
      "diagnostic report must contain exactly its requested requirement",
    );
  }

  const aggregate = emptyCounts();
  let allResultsPass = results.length > 0;
  for (const result of results) {
    const requirement = authorityById.get(result?.requirement_id);
    if (!requirement) {
      allResultsPass = false;
      continue;
    }
    if (result.commit_sha !== report.commit_sha) {
      errors.push(`mixed commit SHA for ${requirement.id}`);
    }
    if (result.tree_sha !== report.tree_sha) {
      errors.push(`mixed tree SHA for ${requirement.id}`);
    }
    const runPrefix = `${requirement.id.toLowerCase()}-`;
    if (
      typeof result.run_id !== "string" ||
      !result.run_id.startsWith(runPrefix) ||
      !UUID_V4.test(result.run_id.slice(runPrefix.length))
    ) {
      errors.push(`${requirement.id} run ID is invalid`);
    }
    if (
      report.target === "phase2" &&
      result.vitest_config_path !== "vitest.mutation.config.ts"
    ) {
      errors.push(`${requirement.id} Vitest mutation config mismatch`);
    }
    for (const [field, expected] of [
      ["registry_sha256", authority.registrySha256],
      ["manifest_sha256", authority.manifestSha256],
      ["phase1_mutation_registry_sha256", authority.phase1MutationSha256],
      ["configuration_hash", report.configuration_hash],
    ]) {
      if (result[field] !== expected)
        errors.push(`${requirement.id} ${field} mismatch`);
    }
    if (
      result.mutation_class !== requirement.mutationClass ||
      result.threshold !== requirement.threshold
    ) {
      errors.push(`${requirement.id} threshold authority mismatch`);
    }
    if (!exactArray(result.sources, requirement.sources)) {
      errors.push(`${requirement.id} source file set mismatch`);
    }
    if (
      !exactArray(result.integration_sources, requirement.integrationSources) ||
      canonicalJson(result.integration_source_modules) !==
        canonicalJson(requirement.integrationSourceModules)
    ) {
      errors.push(`${requirement.id} integration source authority mismatch`);
    }
    if (!exactArray(result.tests, requirement.tests)) {
      errors.push(`${requirement.id} test file set mismatch`);
    }
    if (!validCounts(result.counts)) {
      errors.push(`${requirement.id} has invalid aggregate counts`);
      allResultsPass = false;
    } else {
      addCounts(aggregate, result.counts);
      const score = scoreFromCounts(result.counts);
      if (result.score !== score)
        errors.push(`${requirement.id} score mismatch`);
      if (score < requirement.threshold) {
        errors.push(
          `${requirement.id} mutation score ${score} is below ${requirement.threshold}`,
        );
        allResultsPass = false;
      }
    }
    const perFile = result.per_file ?? {};
    let allPerFilePass = true;
    if (
      !exactArray(Object.keys(perFile).sort(), [...requirement.sources].sort())
    ) {
      errors.push(`${requirement.id} per-file result set mismatch`);
    }
    const perFileAggregate = emptyCounts();
    for (const [source, metrics] of Object.entries(perFile)) {
      if (!requirement.sources.includes(source) || !validCounts(metrics)) {
        errors.push(
          `${requirement.id} has invalid per-file counts for ${source}`,
        );
        allPerFilePass = false;
        continue;
      }
      addCounts(perFileAggregate, metrics);
      if (metrics.score !== scoreFromCounts(metrics)) {
        errors.push(`${requirement.id} per-file score mismatch for ${source}`);
        allPerFilePass = false;
      }
      if (scoreFromCounts(metrics) < requirement.threshold) {
        errors.push(
          `${requirement.id} per-file mutation score for ${source} is below ${requirement.threshold}`,
        );
        allPerFilePass = false;
        allResultsPass = false;
      }
    }
    if (canonicalJson(perFileAggregate) !== canonicalJson(result.counts)) {
      errors.push(`${requirement.id} per-file aggregate mismatch`);
    }
    if (
      !Number.isSafeInteger(result.expected_chunk_count) ||
      result.expected_chunk_count <= 0 ||
      !Array.isArray(result.chunks) ||
      result.chunks.length !== result.expected_chunk_count ||
      result.chunks.some((chunk) => chunk?.complete !== true)
    ) {
      errors.push(`${requirement.id} has a partial chunk set`);
      allResultsPass = false;
    }
    for (const chunk of result.chunks ?? []) {
      if (
        !requirement.sources.includes(chunk.source_file) ||
        !Number.isSafeInteger(chunk.start_line) ||
        !Number.isSafeInteger(chunk.end_line) ||
        chunk.start_line <= 0 ||
        chunk.end_line < chunk.start_line ||
        chunk.end_line - chunk.start_line + 1 > PHASE2_MUTATION_CHUNK_LINES ||
        !HASH_64.test(chunk.raw_report_sha256 ?? "") ||
        !HASH_64.test(chunk.config_sha256 ?? "") ||
        !HASH_64.test(chunk.mutant_identity_sha256 ?? "")
      ) {
        errors.push(`${requirement.id} has invalid chunk identity`);
      }
    }
    const expectedResultStatus =
      validCounts(result.counts) &&
      scoreFromCounts(result.counts) >= requirement.threshold &&
      allPerFilePass &&
      result.expected_chunk_count === result.chunks?.length &&
      result.chunks?.every((chunk) => chunk.complete === true)
        ? "PASS"
        : "FAIL";
    if (result.status !== expectedResultStatus) {
      errors.push(`${requirement.id} result status is inconsistent`);
    }
  }

  if (!validCounts(report.aggregate))
    errors.push("invalid Phase 2 aggregate counts");
  else {
    if (canonicalJson(report.aggregate) !== canonicalJson(aggregate)) {
      errors.push("Phase 2 aggregate counts mismatch");
    }
    if (report.aggregate_score !== scoreFromCounts(aggregate)) {
      errors.push("Phase 2 aggregate score mismatch");
    }
  }
  const expectedCompleted = new Set(
    results
      .filter((result) => result?.status === "PASS")
      .map((result) => result.requirement_id),
  ).size;
  if (report.completed !== expectedCompleted)
    errors.push("Phase 2 completed count mismatch");
  if (report.required !== (report.target === "phase2" ? 64 : 1)) {
    errors.push("Phase 2 required count mismatch");
  }
  const expectedStatus =
    errors.length === 0 &&
    allResultsPass &&
    report.completed === report.required
      ? "PASS"
      : "FAIL";
  if (!ignoreReportedStatus && report.status !== expectedStatus) {
    errors.push(`Phase 2 report status must be ${expectedStatus}`);
  }
  return errors;
};

export function validatePhase2MutationReport(report, authority) {
  return reportErrors(report, authority);
}

export function validateFinalPhase2MutationReport(report, authority) {
  const errors = reportErrors(report, authority, { final: true });
  if (report?.target !== "phase2")
    errors.push("final Phase 2 mutation report target must be phase2");
  if (report?.status !== "PASS" || report?.completed !== 64)
    errors.push("final Phase 2 mutation report must be a complete PASS");
  if (!/^commit:\/\/[a-f0-9]{40}\/$/u.test(report?.source_root ?? ""))
    errors.push("final Phase 2 mutation source_root must be a commit URI");
  if (!/^bundle:\/\/[a-f0-9]{64}\/$/u.test(report?.artifact_root ?? ""))
    errors.push("final Phase 2 mutation artifact_root must be a bundle URI");
  if (
    !report?.execution_receipt ||
    report.execution_receipt.schema_version !==
      "phase2-mutation-execution-receipt/v1" ||
    report.execution_receipt.child_exit_status !== 0 ||
    !HASH_64.test(report.execution_receipt.runner_sha256 ?? "") ||
    report.execution_receipt.configuration_sha256 !==
      report.configuration_hash ||
    !HASH_64.test(report.execution_receipt.source_snapshot_sha256 ?? "") ||
    !HASH_64.test(report.execution_receipt.dependency_snapshot_sha256 ?? "") ||
    !HASH_64.test(report.execution_receipt.dependency_manifest_sha256 ?? "") ||
    !HASH_64.test(report.execution_receipt.authority_closure_sha256 ?? "") ||
    !HASH_64.test(report.execution_receipt.mutant_completeness_sha256 ?? "") ||
    report.execution_receipt.isolation_mechanism !== "bubblewrap"
  )
    errors.push("final Phase 2 mutation execution receipt is invalid");
  return [...new Set(errors)];
}

export const validatePhase2MutationCandidateReport =
  validateFinalPhase2MutationReport;

export function buildPhase2MutationReport({
  authority,
  target,
  commitSha,
  treeSha,
  configurationHash,
  results,
}) {
  const aggregate = emptyCounts();
  for (const result of results) {
    if (validCounts(result?.counts)) addCounts(aggregate, result.counts);
  }
  const report = {
    schema_version: PHASE2_MUTATION_SCHEMA_VERSION,
    phase: 2,
    target,
    evidence_eligible: false,
    commit_sha: commitSha,
    tree_sha: treeSha,
    registry_sha256: authority.registrySha256,
    manifest_sha256: authority.manifestSha256,
    phase1_mutation_registry_sha256: authority.phase1MutationSha256,
    configuration_hash: configurationHash,
    thresholds: { ...authority.thresholds },
    completed: new Set(
      results
        .filter((result) => result?.status === "PASS")
        .map((result) => result.requirement_id),
    ).size,
    required: target === "phase2" ? 64 : 1,
    aggregate,
    aggregate_score: scoreFromCounts(aggregate),
    results: globalThis.structuredClone(results),
    status: "PASS",
    errors: [],
  };
  const errors = reportErrors(report, authority, {
    ignoreReportedStatus: true,
  });
  report.status = errors.length === 0 ? "PASS" : "FAIL";
  report.errors = reportErrors(report, authority);
  return report;
}
