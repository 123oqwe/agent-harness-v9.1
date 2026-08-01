#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPhase2ContractDrift } from "./check-contract-drift.mjs";
import {
  checkActivePhase2Stubs,
  createPhase2EvidenceRecords,
  loadPhase2Authority,
  parseStrictJson,
} from "./check-active-stubs.mjs";
import {
  createSafeCommandEnvironment,
  executeGateCommands,
  runCommand,
  writeAtomicGateReport,
} from "./run-command.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "../..");
export const RUNNER_VERSION = "phase2-gate-report/v1";

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
    nodeScript(root, "assets", "scripts/gates/check-phase2-assets.mjs", [
      "--root",
      root,
      "--mode",
      mode === "dev" ? "bootstrap" : "release",
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
          timeoutMs: 180_000,
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
    command(
      "phase2-unit",
      process.execPath,
      [vitest, "run", "tests/phase-2/unit"],
      { timeoutMs: 300_000 },
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
  const result = spawnSync("git", args, {
    cwd: root,
    env: createSafeCommandEnvironment(),
    shell: false,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed with exit ${String(result.status)}`);
  return result.stdout.trim();
};

const gitExit = (root, args) =>
  spawnSync("git", args, {
    cwd: root,
    env: createSafeCommandEnvironment(),
    shell: false,
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
    dirty =
      git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length >
      0;
    for (const args of [
      ["diff-index", "--quiet", "HEAD", "--"],
      ["diff-files", "--quiet"],
    ]) {
      const result = gitExit(root, args);
      if (result.status === 1) dirty = true;
      else if (result.status !== 0) {
        errors.push(`git ${args[0]} failed with exit ${String(result.status)}`);
        dirty = true;
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
    "scripts/check-mutation-thresholds.mjs",
  ]);
  const runner = hashPaths(root, [
    "scripts/gates/check-phase2-manifest.mjs",
    "scripts/gates/check-phase2-assets.mjs",
    "scripts/gates/verify-phase2-local.mjs",
    "scripts/gates/run-command.mjs",
    "scripts/gates/check-active-stubs.mjs",
    "scripts/gates/check-contract-drift.mjs",
    "scripts/gates/run-phase2-evals.mjs",
    "scripts/gates/run-phase2-data.mjs",
    "scripts/gates/package-smoke.mjs",
  ]);
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

const staysInside = (root, candidate) => {
  const relation = relative(root, candidate);
  return (
    relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`))
  );
};

const directorySnapshot = (path, created = false) => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_DIRECTORY ?? 0),
  );
  const opened = fstatSync(descriptor);
  const named = lstatSync(path);
  if (
    !opened.isDirectory() ||
    named.isSymbolicLink() ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino
  ) {
    closeSync(descriptor);
    throw new Error(`unsafe symlink or changed directory: ${path}`);
  }
  return { path, descriptor, dev: opened.dev, ino: opened.ino, created };
};

const assertDirectorySnapshot = (snapshot) => {
  const opened = fstatSync(snapshot.descriptor);
  const named = lstatSync(snapshot.path);
  if (
    named.isSymbolicLink() ||
    opened.dev !== snapshot.dev ||
    opened.ino !== snapshot.ino ||
    named.dev !== snapshot.dev ||
    named.ino !== snapshot.ino
  ) {
    throw new Error(`directory ownership changed: ${snapshot.path}`);
  }
};

const ensureDirectoryNoFollow = (root, target) => {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (!staysInside(absoluteRoot, absoluteTarget))
    throw new Error(`unsafe directory outside repository: ${absoluteTarget}`);
  const snapshots = [directorySnapshot(absoluteRoot, false)];
  let current = absoluteRoot;
  for (const segment of relative(absoluteRoot, absoluteTarget).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let created = false;
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      created = true;
    }
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`symlink is forbidden in directory path: ${current}`);
    snapshots.push(directorySnapshot(current, created));
  }
  return snapshots;
};

const assertSnapshots = (snapshots) => {
  for (const snapshot of snapshots) assertDirectorySnapshot(snapshot);
};

const closeSnapshots = (snapshots) => {
  for (const snapshot of [...snapshots].reverse()) {
    try {
      closeSync(snapshot.descriptor);
    } catch {
      // Best effort only; no mutation occurs here.
    }
  }
};

const removeOwnedDirectory = (parent, ownership) => {
  if (!ownership) return;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const candidate = join(parent, entry.name);
    const stats = lstatSync(candidate);
    if (
      !stats.isSymbolicLink() &&
      stats.isDirectory() &&
      stats.dev === ownership.dev &&
      stats.ino === ownership.ino
    ) {
      const quarantine = join(parent, `.cleanup-${randomUUID()}`);
      renameSync(candidate, quarantine);
      const quarantined = lstatSync(quarantine);
      if (
        quarantined.isSymbolicLink() ||
        !quarantined.isDirectory() ||
        quarantined.dev !== ownership.dev ||
        quarantined.ino !== ownership.ino
      ) {
        throw new Error(`cleanup ownership changed: ${candidate}`);
      }
      rmSync(quarantine, { recursive: true, force: false });
      fsyncFile(parent);
      return;
    }
  }
};

const secureEvidenceDirectory = (root, directory, errors) => {
  const normalized = String(directory).replaceAll("\\", "/");
  if (
    !safeRelativePath(normalized) ||
    !normalized.startsWith("reports/phase2/")
  ) {
    errors.push(`unsafe Evidence directory ${String(directory)}`);
    return null;
  }
  let current = root;
  for (const segment of normalized.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) {
      errors.push(`missing Evidence directory ${normalized}`);
      return null;
    }
    if (lstatSync(current).isSymbolicLink()) {
      errors.push(`symlink is forbidden in Evidence directory ${normalized}`);
      return null;
    }
  }
  const actualRoot = realpathSync(root);
  const actual = realpathSync(current);
  if (!staysInside(actualRoot, actual) || !statSync(actual).isDirectory()) {
    errors.push(`Evidence directory escapes repository ${normalized}`);
    return null;
  }
  return { absolute: actual, relative: normalized };
};

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

const fsyncFile = (path) => {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const readRegularFileNoFollow = (path) => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    const namedBefore = lstatSync(path);
    if (
      !opened.isFile() ||
      namedBefore.isSymbolicLink() ||
      opened.dev !== namedBefore.dev ||
      opened.ino !== namedBefore.ino
    ) {
      throw new Error(`unsafe or changed regular file: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const namedAfter = lstatSync(path);
    const openedAfter = fstatSync(descriptor);
    if (
      namedAfter.isSymbolicLink() ||
      namedAfter.dev !== openedAfter.dev ||
      namedAfter.ino !== openedAfter.ino
    ) {
      throw new Error(`regular file changed while reading: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const fsyncDirectoryTree = (directory) => {
  const directories = [];
  const visit = (path) => {
    directories.push(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(path, entry.name));
    }
  };
  visit(directory);
  for (const path of directories.reverse()) fsyncFile(path);
};

export const verifyEvidenceBundle = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  directory,
  expected,
  currentBindings,
  commandResults,
} = {}) => {
  const root = resolve(repositoryRoot);
  const errors = [];
  const authority = loadPhase2Authority({ repositoryRoot: root });
  errors.push(...authority.errors);
  const bundle = secureEvidenceDirectory(root, directory, errors);
  if (!authority.manifest?.requirements || !bundle) {
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
  const actualPaths = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(
          `symlink is forbidden in Evidence bundle ${relative(bundle.absolute, child)}`,
        );
      } else if (entry.isDirectory()) visit(child);
      else if (entry.isFile())
        actualPaths.push(
          relative(bundle.absolute, child).replaceAll("\\", "/"),
        );
      else errors.push(`non-file entry in Evidence bundle ${entry.name}`);
    }
  };
  visit(bundle.absolute);
  actualPaths.sort();
  if (stableJson(actualPaths) !== stableJson(expectedPaths)) {
    errors.push("Evidence bundle file set does not match authority");
  }
  const records = [];
  const entries = [];
  for (const logicalPath of expectedPaths) {
    if (!safeRelativePath(logicalPath)) {
      errors.push(`unsafe logical Evidence path ${String(logicalPath)}`);
      continue;
    }
    const absolute = join(bundle.absolute, logicalPath);
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) {
      errors.push(`missing or symlinked Evidence file ${logicalPath}`);
      continue;
    }
    let bytes;
    try {
      bytes = readRegularFileNoFollow(absolute);
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
    directory: bundle.relative,
  };
};

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
  const finalRelative = relative(root, final).replaceAll("\\", "/");
  let renamed = false;
  let reportsSnapshots = [];
  let evidenceSnapshots = [];
  let temporarySnapshots = [];
  let temporaryOwnership = null;
  let evidenceOwnership = null;
  try {
    reportsSnapshots = ensureDirectoryNoFollow(root, reportsRoot);
    evidenceSnapshots = ensureDirectoryNoFollow(root, evidenceRoot);
    evidenceOwnership = evidenceSnapshots.at(-1);
    assertSnapshots([...reportsSnapshots, ...evidenceSnapshots]);
    mkdirSync(temporary, { mode: 0o700 });
    temporarySnapshots = ensureDirectoryNoFollow(root, temporary);
    temporaryOwnership = temporarySnapshots.at(-1);
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
    const writeAt = Math.floor(generated.records.length / 2);
    for (const [index, record] of generated.records.entries()) {
      if (index === writeAt) failureInjector("write");
      assertSnapshots([
        ...reportsSnapshots,
        ...evidenceSnapshots,
        ...temporarySnapshots,
      ]);
      const logicalPath = pathsById.get(record.requirement_id);
      if (!safeRelativePath(logicalPath))
        throw new Error(`unsafe logical Evidence path ${String(logicalPath)}`);
      const path = join(temporary, logicalPath);
      const parentSnapshots = ensureDirectoryNoFollow(root, dirname(path));
      assertSnapshots([...temporarySnapshots, ...parentSnapshots]);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fsyncFile(path);
      closeSnapshots(parentSnapshots);
    }
    failureInjector("validate");
    assertSnapshots([
      ...reportsSnapshots,
      ...evidenceSnapshots,
      ...temporarySnapshots,
    ]);
    const temporaryRelative = relative(root, temporary).replaceAll("\\", "/");
    const checked = verifyEvidenceBundle({
      repositoryRoot: root,
      directory: temporaryRelative,
      currentBindings,
      commandResults,
    });
    if (!checked.ok)
      throw new Error(
        `written Evidence validation failed: ${checked.errors.join("; ")}`,
      );
    fsyncDirectoryTree(temporary);
    if (existsSync(final))
      throw new Error("Evidence version directory already exists");
    failureInjector("rename");
    assertSnapshots([
      ...reportsSnapshots,
      ...evidenceSnapshots,
      ...temporarySnapshots,
    ]);
    renameSync(temporary, final);
    renamed = true;
    fsyncFile(evidenceRoot);
    const published = verifyEvidenceBundle({
      repositoryRoot: root,
      directory: finalRelative,
      expected: checked,
      currentBindings,
      commandResults,
    });
    if (!published.ok)
      throw new Error(
        `published Evidence validation failed: ${published.errors.join("; ")}`,
      );
    closeSnapshots(temporarySnapshots);
    closeSnapshots(evidenceSnapshots);
    closeSnapshots(reportsSnapshots);
    return published;
  } catch (error) {
    const cleanupErrors = [];
    try {
      failureInjector("cleanup");
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      const trustedReports = reportsSnapshots.find(
        (snapshot) => snapshot.path === reportsRoot,
      );
      if (trustedReports) {
        const parent = trustedReports.path;
        const opened = fstatSync(trustedReports.descriptor);
        if (opened.dev === trustedReports.dev && opened.ino === trustedReports.ino) {
          removeOwnedDirectory(parent, temporaryOwnership);
          if (evidenceOwnership?.created)
            removeOwnedDirectory(parent, evidenceOwnership);
        }
      }
      if (renamed && evidenceOwnership) {
        const evidenceParent = evidenceOwnership.path;
        try {
          assertDirectorySnapshot(evidenceOwnership);
          removeOwnedDirectory(evidenceParent, temporaryOwnership);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    closeSnapshots(temporarySnapshots);
    closeSnapshots(evidenceSnapshots);
    closeSnapshots(reportsSnapshots);
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

export const verifyPhase2 = async ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  mode = "dev",
  runner = runCommand,
  identityCollector = collectGateBindings,
  evidencePublisher = publishPhase2Evidence,
  evidenceFailureInjector,
  reportPath,
  signal,
} = {}) => {
  if (!new Set(["dev", "local"]).has(mode))
    throw new Error(`unsupported Phase 2 gate mode: ${String(mode)}`);
  const root = resolve(repositoryRoot);
  const identity = identityCollector(root);
  const errors = [...identity.errors];
  const blockers = [];
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
        const cleanupErrors = [];
        const secured = secureEvidenceDirectory(root, publishedDirectory, cleanupErrors);
        if (secured && cleanupErrors.length === 0) {
          const ownership = directorySnapshot(secured.absolute);
          try {
            removeOwnedDirectory(dirname(secured.absolute), ownership);
          } finally {
            closeSnapshots([ownership]);
          }
        } else {
          errors.push(...cleanupErrors.map((error) => `Evidence cleanup: ${error}`));
        }
      }
      evidence = {
        count: 0,
        setSha256: EMPTY_SHA256,
        files: [],
        directory: null,
      };
      claims = { requirementsVerified: 0, evidencePassed: 0 };
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
  const releaseReady =
    mode === "local" &&
    execution.ok &&
    evidence.count === 64 &&
    errors.length === 0;
  const success =
    mode === "dev" ? errors.length === 0 && execution.ok : releaseReady;
  const report = {
    schemaVersion: RUNNER_VERSION,
    mode,
    success,
    releaseReady,
    claims:
      mode === "local"
        ? claims
        : { requirementsVerified: 0, evidencePassed: 0 },
    errors,
    blockers,
    bindings: postIdentity.bindings,
    evidence,
    commands: execution.results,
  };
  const destination =
    reportPath ?? join(root, "reports", "phase2", `gate-report.${mode}.json`);
  writeAtomicGateReport(destination, report, { allowedRoot: root });
  return report;
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
    report = await verifyPhase2({ mode: parseMode(process.argv.slice(2)) });
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
