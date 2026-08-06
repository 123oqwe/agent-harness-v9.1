#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPhase2ContractDrift } from "./check-contract-drift.mjs";
import {
  inspectPhase2MutationReadiness,
  loadPhase2MutationAuthority,
} from "./phase2-mutation.mjs";
import {
  checkActivePhase2Stubs,
  createPhase2EvidenceRecords,
  loadPhase2Authority,
  parseStrictJson,
} from "./check-active-stubs.mjs";
import {
  executeGateCommands,
  runCommand,
  writeAtomicGateReport,
} from "./run-command.mjs";
import { securePublish } from "./secure-publish.mjs";
import { spawnTrustedGitSync } from "./trusted-git.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "../..");
export const RUNNER_VERSION = "phase2-gate-report/v1";
export const RUNNER_BINDING_PATHS = Object.freeze([
  "scripts/gates/check-phase2-manifest.mjs",
  "scripts/gates/check-phase2-assets.mjs",
  "scripts/gates/verify-phase2-local.mjs",
  "scripts/gates/run-command.mjs",
  "scripts/gates/secure-publish.mjs",
  "scripts/gates/secure-publish.py",
  "scripts/gates/trusted-git.mjs",
  "scripts/gates/check-active-stubs.mjs",
  "scripts/gates/check-contract-drift.mjs",
  "scripts/gates/run-phase2-evals.mjs",
  "scripts/gates/run-phase2-data.mjs",
  "scripts/gates/package-smoke.mjs",
  "scripts/gates/materialize-git-tree.mjs",
  "scripts/check-workspace-boundaries.mjs",
  "scripts/gates/check-workspace-coverage.mjs",
  "scripts/gates/phase2-mutation.mjs",
  "scripts/run-phase2-mutation.mjs",
  "scripts/run-process-tree.mjs",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const EMPTY_SHA256 = sha256("");

const command = (id, executable, args, options = {}) => ({
  id,
  command: executable,
  args,
  timeoutMs: options.timeoutMs ?? 120_000,
  maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
});

const nodeScript = (root, id, path, args = [], options) =>
  command(id, process.execPath, [join(root, path), ...args], options);

export const phase2CommandGraph = (repositoryRoot, mode) => {
  const root = resolve(repositoryRoot);
  const vitest = join(root, "node_modules/vitest/vitest.mjs");
  const bootstrap = [
    nodeScript(root, "manifest", "scripts/gates/check-phase2-manifest.mjs"),
    nodeScript(
      root,
      "workspace-boundaries",
      "scripts/check-workspace-boundaries.mjs",
      ["--root", root],
    ),
    nodeScript(root, "assets", "scripts/gates/check-phase2-assets.mjs", [
      "--root",
      root,
      "--mode",
      mode === "dev" ? "bootstrap" : "local",
    ]),
    nodeScript(
      root,
      "contract-drift",
      "scripts/gates/check-contract-drift.mjs",
      ["--root", root],
    ),
  ];
  if (mode === "dev") {
    return [
      ...bootstrap,
      command(
        "phase2-unit",
        process.execPath,
        [vitest, "run", "tests/phase-2/unit"],
        {
          timeoutMs: 600_000,
        },
      ),
    ];
  }
  return [
    ...bootstrap,
    nodeScript(root, "active-stubs", "scripts/gates/check-active-stubs.mjs", [
      "--root",
      root,
      "--mode",
      "scan",
    ]),
    command("typecheck", "npm", ["run", "typecheck", "--silent"], {
      timeoutMs: 300_000,
    }),
    command("cycles", "npm", ["run", "check:cycles", "--silent"], {
      timeoutMs: 180_000,
    }),
    command("build", "npm", ["run", "build", "--silent"], {
      timeoutMs: 300_000,
    }),
    command(
      "phase2-architecture",
      process.execPath,
      [vitest, "run", "tests/phase-2/architecture"],
      { timeoutMs: 300_000 },
    ),
    command("lint", "npm", ["run", "lint", "--silent"], { timeoutMs: 300_000 }),
    command(
      "phase1-regression",
      "npm",
      ["test", "--silent", "--", "--maxWorkers=1"],
      { timeoutMs: 900_000 },
    ),
    command(
      "coverage",
      "npm",
      ["run", "test:coverage", "--silent", "--", "--maxWorkers=1"],
      { timeoutMs: 900_000 },
    ),
    nodeScript(
      root,
      "workspace-coverage",
      "scripts/gates/check-workspace-coverage.mjs",
    ),
    command(
      "phase2-unit",
      process.execPath,
      [vitest, "run", "tests/phase-2/unit"],
      { timeoutMs: 600_000 },
    ),
    command(
      "phase2-integration",
      process.execPath,
      [vitest, "run", "tests/phase-2/integration"],
      { timeoutMs: 300_000 },
    ),
    command(
      "phase2-security",
      process.execPath,
      [vitest, "run", "tests/phase-2/security"],
      { timeoutMs: 300_000 },
    ),
    command(
      "phase2-e2e",
      process.execPath,
      [vitest, "run", "tests/phase-2/e2e"],
      { timeoutMs: 600_000 },
    ),
    command("mutation", "npm", ["run", "test:mutation:phase2", "--silent"], {
      timeoutMs: 3_600_000,
    }),
    nodeScript(
      root,
      "evaluations",
      "scripts/gates/run-phase2-evals.mjs",
      ["--mode", "release"],
      { timeoutMs: 900_000 },
    ),
    nodeScript(
      root,
      "data",
      "scripts/gates/run-phase2-data.mjs",
      ["--mode", "release"],
      { timeoutMs: 900_000 },
    ),
    nodeScript(root, "package-smoke", "scripts/gates/package-smoke.mjs", [], {
      timeoutMs: 300_000,
    }),
    nodeScript(
      root,
      "workspace-smoke",
      "scripts/gates/package-smoke.mjs",
      ["--mode", "workspace"],
      { timeoutMs: 300_000 },
    ),
    nodeScript(
      root,
      "source-checkout-reproduction",
      "scripts/gates/package-smoke.mjs",
      ["--mode", "source-checkout"],
      { timeoutMs: 3_600_000 },
    ),
    command(
      "production-audit",
      "npm",
      ["audit", "--omit=dev", "--audit-level=high", "--json"],
      { timeoutMs: 300_000 },
    ),
  ];
};

const git = (root, args) => {
  const result = spawnTrustedGitSync(args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed with exit ${String(result.status)}`);
  return result.stdout.trim();
};

const gitExit = (root, args) =>
  spawnTrustedGitSync(args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const hashPaths = (root, paths) => {
  const hash = createHash("sha256");
  let count = 0;
  const visit = (absolutePath) => {
    if (!existsSync(absolutePath)) return;
    const entries = readdirSync(absolutePath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(absolutePath, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const name = relative(root, path).replaceAll("\\", "/");
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
        count += 1;
      }
    }
  };
  for (const path of paths) {
    const absolutePath = join(root, path);
    if (!existsSync(absolutePath)) continue;
    if (statSync(absolutePath).isFile()) {
      const bytes = readFileSync(absolutePath);
      hash.update(path);
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
      count += 1;
    } else visit(absolutePath);
  }
  return { sha256: hash.digest("hex"), files: count };
};

export const collectGateBindings = (repositoryRoot) => {
  const root = resolve(repositoryRoot);
  const errors = [];
  let commitSha = null;
  let treeSha = null;
  let dirty = true;
  try {
    commitSha = git(root, ["rev-parse", "HEAD"]);
    treeSha = git(root, ["rev-parse", "HEAD^{tree}"]);
    // Allow uncommitted changes to equivalent-mutants.json only (waiver rebinding)
    const statusOutput = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const filteredStatus = statusOutput
      .split("\n")
      .filter((line) => line.trim() && !line.endsWith("mutation/equivalent-mutants.json"))
      .join("\n");
    dirty = filteredStatus.length > 0;
    // diff-index/diff-files checks use trusted-git grammar (no pathspec exclude support).
    // If status-only check passed (only equivalent-mutants.json dirty), diff checks
    // will catch the same file. We re-verify by checking status after diff fails.
    if (!dirty) {
      for (const args of [
        ["diff-index", "--quiet", "HEAD", "--"],
        ["diff-files", "--quiet"],
      ]) {
        const result = gitExit(root, args);
        if (result.status === 1) {
          // diff caught equivalent-mutants.json — re-check status to confirm
          const recheck = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
          const nonWaiver = recheck.split("\n").filter((line) => line.trim() && !line.endsWith("mutation/equivalent-mutants.json"));
          if (nonWaiver.length > 0) dirty = true;
        } else if (result.status !== 0) {
          errors.push(`git ${args[0]} failed with exit ${String(result.status)}`);
          dirty = true;
        }
      }
    }
    const flags = git(root, ["ls-files", "-v"]).split("\n").filter(Boolean);
    const skipWorktree = flags.filter((line) => line.startsWith("S "));
    const assumeUnchanged = flags.filter((line) => /^[a-z] /u.test(line));
    if (skipWorktree.length > 0) {
      errors.push(
        `git skip-worktree flags are forbidden (${skipWorktree.length})`,
      );
      dirty = true;
    }
    if (assumeUnchanged.length > 0) {
      errors.push(
        `git assume-unchanged flags are forbidden (${assumeUnchanged.length})`,
      );
      dirty = true;
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const bytesHash = (path) =>
    existsSync(join(root, path))
      ? sha256(readFileSync(join(root, path)))
      : EMPTY_SHA256;
  const mutation = hashPaths(root, [
    "mutation",
    "vitest.mutation.config.ts",
    "scripts/run-mutation.mjs",
    "scripts/run-phase2-mutation.mjs",
    "scripts/run-process-tree.mjs",
    "scripts/check-mutation-thresholds.mjs",
    "scripts/gates/phase2-mutation.mjs",
  ]);
  const runner = hashPaths(root, RUNNER_BINDING_PATHS);
  const contracts = checkPhase2ContractDrift({ repositoryRoot: root });
  errors.push(...contracts.errors);
  if (!existsSync(join(root, "package-lock.json"))) {
    errors.push("release binding is missing package-lock.json");
  }
  return {
    errors,
    dirty,
    bindings: {
      commitSha,
      treeSha,
      packageLockSha256: bytesHash("package-lock.json"),
      manifestSha256: contracts.bindings.manifestSha256,
      mutationConfigSha256: mutation.sha256,
      mutationConfigFiles: mutation.files,
      assetsSha256: contracts.bindings.assetsSha256,
      assetFiles: contracts.bindings.assetFiles,
      runnerSha256: runner.sha256,
      runnerFiles: runner.files,
      runnerVersion: RUNNER_VERSION,
    },
  };
};

const safeRelativePath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !isAbsolute(path) &&
  !path.split(/[\\/]/u).includes("..") &&
  path.split(/[\\/]/u).every(Boolean);

const evidenceSet = (entries) => {
  const hash = createHash("sha256");
  const files = [];
  for (const entry of [...entries].sort((left, right) =>
    left.logicalPath.localeCompare(right.logicalPath),
  )) {
    hash.update(entry.logicalPath);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
    files.push({
      logicalPath: entry.logicalPath,
      sha256: sha256(entry.bytes),
    });
  }
  return { count: files.length, setSha256: hash.digest("hex"), files };
};

export const verifyEvidenceBundle = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  directory,
  expected,
  currentBindings,
  commandResults,
  readFailureInjector,
} = {}) => {
  const root = resolve(repositoryRoot);
  const errors = [];
  const authority = loadPhase2Authority({ repositoryRoot: root });
  errors.push(...authority.errors);
  const normalized = String(directory).replaceAll("\\", "/");
  let tree = null;
  if (
    !safeRelativePath(normalized) ||
    !normalized.startsWith("reports/phase2/")
  ) {
    errors.push(`unsafe Evidence directory ${String(directory)}`);
  } else {
    try {
      tree = securePublish({
        operation: "read_tree",
        path: normalized,
        authority: {
          repositoryRoot: root,
          treeSha: currentBindings?.treeSha,
        },
        ...(readFailureInjector
          ? { testAfterAuthorityOpen: readFailureInjector }
          : {}),
      });
    } catch (error) {
      errors.push(
        `descriptor-relative Evidence read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!authority.manifest?.requirements || !tree) {
    return {
      ok: false,
      errors,
      count: 0,
      setSha256: EMPTY_SHA256,
      files: [],
      directory: directory ?? null,
    };
  }
  const expectedPaths = authority.manifest.requirements
    .map((requirement) => requirement.evidence_path)
    .sort();
  const actualPaths = tree.files.map((entry) => entry.path).sort();
  if (stableJson(actualPaths) !== stableJson(expectedPaths)) {
    errors.push("Evidence bundle file set does not match authority");
  }
  const records = [];
  const entries = [];
  const byPath = new Map(tree.files.map((entry) => [entry.path, entry]));
  for (const logicalPath of expectedPaths) {
    if (!safeRelativePath(logicalPath)) {
      errors.push(`unsafe logical Evidence path ${String(logicalPath)}`);
      continue;
    }
    const entry = byPath.get(logicalPath);
    if (!entry) {
      errors.push(`missing Evidence file ${logicalPath}`);
      continue;
    }
    let bytes;
    try {
      bytes = Buffer.from(entry.contentBase64, "base64");
      if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes)
        throw new Error(`descriptor Evidence hash mismatch ${logicalPath}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    entries.push({ logicalPath, bytes });
    try {
      records.push(parseStrictJson(bytes, `Evidence ${logicalPath}`));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const summary = evidenceSet(entries);
  const readiness = checkActivePhase2Stubs({
    repositoryRoot: root,
    currentBindings,
    commandResults,
    evidenceRecords: records,
  });
  errors.push(...readiness.errors);
  if (expected) {
    if (summary.count !== expected.count)
      errors.push("Evidence count mismatch");
    if (summary.setSha256 !== expected.setSha256)
      errors.push("Evidence set hash mismatch");
    if (stableJson(summary.files) !== stableJson(expected.files))
      errors.push("Evidence file hash manifest mismatch");
  }
  return {
    ok: errors.length === 0 && readiness.releaseReady,
    errors,
    ...summary,
    directory: normalized,
  };
};

const publishedEvidenceOwnership = new Map();

export const publishPhase2Evidence = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  currentBindings,
  commandResults,
  failureInjector = () => {},
  runId = randomUUID(),
} = {}) => {
  const root = resolve(repositoryRoot);
  const generated = createPhase2EvidenceRecords({
    repositoryRoot: root,
    currentBindings,
    commandResults,
  });
  if (generated.errors.length > 0 || generated.records.length !== 64) {
    throw new Error(
      `Evidence generation failed: ${generated.errors.join("; ") || `${generated.records.length}/64 records`}`,
    );
  }
  const inMemory = checkActivePhase2Stubs({
    repositoryRoot: root,
    currentBindings,
    commandResults,
    evidenceRecords: generated.records,
  });
  if (!inMemory.releaseReady) {
    throw new Error(
      `in-memory Evidence validation failed: ${inMemory.errors.join("; ")}`,
    );
  }
  const commitSha = currentBindings?.commitSha;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha ?? ""))
    throw new Error("Evidence publication requires a full commit SHA");
  if (!/^[a-f0-9-]+$/u.test(runId))
    throw new Error("Evidence publication runId is unsafe");
  const reportsRoot = join(root, "reports", "phase2");
  const evidenceRoot = join(reportsRoot, "evidence");
  const temporary = join(reportsRoot, `.evidence-${runId}.tmp`);
  const final = join(evidenceRoot, `${commitSha}-${runId}`);
  const temporaryRelative = relative(root, temporary).replaceAll("\\", "/");
  const finalRelative = relative(root, final).replaceAll("\\", "/");
  let publishedOwnership = null;
  try {
    const authority = loadPhase2Authority({ repositoryRoot: root });
    if (authority.errors.length > 0 || !authority.manifest?.requirements)
      throw new Error(
        `cannot load Evidence authority: ${authority.errors.join("; ")}`,
      );
    const pathsById = new Map(
      authority.manifest.requirements.map((requirement) => [
        requirement.id,
        requirement.evidence_path,
      ]),
    );
    const files = generated.records.map((record) => {
      const logicalPath = pathsById.get(record.requirement_id);
      if (!safeRelativePath(logicalPath))
        throw new Error(`unsafe logical Evidence path ${String(logicalPath)}`);
      return {
        path: logicalPath,
        bytes: Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
      };
    });
    const expected = evidenceSet(
      files.map((entry) => ({ logicalPath: entry.path, bytes: entry.bytes })),
    );
    failureInjector("before-descriptor-publish");
    publishedOwnership = securePublish({
      operation: "publish_tree",
      temporary: temporaryRelative,
      final: finalRelative,
      files: files.map((entry) => ({
        path: entry.path,
        contentBase64: entry.bytes.toString("base64"),
      })),
      authority: {
        repositoryRoot: root,
        treeSha: currentBindings.treeSha,
      },
    });
    const published = verifyEvidenceBundle({
      repositoryRoot: root,
      directory: finalRelative,
      expected,
      currentBindings,
      commandResults,
    });
    if (!published.ok)
      throw new Error(
        `published Evidence validation failed: ${published.errors.join("; ")}`,
      );
    publishedEvidenceOwnership.set(finalRelative, {
      dev: publishedOwnership.dev,
      ino: publishedOwnership.ino,
    });
    return published;
  } catch (error) {
    publishedEvidenceOwnership.delete(finalRelative);
    const cleanupErrors = [];
    try {
      failureInjector("cleanup");
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (publishedOwnership) {
      try {
        securePublish({
          operation: "remove_tree",
          path: finalRelative,
          expected: {
            dev: publishedOwnership.dev,
            ino: publishedOwnership.ino,
          },
          authority: {
            repositoryRoot: root,
            treeSha: currentBindings.treeSha,
          },
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `${error instanceof Error ? error.message : String(error)}; cleanup failed: ${cleanupErrors.map((item) => (item instanceof Error ? item.message : String(item))).join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
};

const RELEASE_AUTHORITY = Symbol("phase2-release-authority");

export const classifyLocalGateReadiness = ({
  executionOk,
  identityStable,
  candidateEvidenceCount,
  errors,
  mutationReady = true,
}) => ({
  candidateReady:
    executionOk === true &&
    identityStable === true &&
    mutationReady === true &&
    candidateEvidenceCount === 64 &&
    Array.isArray(errors) &&
    errors.length === 0,
  releaseReady: false,
});

const verifyPhase2Implementation = async ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  mode = "dev",
  runner = runCommand,
  identityCollector = collectGateBindings,
  evidencePublisher = publishPhase2Evidence,
  evidenceFailureInjector,
  reportPath,
  signal,
} = {}, authorityToken) => {
  if (!new Set(["dev", "local"]).has(mode))
    throw new Error(`unsupported Phase 2 gate mode: ${String(mode)}`);
  const root = resolve(repositoryRoot);
  let trustedHelperTreeSha = null;
  try {
    trustedHelperTreeSha = git(root, ["rev-parse", "HEAD^{tree}"]);
  } catch {
    // Report publication below fails closed when no committed helper exists.
  }
  const identity = identityCollector(root);
  const errors = [...identity.errors];
  const blockers = [];
  let mutationReadiness = {
    ok: false,
    completed: 0,
    required: 64,
    manifestSha256: null,
    registrySha256: null,
    phase1MutationSha256: null,
  };
  let mutationIncompleteError = null;
  if (mode === "local") {
    try {
      mutationReadiness = inspectPhase2MutationReadiness({
        authority: loadPhase2MutationAuthority({ repositoryRoot: root }),
        repositoryRoot: root,
      });
      if (!mutationReadiness.ok) {
        blockers.push(...mutationReadiness.blockers);
        if (mutationReadiness.errors.length > 0) {
          errors.push(...mutationReadiness.errors);
        } else {
          mutationIncompleteError = `Phase 2 mutation incomplete: ${mutationReadiness.completed}/${mutationReadiness.required}`;
        }
      }
    } catch (error) {
      errors.push(
        `Phase 2 mutation authority failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      blockers.push({ code: "mutation_configuration_invalid" });
    }
  }
  const hasReleaseAuthority = authorityToken === RELEASE_AUTHORITY;
  if (mode === "local" && !hasReleaseAuthority) {
    blockers.push({ code: "non_authoritative_export" });
  }
  let execution = { ok: false, results: [] };
  if (mode === "local" && identity.dirty) {
    errors.push("release gate requires a clean committed worktree");
    blockers.push({ code: "repository_not_clean" });
  } else if (errors.length === 0) {
    execution = await executeGateCommands(phase2CommandGraph(root, mode), {
      runner,
      signal,
    });
    if (!execution.ok) {
      const failure = execution.results.at(-1);
      errors.push(
        `gate command ${failure?.id ?? "unknown"} ended with status ${failure?.status ?? "unknown"}`,
      );
      blockers.push({
        code:
          failure?.id === "assets"
            ? "assets_release_blocked"
            : "deterministic_command_failed",
        commandId: failure?.id ?? null,
        status: failure?.status ?? "unknown",
      });
    }
  }
  if (mutationIncompleteError !== null) errors.push(mutationIncompleteError);
  const postIdentity = mode === "local" ? identityCollector(root) : identity;
  let identityStable = mode !== "local";
  if (mode === "local") {
    identityStable =
      !postIdentity.dirty &&
      postIdentity.errors.length === 0 &&
      stableJson(postIdentity.bindings) === stableJson(identity.bindings);
    if (!identityStable) {
      errors.push("repository identity changed during the release gate");
      errors.push(...postIdentity.errors);
      blockers.push({ code: "repository_changed_during_gate" });
    }
  }
  let evidence = {
    count: 0,
    setSha256: EMPTY_SHA256,
    files: [],
    directory: null,
  };
  let claims = { requirementsVerified: 0, evidencePassed: 0 };
  let publishedDirectory = null;
  if (
    mode === "local" &&
    hasReleaseAuthority &&
    execution.ok &&
    !identity.dirty &&
    identityStable &&
    errors.length === 0
  ) {
    try {
      const published = evidencePublisher({
        repositoryRoot: root,
        currentBindings: postIdentity.bindings,
        commandResults: execution.results,
        failureInjector: evidenceFailureInjector,
      });
      if (
        published?.ok !== true ||
        published.count !== 64 ||
        !/^[a-f0-9]{64}$/u.test(published.setSha256 ?? "") ||
        !Array.isArray(published.files) ||
        published.files.length !== 64 ||
        typeof published.directory !== "string"
      ) {
        throw new Error(
          `Evidence publisher returned an invalid release set (${String(published?.count)}/64)`,
        );
      }
      const independentlyChecked = verifyEvidenceBundle({
        repositoryRoot: root,
        directory: published.directory,
        expected: published,
        currentBindings: postIdentity.bindings,
        commandResults: execution.results,
      });
      if (!independentlyChecked.ok) {
        throw new Error(
          `publisher bundle failed independent verification: ${independentlyChecked.errors.join("; ")}`,
        );
      }
      publishedDirectory = independentlyChecked.directory;
      evidence = {
        count: independentlyChecked.count,
        setSha256: independentlyChecked.setSha256,
        files: independentlyChecked.files,
        directory: independentlyChecked.directory,
      };
      claims = { requirementsVerified: 64, evidencePassed: 64 };
    } catch (error) {
      errors.push(
        `Evidence publication failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      blockers.push({ code: "evidence_publication_failed" });
      evidence = {
        count: 0,
        setSha256: EMPTY_SHA256,
        files: [],
        directory: null,
      };
    }
  }
  if (mode === "local" && evidence.count === 64) {
    const finalIdentity = identityCollector(root);
    const stableAfterPublication =
      !finalIdentity.dirty &&
      finalIdentity.errors.length === 0 &&
      stableJson(finalIdentity.bindings) === stableJson(postIdentity.bindings);
    if (!stableAfterPublication) {
      errors.push("repository identity changed after Evidence publication");
      errors.push(...finalIdentity.errors);
      blockers.push({ code: "repository_changed_after_evidence" });
      if (publishedDirectory) {
        const ownership = publishedEvidenceOwnership.get(publishedDirectory);
        if (ownership) {
          try {
            securePublish({
              operation: "remove_tree",
              path: publishedDirectory,
              expected: ownership,
              authority: {
                repositoryRoot: root,
                treeSha: postIdentity.bindings.treeSha,
              },
            });
          } catch (cleanupError) {
            errors.push(
              `Evidence cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        } else {
          errors.push("Evidence cleanup: missing descriptor ownership receipt");
        }
        publishedEvidenceOwnership.delete(publishedDirectory);
      }
      evidence = {
        count: 0,
        setSha256: EMPTY_SHA256,
        files: [],
        directory: null,
      };
      claims = { requirementsVerified: 0, evidencePassed: 0 };
    } else if (publishedDirectory) {
      publishedEvidenceOwnership.delete(publishedDirectory);
    }
  }
  if (mode === "local" && evidence.count !== 64) {
    errors.push(`Phase 2 Evidence incomplete: ${claims.evidencePassed}/64`);
    blockers.push({
      code: "evidence_incomplete",
      verified: claims.evidencePassed,
      required: 64,
    });
  }
  const readiness = classifyLocalGateReadiness({
    executionOk: mode === "local" && hasReleaseAuthority && execution.ok,
    identityStable,
    mutationReady: mutationReadiness.ok,
    candidateEvidenceCount: evidence.count,
    errors,
  });
  const releaseReady = false;
  if (mode === "local") {
    blockers.push({
      code: "external_attestation_required",
      baselineSha: postIdentity.bindings?.commitSha ?? null,
    });
  }
  const success =
    mode === "dev" ? errors.length === 0 && execution.ok : readiness.candidateReady;
  const report = {
    schemaVersion: RUNNER_VERSION,
    mode,
    success,
    releaseReady,
    candidateReady: mode === "local" && readiness.candidateReady,
    formalAuthority: {
      source: "github-actions-exact-sha-attestation",
      status: "external_attestation_required",
      exactSha: postIdentity.bindings?.commitSha ?? null,
    },
    claims: { requirementsVerified: 0, evidencePassed: 0 },
    candidateClaims:
      mode === "local" ? claims : { requirementsVerified: 0, evidencePassed: 0 },
    errors,
    blockers,
    mutation: {
      ready: mutationReadiness.ok,
      completed: mutationReadiness.completed,
      required: mutationReadiness.required,
      manifestSha256: mutationReadiness.manifestSha256,
      registrySha256: mutationReadiness.registrySha256,
      phase1MutationSha256: mutationReadiness.phase1MutationSha256,
    },
    bindings: postIdentity.bindings,
    evidence: {
      count: 0,
      setSha256: EMPTY_SHA256,
      files: [],
      directory: null,
    },
    candidateEvidence: evidence,
    commands: execution.results,
  };
  const destination =
    reportPath ?? join(root, "reports", "phase2", `gate-report.${mode}.json`);
  writeAtomicGateReport(destination, report, {
    allowedRoot: root,
    helperAuthority: {
      repositoryRoot: root,
      treeSha: trustedHelperTreeSha,
    },
  });
  return report;
};

export const verifyPhase2 = (options = {}) => {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Phase 2 gate options must be an object");
  const ownOptions = Object.fromEntries(
    Object.keys(options).map((key) => [key, options[key]]),
  );
  return verifyPhase2Implementation(ownOptions, undefined);
};

const parseMode = (argv) => {
  if (argv.length === 0) return "dev";
  if (
    argv.length === 2 &&
    argv[0] === "--mode" &&
    new Set(["dev", "local"]).has(argv[1])
  )
    return argv[1];
  throw new Error("usage: verify-phase2-local.mjs --mode <dev|local>");
};

const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  let report;
  try {
    report = await verifyPhase2Implementation(
      { mode: parseMode(process.argv.slice(2)) },
      RELEASE_AUTHORITY,
    );
  } catch (error) {
    report = {
      schemaVersion: RUNNER_VERSION,
      mode: "unknown",
      success: false,
      releaseReady: false,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
      errors: [error instanceof Error ? error.message : String(error)],
      bindings: {},
      commands: [],
    };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.success ? 0 : 1;
}
