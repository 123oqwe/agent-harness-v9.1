#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Instrumenter } from "@stryker-mutator/instrumenter";

import { strykerBase } from "../mutation/stryker.base.mjs";
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
import { readTrustedGitBlob, runTrustedGit } from "./trusted-git.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const DEFAULT_REPORT_ROOT = resolve(
  scriptDirectory,
  "../reports/mutation/phase2",
);
const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
const PHASE2_MUTATION_AUTHORITY_FILES = Object.freeze([
  "mutation/phase2-modules.mjs",
  "mutation/modules.mjs",
  "mutation/stryker.base.mjs",
  "verification/gates/phase2-gate.json",
  "scripts/gates/phase2-mutation.mjs",
  "scripts/run-phase2-mutation.mjs",
  "scripts/run-process-tree.mjs",
  "package.json",
  "package-lock.json",
  "patches/@stryker-mutator+core+9.6.1.patch",
  "patches/@stryker-mutator+vitest-runner+9.6.1.patch",
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

const atomicWriteJson = (path, value) => {
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

export function planPhase2MutationChunks(requirement, repositoryRoot) {
  const chunks = [];
  for (const sourceFile of [...requirement.sources].sort()) {
    const source = readFileSync(join(repositoryRoot, sourceFile), "utf8");
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

const phase2ChunkConfig = ({
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
}) => {
  const chunkRoot = join(runRoot, requirement.id, "chunks", chunk.chunk_id);
  const rawReportPath = join(chunkRoot, "mutation.json");
  const configPath = join(chunkRoot, "stryker.config.json");
  const config = phase2ChunkConfig({
    requirement,
    chunk,
    reportPath: rawReportPath,
    tempDirName: `.stryker-tmp/phase2/${runId}/${chunk.chunk_id}`,
    vitestConfigPath,
  });
  atomicWriteJson(configPath, config);
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
  const rawText = readFileSync(rawReportPath, "utf8");
  const raw = JSON.parse(rawText);
  const entries = Object.entries(raw?.files ?? {}).map(([path, file]) => [
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
      raw_report_path: relative(reportRoot, rawReportPath).replaceAll(
        "\\",
        "/",
      ),
      config_path: relative(reportRoot, configPath).replaceAll("\\", "/"),
      raw_report_sha256: sha256(rawText),
      config_sha256: sha256(readFileSync(configPath)),
      mutant_identity_sha256: sha256(canonicalJson(identities.sort())),
    },
    mutants,
  };
};

export async function runPhase2RequirementDiagnostic({
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
}) {
  if (!SHA_40.test(commitSha ?? ""))
    throw new Error("diagnostic requires exact commit SHA");
  if (!SHA_40.test(treeSha ?? ""))
    throw new Error("diagnostic requires exact tree SHA");
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
  for (const path of [
    ...requirement.sources,
    ...(requirement.integrationSources ?? []),
    ...requirement.tests,
    vitestConfigPath,
  ]) {
    if (!existsSync(join(repositoryRoot, path))) {
      throw new Error(`diagnostic input is missing: ${path}`);
    }
  }
  const runId = `${requirement.id.toLowerCase()}-${randomUUID()}`;
  const runRoot = join(reportRoot, "runs", runId);
  const chunks = planPhase2MutationChunks(requirement, repositoryRoot);
  if (chunks.length === 0)
    throw new Error("diagnostic mutation chunk set is empty");
  const perFileMutants = new Map(
    requirement.sources.map((source) => [source, []]),
  );
  const identities = new Set();
  const chunkResults = [];
  try {
    for (const chunk of chunks) {
      const executed = await runChunk({
        repositoryRoot,
        requirement,
        chunk,
        runId,
        runRoot,
        reportRoot,
        strykerExecutable,
        vitestConfigPath,
        timeoutMs,
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
    return {
      requirement_id: requirement.id,
      mutation_class: requirement.mutationClass,
      threshold: requirement.threshold,
      status:
        aggregate.total > 0 && score >= requirement.threshold && allFilesPass
          ? "PASS"
          : "FAIL",
      evidence_eligible: false,
      synthetic_fixture: true,
      commit_sha: commitSha,
      tree_sha: treeSha,
      registry_sha256: registrySha256,
      manifest_sha256: manifestSha256,
      phase1_mutation_registry_sha256: phase1MutationSha256,
      configuration_hash: configurationHash,
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
  } finally {
    rmSync(join(repositoryRoot, ".stryker-tmp", "phase2", runId), {
      recursive: true,
      force: true,
    });
  }
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

const readCommittedRegularBlob = (repositoryRoot, commitSha, relativePath) => {
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

export async function validatePhase2MutationArtifacts({
  repositoryRoot,
  reportRoot,
  result,
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
  const sourceBytes = new Map(
    result.sources.map((sourceFile) => [
      sourceFile,
      readCommittedRegularBlob(
        repositoryRoot,
        result.commit_sha,
        sourceFile,
      ).toString("utf8"),
    ]),
  );
  for (const integrationSource of result.integration_sources ?? []) {
    readCommittedRegularBlob(
      repositoryRoot,
      result.commit_sha,
      integrationSource,
    );
  }
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
    const rawPath = resolveArtifactPath(reportRoot, chunk.raw_report_path);
    const configPath = resolveArtifactPath(reportRoot, chunk.config_path);
    const rawText = readFileSync(rawPath, "utf8");
    const configText = readFileSync(configPath, "utf8");
    if (sha256(rawText) !== chunk.raw_report_sha256) {
      throw new Error(`raw report hash mismatch for ${chunk.chunk_id}`);
    }
    if (sha256(configText) !== chunk.config_sha256) {
      throw new Error(`Stryker config hash mismatch for ${chunk.chunk_id}`);
    }
    const config = JSON.parse(configText);
    if (
      canonicalJson(config.mutate) !==
        canonicalJson([
          `${chunk.source_file}:${chunk.start_line}-${chunk.end_line}`,
        ]) ||
      canonicalJson(config.testFiles) !== canonicalJson(result.tests) ||
      config.thresholds?.high !== result.threshold ||
      config.thresholds?.break !== null
    ) {
      throw new Error(
        `Stryker config authority mismatch for ${chunk.chunk_id}`,
      );
    }
    const raw = JSON.parse(rawText);
    const entries = Object.entries(raw?.files ?? {}).map(([path, file]) => [
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
) {
  const hash = createHash("sha256");
  for (const path of PHASE2_MUTATION_AUTHORITY_FILES) {
    const absolute = join(repositoryRoot, path);
    if (!existsSync(absolute))
      throw new Error(`mutation authority missing: ${path}`);
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(absolute));
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
  const authority = loadPhase2MutationAuthority({ repositoryRoot: root });
  const resolvedTarget = resolvePhase2MutationTarget(target, authority);
  const readiness = inspectPhase2MutationReadiness({
    authority,
    repositoryRoot: root,
  });
  const identity = repositoryIdentity(
    root,
    target === "phase2" && readiness.ok,
  );
  const configurationHash = computePhase2MutationConfigurationHash(root);
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
    atomicWriteJson(join(reportRoot, "mutation.json"), report);
    return report;
  }

  const selected =
    target === "phase2" ? authority.requirements : [resolvedTarget];
  for (const requirement of selected) {
    const result = await runPhase2RequirementDiagnostic({
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
    });
    await validatePhase2MutationArtifacts({
      repositoryRoot: root,
      reportRoot,
      result,
    });
    result.synthetic_fixture = false;
    result.evidence_eligible = false;
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
    report.errors = errors;
  }
  for (const result of results) {
    result.evidence_eligible = report.evidence_eligible;
  }
  atomicWriteJson(
    join(reportRoot, target === "phase2" ? "mutation.json" : `${target}.json`),
    report,
  );
  return report;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(scriptPath);
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
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.status === "PASS" ? 0 : 1;
    } catch (error) {
      process.stderr.write(
        `Phase 2 mutation FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
