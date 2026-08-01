#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPhase2ContractDrift } from "./check-contract-drift.mjs";
import { checkActivePhase2Stubs } from "./check-active-stubs.mjs";
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

export const verifyPhase2 = async ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  mode = "dev",
  runner = runCommand,
  identityCollector = collectGateBindings,
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
  if (mode === "local") {
    if (
      postIdentity.dirty ||
      postIdentity.errors.length > 0 ||
      stableJson(postIdentity.bindings) !== stableJson(identity.bindings)
    ) {
      errors.push("repository identity changed during the release gate");
      errors.push(...postIdentity.errors);
      blockers.push({ code: "repository_changed_during_gate" });
    }
  }
  const readiness =
    mode === "local"
      ? checkActivePhase2Stubs({
          repositoryRoot: root,
          currentBindings: postIdentity.bindings,
          commandResults: execution.results,
        })
      : null;
  if (mode === "local" && readiness && !readiness.releaseReady) {
    errors.push(
      `Phase 2 Evidence incomplete: ${readiness.claims.evidencePassed}/64`,
    );
    blockers.push({
      code: "evidence_incomplete",
      verified: readiness.claims.evidencePassed,
      required: 64,
    });
  }
  const releaseReady =
    mode === "local" &&
    execution.ok &&
    readiness?.releaseReady === true &&
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
        ? (readiness?.claims ?? { requirementsVerified: 0, evidencePassed: 0 })
        : { requirementsVerified: 0, evidencePassed: 0 },
    errors,
    blockers,
    bindings: postIdentity.bindings,
    commands: execution.results,
  };
  const destination =
    reportPath ?? join(root, "reports", "phase2", `gate-report.${mode}.json`);
  writeAtomicGateReport(destination, report);
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
