#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Instrumenter } from "@stryker-mutator/instrumenter";
import ts from "typescript";

import {
  buildPhase2MutationReport,
  DEFAULT_PHASE2_MUTATION_ROOT,
  inspectPhase2MutationReadiness,
  loadPhase2MutationAuthority,
  PHASE2_MUTATION_CHUNK_LINES,
  resolvePhase2MutationTarget,
  validatePhase2MutationReport,
} from "./gates/phase2-mutation.mjs";
import { runProcessTree } from "./run-process-tree.mjs";
import { addTrustedDetachedWorktree, readTrustedGitBlob, removeTrustedOwnedWorktree, runTrustedGit } from "./gates/trusted-git.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const DEFAULT_REPORT_ROOT = resolve(
  scriptDirectory,
  "../reports/mutation/phase2",
);
const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
const EXACT_STRYKER_BASE = Object.freeze({
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html", "json"],
  timeoutMS: 30_000,
  dryRunTimeoutMinutes: 10,
  concurrency: 4,
  vitest: { configFile: "vitest.mutation.config.ts" },
  ignorePatterns: ["/reports", ".stryker-tmp"],
  thresholds: { high: 80, low: 70, break: 70 },
  symlinkNodeModules: true,
  cleanTempDir: "always",
});
export const PHASE2_EXPECTED_PHASE1_SHA =
  "8dca581e11b8043aed257cb07c5161237633c40e";
export const PHASE2_MUTATION_AUTHORITY_PATHS = Object.freeze([
  "mutation/phase2-modules.mjs",
  "mutation/modules.mjs",
  "mutation/stryker.base.mjs",
  "verification/gates/phase2-gate.json",
  "verification/gates/phase2-mutation-workflow-contract.json",
  "verification/schemas/phase2-mutation-publication-receipt.schema.json",
  "verification/schemas/phase2-mutation-draft.schema.json",
  "verification/schemas/phase2-mutation-candidate.schema.json",
  "verification/schemas/phase2-mutation-execution-receipt.schema.json",
  "verification/schemas/phase2-mutation-attestation-receipt.schema.json",
  "tests/phase-2/fixtures/native-clean-install/package.json",
  "tests/phase-2/fixtures/native-clean-install/package-lock.json",
  ".github/workflows/phase2-mutation.yml",
  "scripts/gates/phase2-mutation.mjs",
  "scripts/gates/json-schema.mjs",
  "scripts/gates/workflow-contract.mjs",
  "scripts/gates/secure-publish.mjs",
  "scripts/gates/secure-publish.py",
  "scripts/gates/verify-phase2-mutation-bundle.mjs",
  "scripts/gates/verify-phase2-mutant-completeness.mjs",
  "scripts/run-phase2-mutation-launcher.mjs",
  "scripts/run-phase2-mutation-bootstrap.mjs",
  "scripts/run-phase2-mutation.mjs",
  "scripts/run-process-tree.mjs",
  "scripts/gates/trusted-git.mjs",
  "package.json",
  "package-lock.json",
  "patches/@stryker-mutator+core+9.6.1.patch",
  "patches/@stryker-mutator+vitest-runner+9.6.1.patch",
  "vitest.mutation.config.ts",
]);
const silentInstrumenterLogger = Object.freeze({
  debug() {},
  error() {},
  fatal() {},
  info() {},
  trace() {},
  warn() {},
  isDebugEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
  isInfoEnabled: () => false,
  isTraceEnabled: () => false,
  isWarnEnabled: () => false,
});

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

const literalPropertyName = (name) => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  throw new Error("Stryker base contains a non-literal property name");
};

const literalValue = (node) => {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((entry) => literalValue(entry));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries = [];
    const names = new Set();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error("Stryker base must contain only property assignments");
      }
      const name = literalPropertyName(property.name);
      if (
        names.has(name) ||
        ["__proto__", "constructor", "prototype"].includes(name)
      ) {
        throw new Error(`Stryker base contains an unsafe property: ${name}`);
      }
      names.add(name);
      entries.push([name, literalValue(property.initializer)]);
    }
    return Object.fromEntries(entries);
  }
  throw new Error("Stryker base contains a non-literal value");
};

const parseCommittedStrykerBase = (source) => {
  const parsed = ts.createSourceFile(
    "mutation/stryker.base.mjs",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  if (parsed.parseDiagnostics.length > 0 || parsed.statements.length !== 1) {
    throw new Error("committed Stryker base must contain one valid statement");
  }
  const statement = parsed.statements[0];
  const exported = statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
  if (
    !exported ||
    !ts.isVariableStatement(statement) ||
    (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
    statement.declarationList.declarations.length !== 1
  ) {
    throw new Error("committed Stryker base must export one const declaration");
  }
  const declaration = statement.declarationList.declarations[0];
  if (
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== "strykerBase" ||
    declaration.initializer === undefined
  ) {
    throw new Error("committed Stryker base export is invalid");
  }
  const value = literalValue(declaration.initializer);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("committed Stryker base must be an object literal");
  }
  if (canonicalJson(value) !== canonicalJson(EXACT_STRYKER_BASE)) {
    throw new Error(
      "committed Stryker base contains unknown keys, invalid types, or security-critical value drift",
    );
  }
  return value;
};

export const collectPhase2MutationSnapshotPaths = ({
  requirements,
  vitestConfigPath,
}) => {
  const paths = new Set(PHASE2_MUTATION_AUTHORITY_PATHS);
  paths.add(vitestConfigPath);
  for (const requirement of requirements) {
    for (const path of [
      ...(requirement.sources ?? []),
      ...(requirement.integrationSources ?? []),
      ...(requirement.tests ?? []),
    ]) {
      paths.add(path);
    }
  }
  return [...paths].sort();
};

const writeJsonAtomically = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
};

const sourceLineCount = (source) => {
  if (source.length === 0) return 1;
  const lines = source.split("\n");
  return lines.at(-1) === "" ? Math.max(1, lines.length - 1) : lines.length;
};

const chunkId = (requirementId, sourceFile, startLine, endLine) => {
  const slug = `${requirementId}-${sourceFile}`
    .replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .toLowerCase();
  return `${slug}-${startLine}-${endLine}`;
};

export function planPhase2MutationChunks(
  requirement,
  repositoryRoot,
  commitSha,
) {
  const chunks = [];
  for (const sourceFile of [...requirement.sources].sort()) {
    const source = readCommittedRegularBlob(
      repositoryRoot,
      commitSha,
      sourceFile,
    ).toString("utf8");
    const lines = sourceLineCount(source);
    for (
      let startLine = 1;
      startLine <= lines;
      startLine += PHASE2_MUTATION_CHUNK_LINES
    ) {
      const endLine = Math.min(
        lines,
        startLine + PHASE2_MUTATION_CHUNK_LINES - 1,
      );
      chunks.push({
        chunk_id: chunkId(requirement.id, sourceFile, startLine, endLine),
        source_file: sourceFile,
        start_line: startLine,
        end_line: endLine,
        mutate_pattern: `${sourceFile}:${startLine}-${endLine}`,
      });
    }
  }
  return chunks;
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
  for (const key of Object.keys(target)) target[key] += source[key];
  return target;
};

const scoreFromCounts = (counts) => {
  const testable = counts.total - counts.ignored;
  if (testable <= 0) return 0;
  return Number(
    (((counts.killed + counts.timeout) / testable) * 100).toFixed(2),
  );
};

const normalizeSourcePath = (repositoryRoot, path) => {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.startsWith("/")) return normalized.replace(/^\.\//u, "");
  return relative(repositoryRoot, normalized).replaceAll("\\", "/");
};

const terminalMutantCounts = (mutants, label) => {
  const counts = emptyCounts();
  for (const mutant of mutants) {
    counts.total += 1;
    switch (mutant.status) {
      case "Killed":
        counts.killed += 1;
        break;
      case "Timeout":
        counts.timeout += 1;
        break;
      case "Survived":
        counts.survived += 1;
        break;
      case "NoCoverage":
        counts.noCoverage += 1;
        break;
      default:
        throw new Error(
          `non-terminal or ignored mutant ${String(mutant.id)} in ${label}: ${String(mutant.status)}`,
        );
    }
  }
  return counts;
};

const mutantIdentity = (sourceFile, mutant) =>
  canonicalJson({
    source_file: sourceFile,
    mutator_name: mutant.mutatorName,
    replacement: mutant.replacement,
    location: mutant.location,
  });

const instrumentedMutantIdentity = (sourceFile, mutant) =>
  canonicalJson({
    source_file: sourceFile,
    mutator_name: mutant.mutatorName,
    replacement: mutant.replacement,
    location: {
      start: {
        line: mutant.location.start.line + 1,
        column: mutant.location.start.column + 1,
      },
      end: {
        line: mutant.location.end.line + 1,
        column: mutant.location.end.column + 1,
      },
    },
  });

const assertMutantInChunk = (mutant, chunk) => {
  const start = mutant?.location?.start;
  const end = mutant?.location?.end;
  if (
    !Number.isSafeInteger(start?.line) ||
    !Number.isSafeInteger(end?.line) ||
    start.line < chunk.start_line ||
    start.line > chunk.end_line ||
    end.line < start.line ||
    end.line > chunk.end_line
  ) {
    throw new Error(
      `mutant location is outside complete chunk ${chunk.chunk_id}`,
    );
  }
};

const reporterPath = (cwd, absolute) => {
  const candidate = relative(cwd, absolute).replaceAll("\\", "/");
  return candidate === ".." || candidate.startsWith("../")
    ? absolute
    : candidate;
};

const phase2ChunkConfig = ({
  strykerBase,
  requirement,
  chunk,
  reportPath,
  tempDirName,
  vitestConfigPath,
}) => ({
  ...strykerBase,
  concurrency: 1,
  reporters: ["json"],
  mutate: [chunk.mutate_pattern],
  testFiles: [...requirement.tests],
  tempDirName,
  jsonReporter: { fileName: reportPath },
  vitest: { configFile: vitestConfigPath },
  thresholds: {
    high: requirement.threshold,
    low: Math.max(0, requirement.threshold - 5),
    break: null,
  },
});

const runChunk = async ({
  repositoryRoot,
  requirement,
  chunk,
  runId,
  runRoot,
  reportRoot,
  strykerExecutable,
  vitestConfigPath,
  timeoutMs,
  strykerBase,
  candidateContext,
}) => {
  const chunkRoot = join(runRoot, requirement.id, "chunks", chunk.chunk_id);
  const rawReportPath = join(chunkRoot, "mutation.json");
  const configPath = join(chunkRoot, "stryker.config.json");
  const config = phase2ChunkConfig({
    strykerBase,
    requirement,
    chunk,
    reportPath: reporterPath(repositoryRoot, rawReportPath),
    tempDirName: `.stryker-tmp/phase2/${runId}/${chunk.chunk_id}`,
    vitestConfigPath,
  });
  writeJsonAtomically(configPath, config);
  const result = await runProcessTree(strykerExecutable, ["run", configPath], {
    cwd: repositoryRoot,
    env: { ...process.env, STRYKER: "true" },
    timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error(
      `Stryker exited ${String(result.status)} for ${requirement.id}/${chunk.chunk_id}`,
    );
  }
  if (!existsSync(rawReportPath)) {
    throw new Error(`Stryker did not produce ${rawReportPath}`);
  }
  const rawRelativePath = relative(reportRoot, rawReportPath).replaceAll(
    "\\",
    "/",
  );
  const configRelativePath = relative(reportRoot, configPath).replaceAll(
    "\\",
    "/",
  );
  assertNoSymlinkAncestors(reportRoot, rawRelativePath, {
    requireFile: true,
  });
  assertNoSymlinkAncestors(reportRoot, configRelativePath, {
    requireFile: true,
  });
  const rawText = readFileSync(rawReportPath, "utf8");
  const raw = JSON.parse(rawText);
  const rawEntries = Object.entries(raw?.files ?? {});
  const entries = rawEntries.map(([path, file]) => [
    normalizeSourcePath(repositoryRoot, path),
    file,
  ]);
  if (
    entries.length > 1 ||
    (entries.length === 1 && entries[0][0] !== chunk.source_file)
  ) {
    throw new Error(`raw report source mismatch for ${chunk.chunk_id}`);
  }
  const mutants = entries.length === 0 ? [] : (entries[0][1]?.mutants ?? []);
  if (!Array.isArray(mutants)) {
    throw new Error(`raw report mutants are invalid for ${chunk.chunk_id}`);
  }
  for (const mutant of mutants) assertMutantInChunk(mutant, chunk);
  const identities = mutants.map((mutant) =>
    mutantIdentity(chunk.source_file, mutant),
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error(`duplicate raw mutant identity in ${chunk.chunk_id}`);
  }
  return {
    chunk: {
      ...chunk,
      complete: true,
      raw_report_path: rawRelativePath,
      config_path: configRelativePath,
      raw_report_uri:
        candidateContext === null
          ? null
          : `bundle://${candidateContext.batchSha256}/raw/${requirement.id}/${chunk.chunk_id}/mutation.json`,
      config_uri:
        candidateContext === null
          ? null
          : `bundle://${candidateContext.batchSha256}/raw/${requirement.id}/${chunk.chunk_id}/stryker.config.json`,
      raw_report_sha256: sha256(rawText),
      config_sha256: sha256(readFileSync(configPath)),
      raw_source_path_sha256: sha256(
        canonicalJson(rawEntries.map(([path]) => path).sort()),
      ),
      normalized_source_file: chunk.source_file,
      mutant_identity_sha256: sha256(canonicalJson(identities.sort())),
    },
    mutants,
  };
};

async function executePhase2RequirementMutation({
  repositoryRoot,
  requirement,
  commitSha,
  treeSha,
  registrySha256,
  manifestSha256,
  phase1MutationSha256,
  configurationHash,
  strykerExecutable,
  vitestConfigPath,
  reportRoot = join(repositoryRoot, "reports/mutation/phase2-diagnostic"),
  timeoutMs = 15 * 60 * 1000,
  candidateContext = null,
}) {
  if (!SHA_40.test(commitSha ?? ""))
    throw new Error("diagnostic requires exact commit SHA");
  if (!SHA_40.test(treeSha ?? ""))
    throw new Error("diagnostic requires exact tree SHA");
  const committedTreeSha = runTrustedGit(repositoryRoot, [
    "rev-parse",
    `${commitSha}^{tree}`,
  ]).trim();
  if (treeSha !== committedTreeSha) {
    throw new Error("diagnostic tree SHA does not match its commit");
  }
  for (const [label, value] of [
    ["registry", registrySha256],
    ["manifest", manifestSha256],
    ["Phase 1 mutation registry", phase1MutationSha256],
    ["configuration", configurationHash],
  ]) {
    if (!HASH_64.test(value ?? ""))
      throw new Error(`diagnostic ${label} hash is invalid`);
  }
  if (
    requirement.status !== "ready" ||
    !Array.isArray(requirement.sources) ||
    requirement.sources.length === 0 ||
    !Array.isArray(requirement.tests) ||
    requirement.tests.length === 0
  ) {
    throw new Error(`diagnostic requirement ${requirement.id} is not ready`);
  }
  reportRoot = prepareSafeReportRoot(repositoryRoot, reportRoot);
  for (const path of [
    ...requirement.sources,
    ...(requirement.integrationSources ?? []),
    ...requirement.tests,
    vitestConfigPath,
    "mutation/stryker.base.mjs",
  ]) {
    verifyCommittedWorkingRegularBlob(repositoryRoot, commitSha, path);
  }
  const strykerBase = parseCommittedStrykerBase(
    readCommittedRegularBlob(
      repositoryRoot,
      commitSha,
      "mutation/stryker.base.mjs",
    ).toString("utf8"),
  );
  const runId = `${requirement.id.toLowerCase()}-${randomUUID()}`;
  const runRoot = join(reportRoot, "runs", runId);
  const chunks = planPhase2MutationChunks(
    requirement,
    repositoryRoot,
    commitSha,
  );
  if (chunks.length === 0)
    throw new Error("diagnostic mutation chunk set is empty");
  const isolated = candidateContext
    ? { executionRoot: repositoryRoot, cleanup() {} }
    : createIsolatedExecutionRoot(repositoryRoot, commitSha);
  const executionRoot = isolated.executionRoot;
  const perFileMutants = new Map(
    requirement.sources.map((source) => [source, []]),
  );
  const identities = new Set();
  const chunkResults = [];
  let executionError;
  let executionResult;
  try {
    for (const chunk of chunks) {
      const executed = await runChunk({
        repositoryRoot: executionRoot,
        requirement,
        chunk,
        runId,
        runRoot,
        reportRoot,
        strykerExecutable,
        vitestConfigPath,
        timeoutMs,
        strykerBase,
        candidateContext,
      });
      for (const mutant of executed.mutants) {
        const identity = mutantIdentity(chunk.source_file, mutant);
        if (identities.has(identity)) {
          throw new Error(
            `duplicate mutant identity across chunks: ${chunk.chunk_id}`,
          );
        }
        identities.add(identity);
        perFileMutants.get(chunk.source_file).push(mutant);
      }
      chunkResults.push(executed.chunk);
    }
    const perFile = {};
    const aggregate = emptyCounts();
    for (const sourceFile of requirement.sources) {
      const fileCounts = terminalMutantCounts(
        perFileMutants.get(sourceFile),
        `${requirement.id}/${sourceFile}`,
      );
      addCounts(aggregate, fileCounts);
      perFile[sourceFile] = {
        ...fileCounts,
        score: scoreFromCounts(fileCounts),
      };
    }
    const score = scoreFromCounts(aggregate);
    const allFilesPass = Object.values(perFile).every(
      (metrics) => metrics.total > 0 && metrics.score >= requirement.threshold,
    );
    executionResult = {
      requirement_id: requirement.id,
      mutation_class: requirement.mutationClass,
      threshold: requirement.threshold,
      status:
        aggregate.total > 0 && score >= requirement.threshold && allFilesPass
          ? "PASS"
          : "FAIL",
      evidence_eligible: false,
      synthetic_fixture: candidateContext === null,
      execution_provenance:
        candidateContext === null ? "diagnostic" : "isolated_candidate",
      isolation_mechanism: candidateContext?.isolationMechanism ?? null,
      candidate_run_id: candidateContext?.candidateRunId ?? null,
      snapshot_sha256: candidateContext?.snapshotSha256 ?? null,
      batch_sha256: candidateContext?.batchSha256 ?? null,
      commit_sha: commitSha,
      tree_sha: treeSha,
      registry_sha256: registrySha256,
      manifest_sha256: manifestSha256,
      phase1_mutation_registry_sha256: phase1MutationSha256,
      configuration_hash: configurationHash,
      run_id: runId,
      vitest_config_path: vitestConfigPath,
      sources: [...requirement.sources],
      integration_sources: [...(requirement.integrationSources ?? [])],
      integration_source_modules: Object.fromEntries(
        Object.entries(requirement.integrationSourceModules ?? {}).map(
          ([source, modules]) => [source, [...modules]],
        ),
      ),
      tests: [...requirement.tests],
      counts: aggregate,
      score,
      per_file: perFile,
      expected_chunk_count: chunks.length,
      chunks: chunkResults,
      mutant_identity_sha256: sha256(canonicalJson([...identities].sort())),
    };
  } catch (error) {
    executionError = error;
  }
  const cleanupErrors = [];
  try {
    rmSync(join(executionRoot, ".stryker-tmp", "phase2", runId), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    isolated.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    const cleanupMessage = cleanupErrors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join("; ");
    if (executionError !== undefined) {
      const primaryMessage =
        executionError instanceof Error
          ? executionError.message
          : String(executionError);
      throw new AggregateError(
        [executionError, ...cleanupErrors],
        `${primaryMessage}; mutation cleanup failed: ${cleanupMessage}`,
      );
    }
    throw new AggregateError(
      cleanupErrors,
      `mutation cleanup failed: ${cleanupMessage}`,
    );
  }
  if (executionError !== undefined) throw executionError;
  if (executionResult === undefined)
    throw new Error("mutation execution completed without a result");
  return executionResult;
}

export async function runPhase2RequirementDiagnostic(options) {
  return executePhase2RequirementMutation({ ...options, candidateContext: null });
}

const resolveArtifactPath = (reportRoot, path) => {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\")) {
    throw new Error(`unsafe mutation artifact path: ${String(path)}`);
  }
  const absolute = resolve(reportRoot, path);
  const normalized = relative(reportRoot, absolute).replaceAll("\\", "/");
  if (
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`mutation artifact path escapes report root: ${path}`);
  }
  return absolute;
};

const assertSafeRepositoryPath = (path) => {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    /[*?[\]{}]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`unsafe mutation repository path: ${String(path)}`);
  }
};

const assertNoSymlinkAncestors = (
  root,
  relativePath,
  { requireFile = false } = {},
) => {
  assertSafeRepositoryPath(relativePath);
  const resolvedRoot = resolve(root);
  const rootMetadata = lstatSync(resolvedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("mutation repository root must be a real directory");
  }
  const parts = relativePath.split("/");
  let cursor = resolvedRoot;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const metadata = lstatSync(cursor);
    const displayPath = parts.slice(0, index + 1).join("/");
    if (metadata.isSymbolicLink()) {
      throw new Error(`mutation path ancestor is a symlink: ${displayPath}`);
    }
    const leaf = index === parts.length - 1;
    if (!leaf && !metadata.isDirectory()) {
      throw new Error(`mutation path ancestor is not a directory: ${displayPath}`);
    }
    if (leaf && requireFile && !metadata.isFile()) {
      throw new Error(`mutation path is not a regular file: ${relativePath}`);
    }
  }
};

const prepareSafeReportRoot = (repositoryRoot, reportRoot) => {
  const root = resolve(repositoryRoot);
  const absolute = resolve(reportRoot);
  const relativeRoot = relative(root, absolute).replaceAll("\\", "/");
  if (
    relativeRoot === "" ||
    relativeRoot === ".." ||
    relativeRoot.startsWith("../")
  ) {
    throw new Error("mutation report root must remain inside the repository");
  }
  assertSafeRepositoryPath(relativeRoot);
  const parts = relativeRoot.split("/");
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const displayPath = parts.slice(0, index + 1).join("/");
    try {
      const metadata = lstatSync(cursor);
      if (metadata.isSymbolicLink()) {
        throw new Error(`mutation report ancestor is a symlink: ${displayPath}`);
      }
      if (!metadata.isDirectory()) {
        throw new Error(
          `mutation report ancestor is not a directory: ${displayPath}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        mkdirSync(cursor, { mode: 0o700 });
        const created = lstatSync(cursor);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error(
            `mutation report directory creation was replaced: ${displayPath}`,
            { cause: error },
          );
        }
        continue;
      }
      throw error;
    }
  }
  return absolute;
};

const createIsolatedExecutionRoot = (repositoryRoot, commitSha) => {
  const parent = resolve(
    dirname(repositoryRoot),
    `.phase2-mutation-isolated-${randomUUID()}`,
  );
  const executionRoot = join(parent, "repository");
  mkdirSync(parent, { mode: 0o700 });
  try {
    addTrustedDetachedWorktree(repositoryRoot, executionRoot, commitSha);
    const dependencyRoot = join(repositoryRoot, "node_modules");
    if (existsSync(dependencyRoot)) {
      const resolvedDependencies = realpathSync(dependencyRoot);
      const dependencyMetadata = lstatSync(resolvedDependencies);
      if (!dependencyMetadata.isDirectory()) {
        throw new Error("mutation dependency boundary is not a directory");
      }
      cpSync(resolvedDependencies, join(executionRoot, "node_modules"), {
        recursive: true,
        dereference: true,
        force: false,
      });
    }
    return {
      executionRoot,
      cleanup() {
        const cleanupErrors = [];
        try {
          // node_modules is an untracked dependency snapshot, not Git
          // authority. Remove this exact owned path before asking Git to
          // detach the worktree so cleanup is bounded by tracked content.
          rmSync(join(executionRoot, "node_modules"), {
            recursive: true,
            force: true,
          });
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          removeTrustedOwnedWorktree(repositoryRoot, executionRoot);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          rmSync(parent, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            cleanupErrors,
            `isolated mutation cleanup failed: ${cleanupErrors
              .map((error) =>
                error instanceof Error ? error.message : String(error),
              )
              .join("; ")}`,
          );
        }
      },
    };
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
};

const readCommittedRegularBlob = (repositoryRoot, commitSha, relativePath) => {
  assertSafeRepositoryPath(relativePath);
  const rawEntry = runTrustedGit(
    repositoryRoot,
    ["ls-tree", "--full-tree", "-z", commitSha, "--", relativePath],
    { encoding: "buffer" },
  );
  const entries = rawEntry
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
  if (entries.length !== 1) {
    throw new Error(
      `Git tree has ${entries.length} entries for mutation source ${relativePath}`,
    );
  }
  const separator = entries[0].indexOf("\t");
  const header =
    separator === -1 ? [] : entries[0].slice(0, separator).split(" ");
  const committedPath = separator === -1 ? "" : entries[0].slice(separator + 1);
  const [mode, type] = header;
  if (
    committedPath !== relativePath ||
    type !== "blob" ||
    !REGULAR_BLOB_MODES.has(mode)
  ) {
    throw new Error(
      `Git tree mode ${mode ?? "missing"} type ${type ?? "missing"} for ${relativePath} is not an allowed regular blob`,
    );
  }
  return readTrustedGitBlob(repositoryRoot, commitSha, relativePath);
};

const verifyCommittedWorkingRegularBlob = (
  repositoryRoot,
  commitSha,
  relativePath,
) => {
  assertNoSymlinkAncestors(repositoryRoot, relativePath, {
    requireFile: true,
  });
  const committed = readCommittedRegularBlob(
    repositoryRoot,
    commitSha,
    relativePath,
  );
  const absolute = resolve(repositoryRoot, relativePath);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `working tree input is not a regular file: ${relativePath}`,
    );
  }
  const working = readFileSync(absolute);
  if (!working.equals(committed)) {
    throw new Error(
      `working tree bytes differ from commit for ${relativePath}`,
    );
  }
  return committed;
};

export async function validatePhase2RepositorySnapshot({
  repositoryRoot,
  commitSha,
  requiredPaths,
}) {
  if (!SHA_40.test(commitSha ?? "")) {
    throw new Error("Phase 2 snapshot requires an exact commit SHA");
  }
  const resolvedCommit = runTrustedGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${commitSha}^{commit}`,
  ]).trim();
  if (resolvedCommit !== commitSha) {
    throw new Error("Phase 2 snapshot commit resolution mismatch");
  }
  try {
    runTrustedGit(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      PHASE2_EXPECTED_PHASE1_SHA,
      commitSha,
    ]);
  } catch {
    throw new Error(
      `Phase 2 mutation commit is not a descendant of ${PHASE2_EXPECTED_PHASE1_SHA}`,
    );
  }
  const treeSha = runTrustedGit(repositoryRoot, [
    "rev-parse",
    `${commitSha}^{tree}`,
  ]).trim();
  const paths = [...new Set(requiredPaths)].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    const bytes = verifyCommittedWorkingRegularBlob(
      repositoryRoot,
      commitSha,
      path,
    );
    hash.update(path);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return {
    commitSha,
    treeSha,
    baselineSha: PHASE2_EXPECTED_PHASE1_SHA,
    paths,
    snapshotSha256: hash.digest("hex"),
  };
}

export async function validatePhase2MutationArtifacts({
  repositoryRoot,
  reportRoot,
  result,
  artifactReader = null,
  canonicalReportRoot = reportRoot,
  sourcePathRoot = repositoryRoot,
}) {
  if (!SHA_40.test(result?.commit_sha ?? "")) {
    throw new Error(
      "mutation artifact validation requires an exact commit SHA",
    );
  }
  const expectedTreeSha = runTrustedGit(repositoryRoot, [
    "rev-parse",
    `${result.commit_sha}^{tree}`,
  ]).trim();
  if (result.tree_sha !== expectedTreeSha) {
    throw new Error("mutation artifact tree SHA mismatch");
  }
  if (
    typeof result.requirement_id !== "string" ||
    typeof result.run_id !== "string" ||
    !result.run_id.startsWith(`${result.requirement_id.toLowerCase()}-`) ||
    !UUID_V4.test(
      result.run_id.slice(`${result.requirement_id.toLowerCase()}-`.length),
    )
  ) {
    throw new Error("mutation artifact run ID is not deterministic");
  }
  if (
    !Array.isArray(result.sources) ||
    !Array.isArray(result.integration_sources) ||
    !Array.isArray(result.tests)
  ) {
    throw new Error("mutation artifact input paths are invalid");
  }
  for (const inputPath of [
    ...result.sources,
    ...result.integration_sources,
    ...result.tests,
    result.vitest_config_path,
    "mutation/stryker.base.mjs",
  ]) {
    verifyCommittedWorkingRegularBlob(
      repositoryRoot,
      result.commit_sha,
      inputPath,
    );
  }
  const committedStrykerBase = parseCommittedStrykerBase(
    readCommittedRegularBlob(
      repositoryRoot,
      result.commit_sha,
      "mutation/stryker.base.mjs",
    ).toString("utf8"),
  );
  const sourceBytes = new Map(
    result.sources.map((sourceFile) => [
      sourceFile,
      verifyCommittedWorkingRegularBlob(
        repositoryRoot,
        result.commit_sha,
        sourceFile,
      ).toString("utf8"),
    ]),
  );
  const expectedChunks = [];
  for (const sourceFile of [...result.sources].sort()) {
    const lineCount = sourceLineCount(sourceBytes.get(sourceFile));
    for (
      let startLine = 1;
      startLine <= lineCount;
      startLine += PHASE2_MUTATION_CHUNK_LINES
    ) {
      const endLine = Math.min(
        lineCount,
        startLine + PHASE2_MUTATION_CHUNK_LINES - 1,
      );
      expectedChunks.push({
        chunk_id: chunkId(
          result.requirement_id,
          sourceFile,
          startLine,
          endLine,
        ),
        source_file: sourceFile,
        start_line: startLine,
        end_line: endLine,
        mutate_pattern: `${sourceFile}:${startLine}-${endLine}`,
      });
    }
  }
  const actualChunkPlan = result.chunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    source_file: chunk.source_file,
    start_line: chunk.start_line,
    end_line: chunk.end_line,
    mutate_pattern: chunk.mutate_pattern,
  }));
  if (
    result.expected_chunk_count !== expectedChunks.length ||
    canonicalJson(actualChunkPlan) !== canonicalJson(expectedChunks)
  ) {
    throw new Error(
      `partial chunk set for ${result.requirement_id}: ${actualChunkPlan.length}/${expectedChunks.length}`,
    );
  }
  const mutantsByFile = new Map(
    result.sources.map((sourceFile) => [sourceFile, []]),
  );
  const identities = new Set();
  const instrumenter = new Instrumenter(silentInstrumenterLogger);
  for (const chunk of result.chunks) {
    const expectedChunkRoot = [
      "runs",
      result.run_id,
      result.requirement_id,
      "chunks",
      chunk.chunk_id,
    ].join("/");
    const expectedRawPath = `${expectedChunkRoot}/mutation.json`;
    const expectedConfigPath = `${expectedChunkRoot}/stryker.config.json`;
    if (artifactReader === null && (
      chunk.raw_report_path !== expectedRawPath ||
      chunk.config_path !== expectedConfigPath
    )) {
      throw new Error(
        `deterministic mutation artifact path mismatch for ${chunk.chunk_id}`,
      );
    }
    const rawPath = artifactReader === null ? resolveArtifactPath(reportRoot, chunk.raw_report_path) : null;
    const configPath = artifactReader === null ? resolveArtifactPath(reportRoot, chunk.config_path) : null;
    if (artifactReader === null) {
      assertNoSymlinkAncestors(reportRoot, chunk.raw_report_path, {
        requireFile: true,
      });
      assertNoSymlinkAncestors(reportRoot, chunk.config_path, {
        requireFile: true,
      });
    }
    const rawValue =
      artifactReader === null
        ? readFileSync(rawPath)
        : await artifactReader({ kind: "raw", result, chunk });
    const configValue =
      artifactReader === null
        ? readFileSync(configPath)
        : await artifactReader({ kind: "config", result, chunk });
    const rawText = Buffer.from(rawValue).toString("utf8");
    const configText = Buffer.from(configValue).toString("utf8");
    if (sha256(rawText) !== chunk.raw_report_sha256) {
      throw new Error(`raw report hash mismatch for ${chunk.chunk_id}`);
    }
    if (sha256(configText) !== chunk.config_sha256) {
      throw new Error(`Stryker config hash mismatch for ${chunk.chunk_id}`);
    }
    const config = JSON.parse(configText);
    const expectedConfig = phase2ChunkConfig({
      strykerBase: committedStrykerBase,
      requirement: {
        tests: result.tests,
        threshold: result.threshold,
      },
      chunk,
      reportPath:
        result.execution_provenance === "isolated_candidate"
          ? reporterPath(
              sourcePathRoot,
              resolve(canonicalReportRoot, expectedRawPath),
            )
          : resolve(canonicalReportRoot, expectedRawPath),
      tempDirName: `.stryker-tmp/phase2/${result.run_id}/${chunk.chunk_id}`,
      vitestConfigPath: result.vitest_config_path,
    });
    if (canonicalJson(config) !== canonicalJson(expectedConfig)) {
      throw new Error(
        `canonical Stryker config mismatch for ${chunk.chunk_id}`,
      );
    }
    const raw = JSON.parse(rawText);
    const rawEntries = Object.entries(raw?.files ?? {});
    if (
      chunk.raw_source_path_sha256 !==
      sha256(canonicalJson(rawEntries.map(([path]) => path).sort())) ||
      chunk.normalized_source_file !== chunk.source_file
    ) {
      throw new Error(`raw source path provenance mismatch for ${chunk.chunk_id}`);
    }
    const entries = rawEntries.map(([path, file]) => [
      normalizeSourcePath(sourcePathRoot, path),
      file,
    ]);
    if (
      entries.length > 1 ||
      (entries.length === 1 && entries[0][0] !== chunk.source_file)
    ) {
      throw new Error(`raw report source mismatch for ${chunk.chunk_id}`);
    }
    const mutants = entries.length === 0 ? [] : (entries[0][1]?.mutants ?? []);
    if (!Array.isArray(mutants)) {
      throw new Error(`raw report mutants are invalid for ${chunk.chunk_id}`);
    }
    if (
      entries.length === 1 &&
      entries[0][1]?.source !== sourceBytes.get(chunk.source_file)
    ) {
      throw new Error(`raw report source bytes mismatch for ${chunk.chunk_id}`);
    }
    const chunkIdentities = [];
    for (const mutant of mutants) {
      assertMutantInChunk(mutant, chunk);
      terminalMutantCounts(
        [mutant],
        `${result.requirement_id}/${chunk.source_file}`,
      );
      const identity = mutantIdentity(chunk.source_file, mutant);
      if (identities.has(identity)) {
        throw new Error(
          `duplicate mutant identity across chunks: ${chunk.chunk_id}`,
        );
      }
      identities.add(identity);
      chunkIdentities.push(identity);
      mutantsByFile.get(chunk.source_file).push(mutant);
    }
    if (
      sha256(canonicalJson(chunkIdentities.sort())) !==
      chunk.mutant_identity_sha256
    ) {
      throw new Error(`raw mutant identity mismatch for ${chunk.chunk_id}`);
    }
    const independentlyInstrumented = await instrumenter.instrument(
      [
        {
          name: chunk.source_file,
          content: sourceBytes.get(chunk.source_file),
          mutate: [
            {
              start: { line: chunk.start_line - 1, column: 0 },
              end: {
                line: chunk.end_line - 1,
                column: Number.MAX_SAFE_INTEGER,
              },
            },
          ],
        },
      ],
      { plugins: null, ignorers: [], excludedMutations: [] },
    );
    const independentIdentities = independentlyInstrumented.mutants
      .map((mutant) => instrumentedMutantIdentity(chunk.source_file, mutant))
      .sort();
    if (
      canonicalJson(independentIdentities) !== canonicalJson(chunkIdentities)
    ) {
      throw new Error(
        `independent mutant identity mismatch for ${chunk.chunk_id}`,
      );
    }
  }

  const aggregate = emptyCounts();
  const perFile = {};
  for (const sourceFile of result.sources) {
    const counts = terminalMutantCounts(
      mutantsByFile.get(sourceFile),
      `${result.requirement_id}/${sourceFile}`,
    );
    addCounts(aggregate, counts);
    perFile[sourceFile] = { ...counts, score: scoreFromCounts(counts) };
  }
  if (canonicalJson(perFile) !== canonicalJson(result.per_file)) {
    throw new Error("mutation per-file metrics do not match raw reports");
  }
  if (
    canonicalJson(aggregate) !== canonicalJson(result.counts) ||
    scoreFromCounts(aggregate) !== result.score
  ) {
    throw new Error("mutation aggregate metrics do not match raw reports");
  }
  if (
    sha256(canonicalJson([...identities].sort())) !==
    result.mutant_identity_sha256
  ) {
    throw new Error("mutation aggregate identity does not match raw reports");
  }
  return {
    ok: true,
    mutantCount: aggregate.total,
    files: result.sources.length,
  };
}

export function computePhase2MutationConfigurationHash(
  repositoryRoot = DEFAULT_PHASE2_MUTATION_ROOT,
  commitSha = runTrustedGit(repositoryRoot, ["rev-parse", "HEAD"]).trim(),
) {
  const hash = createHash("sha256");
  for (const path of PHASE2_MUTATION_AUTHORITY_PATHS) {
    hash.update(path);
    hash.update("\0");
    hash.update(readCommittedRegularBlob(repositoryRoot, commitSha, path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const repositoryIdentity = (repositoryRoot, requireClean) => {
  const commitSha = runTrustedGit(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  const treeSha = runTrustedGit(repositoryRoot, [
    "rev-parse",
    "HEAD^{tree}",
  ]).trim();
  const status = runTrustedGit(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).trim();
  if (requireClean && status !== "") {
    throw new Error(
      "full Phase 2 mutation requires a clean committed worktree",
    );
  }
  return { commitSha, treeSha, worktreeSha256: sha256(status) };
};

export async function runPhase2Mutation({
  repositoryRoot = DEFAULT_PHASE2_MUTATION_ROOT,
  target = "phase2",
  reportRoot = DEFAULT_REPORT_ROOT,
} = {}) {
  const root = resolve(repositoryRoot);
  const identity = repositoryIdentity(root, false);
  await validatePhase2RepositorySnapshot({
    repositoryRoot: root,
    commitSha: identity.commitSha,
    requiredPaths: PHASE2_MUTATION_AUTHORITY_PATHS,
  });
  const authority = loadPhase2MutationAuthority({ repositoryRoot: root });
  const resolvedTarget = resolvePhase2MutationTarget(target, authority);
  const readiness = inspectPhase2MutationReadiness({
    authority,
    repositoryRoot: root,
  });
  const configurationHash = computePhase2MutationConfigurationHash(
    root,
    identity.commitSha,
  );
  const results = [];
  if (target === "phase2" && !readiness.ok) {
    const report = buildPhase2MutationReport({
      authority,
      target,
      commitSha: identity.commitSha,
      treeSha: identity.treeSha,
      configurationHash,
      results,
    });
    report.readiness = readiness;
    report.blockers = readiness.blockers;
    report.status = "FAIL";
    writeJsonAtomically(join(reportRoot, "draft-report.json"), report);
    return report;
  }

  const selected =
    target === "phase2" ? authority.requirements : [resolvedTarget];
  if (target === "phase2") repositoryIdentity(root, true);
  const snapshotPaths = collectPhase2MutationSnapshotPaths({
    requirements: selected,
    vitestConfigPath: "vitest.mutation.config.ts",
  });
  const initialSnapshot = await validatePhase2RepositorySnapshot({
    repositoryRoot: root,
    commitSha: identity.commitSha,
    requiredPaths: snapshotPaths,
  });
  const candidateRunId = randomUUID();
  const candidateContext = {
    candidateRunId,
    snapshotSha256: initialSnapshot.snapshotSha256,
    isolationMechanism: "candidate_unattested",
    batchSha256: sha256(
      canonicalJson({
        candidate_run_id: candidateRunId,
        commit_sha: identity.commitSha,
        tree_sha: identity.treeSha,
        snapshot_sha256: initialSnapshot.snapshotSha256,
        isolation_mechanism: "candidate_unattested",
        configuration_hash: configurationHash,
        registry_sha256: authority.registrySha256,
        manifest_sha256: authority.manifestSha256,
        requirement_ids: selected.map((requirement) => requirement.id),
      }),
    ),
  };
  for (const requirement of selected) {
    const result = await executePhase2RequirementMutation({
      repositoryRoot: root,
      requirement,
      commitSha: identity.commitSha,
      treeSha: identity.treeSha,
      registrySha256: authority.registrySha256,
      manifestSha256: authority.manifestSha256,
      phase1MutationSha256: authority.phase1MutationSha256,
      configurationHash,
      strykerExecutable: join(root, "node_modules/.bin/stryker"),
      vitestConfigPath: "vitest.mutation.config.ts",
      reportRoot,
      candidateContext: target === "phase2" ? candidateContext : null,
    });
    await validatePhase2MutationArtifacts({
      repositoryRoot: root,
      reportRoot,
      result,
    });
    results.push(result);
  }
  if (target === "phase2") {
    const finalIdentity = repositoryIdentity(root, true);
    if (finalIdentity.commitSha !== identity.commitSha) {
      throw new Error("repository commit changed during Phase 2 mutation run");
    }
    if (finalIdentity.treeSha !== identity.treeSha) {
      throw new Error("repository tree changed during Phase 2 mutation run");
    }
    const finalSnapshot = await validatePhase2RepositorySnapshot({
      repositoryRoot: root,
      commitSha: finalIdentity.commitSha,
      requiredPaths: snapshotPaths,
    });
    if (finalSnapshot.snapshotSha256 !== initialSnapshot.snapshotSha256) {
      throw new Error("Phase 2 mutation inputs changed during the run");
    }
  }
  const report = buildPhase2MutationReport({
    authority,
    target,
    commitSha: identity.commitSha,
    treeSha: identity.treeSha,
    configurationHash,
    results,
  });
  const errors = validatePhase2MutationReport(report, authority);
  if (errors.length > 0) {
    report.status = "FAIL";
    report.evidence_eligible = false;
    for (const result of results) result.evidence_eligible = false;
    report.errors = validatePhase2MutationReport(report, authority);
  }
  const reportName =
    target === "phase2" ? "candidate-report.json" : `${target}.json`;
  writeJsonAtomically(
    join(reportRoot, reportName),
    report,
  );
  return report;
}

const isMain =
  process.argv[1] !== undefined &&
  existsSync(resolve(process.argv[1])) &&
  realpathSync(resolve(process.argv[1])) === realpathSync(resolve(scriptPath));
if (isMain) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write(
      "usage: node scripts/run-phase2-mutation.mjs <phase2|AH-REQUIREMENT-ID>\n",
    );
    process.exitCode = 1;
  } else {
    try {
      const report = await runPhase2Mutation({ target });
      const path =
        target === "phase2"
          ? (report.readiness ? "draft-report.json" : "candidate-report.json")
          : `${target}.json`;
      const bytes = readFileSync(join(DEFAULT_REPORT_ROOT, path));
      process.stdout.write(
        `${JSON.stringify({ batch_sha256: null, report_sha256: sha256(bytes), path, status: report.status })}\n`,
      );
      process.exitCode = report.status === "PASS" ? 0 : 1;
    } catch (error) {
      process.stderr.write(
        `Phase 2 mutation FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
