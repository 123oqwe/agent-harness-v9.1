#!/usr/bin/env node

/**
 * Phase 3 local gate (mirrors scripts/gates/verify-phase2-local.mjs).
 *
 * Modes:
 *   dev   — manifest + workspace-boundaries + unit/integration (fast)
 *   local — dev + typecheck + lint + routing eval + evidence publication
 *
 * The routing eval is delegated to run-phase3-evals.mjs (dataset integrity
 * in-process + routing behavior via tests/router/eval.test.ts under vitest).
 * Phase 3 has no mutation stage: spec/phases/phase-3.yaml exit_criteria defines
 * no mutation threshold (unlike phase-2). No factory/ gate runner exists in
 * this worktree; the phase-2 scripts/gates pattern is the authority.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const RUNNER_VERSION = "phase3-gate-report/v1";

const EXPECTED_REQUIREMENT_IDS = [
  "AH-AGENT-AUTHORING-001", "AH-MULTIAGENT-DAG-001", "AH-MULTIAGENT-MERGE-001",
  "AH-ROUTER-BUDGET-DYNAMIC-001", "AH-ROUTER-CONTEXT-TOPOLOGY-001",
  "AH-ROUTER-DAG-001", "AH-ROUTER-DAG-FAILURE-001", "AH-ROUTER-EVAL-001",
  "AH-ROUTER-FALLBACK-11-001", "AH-ROUTER-SKILL-CHAIN-001", "AH-SUBAGENT-001",
  "AH-TOOL-BROWSER-001", "AH-TOOL-COMPUTER-001", "AH-TOOL-VIDEO-GEN-001",
  "AH-TOOL-MUSIC-GEN-001", "AH-TOOL-VIDEO-EDIT-001",
];

const runCommand = (cmd, { timeout = 180_000 } = {}) => {
  try {
    const stdout = execSync(cmd, {
      cwd: repoRoot,
      timeout,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { ok: true, stdout: String(stdout) };
  } catch (error) {
    const e = error;
    return {
      ok: false,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
      message: e instanceof Error ? e.message : String(e),
    };
  }
};

const makeRunner = () => {
  const errors = [];
  const warnings = [];
  const results = [];
  /** Run a named check; FAIL goes to errors, WARN to warnings. */
  const record = (name, fn) => {
    let status;
    let detail;
    try {
      const result = fn();
      status = result.status ?? "PASS";
      detail = result.detail ?? "";
    } catch (error) {
      status = "FAIL";
      detail = String(error instanceof Error ? error.message : error).slice(0, 300);
    }
    if (status === "FAIL") errors.push(`${name}: ${detail}`);
    else if (status === "WARN") warnings.push(`${name}: ${detail}`);
    results.push({ check: name, status, detail });
  };
  return { errors, warnings, results, record };
};

export const verifyPhase3 = (mode = "dev") => {
  const gatePath = join(repoRoot, "verification/gates/phase3-gate.json");
  const gate = JSON.parse(readFileSync(gatePath, "utf8"));
  const requirements = gate.requirements;
  const ctx = makeRunner();
  const { record, errors, warnings, results } = ctx;

  // ---- manifest: gate byte-freeze + every referenced file present ----------
  record("manifest", () => {
    if (gate.schema_version !== "1.0.0") throw new Error("schema_version != 1.0.0");
    if (gate.phase !== 3) throw new Error("phase != 3");
    if (!Array.isArray(requirements) || requirements.length !== 16) {
      throw new Error(`requirements != 16 (${requirements.length})`);
    }
    const ids = requirements.map((r) => r.id);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate requirement ids");
    const unexpected = ids.filter((id) => !EXPECTED_REQUIREMENT_IDS.includes(id));
    const missing = EXPECTED_REQUIREMENT_IDS.filter((id) => !ids.includes(id));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(`requirement set drift: missing=[${missing}] unexpected=[${unexpected}]`);
    }
    let missingFiles = 0;
    for (const req of requirements) {
      for (const f of [...(req.source_files ?? []), ...(req.test_files ?? [])]) {
        if (!existsSync(join(repoRoot, f))) {
          errors.push(`missing file: ${f} (req ${req.id})`);
          missingFiles++;
        }
      }
      if (typeof req.evidence_path !== "string" || !req.evidence_path.startsWith("artifacts/phase-3/")) {
        throw new Error(`${req.id}: evidence_path not under artifacts/phase-3/`);
      }
      if (!Array.isArray(req.test_suites) || req.test_suites.length === 0) {
        throw new Error(`${req.id}: test_suites missing`);
      }
    }
    return { status: missingFiles === 0 ? "PASS" : "FAIL", detail: `${requirements.length} requirements, ${missingFiles} missing files` };
  });

  // ---- workspace boundaries --------------------------------------------------
  record("workspace-boundaries", () => {
    const result = runCommand(
      `${process.execPath} scripts/check-workspace-boundaries.mjs --root ${repoRoot}`,
    );
    if (!result.ok) {
      throw new Error((result.stderr || result.stdout).slice(0, 300) || result.message);
    }
    return { status: "PASS", detail: "boundaries OK" };
  });

  // ---- phase-3 unit/integration suites (all requirement test_suites) ----------
  record("unit-tests", () => {
    const suiteSet = new Set();
    for (const req of requirements) {
      for (const suite of req.test_suites) suiteSet.add(suite);
    }
    const suites = [...suiteSet];
    const vitest = join(repoRoot, "node_modules/vitest/vitest.mjs");
    const result = runCommand(
      `${process.execPath} ${vitest} run ${suites.join(" ")} --reporter=json`,
      { timeout: 600_000 },
    );
    if (!result.ok) {
      throw new Error((result.stdout || result.stderr).slice(0, 400) || result.message);
    }
    let summary;
    try {
      summary = JSON.parse(result.stdout);
    } catch {
      throw new Error("vitest json reporter output unparsable");
    }
    const total = summary.numTotalTests ?? 0;
    const failed = summary.numFailedTests ?? 0;
    if (failed > 0) throw new Error(`${failed}/${total} tests failed`);
    return { status: "PASS", detail: `${total - failed}/${total} tests pass across ${suites.length} suites` };
  });

  if (mode === "local") {
    // ---- typecheck ----------------------------------------------------------
    record("typecheck", () => {
      const result = runCommand(
        `${process.execPath} ${join(repoRoot, "node_modules/typescript/bin/tsc")} --noEmit`,
        { timeout: 300_000 },
      );
      if (!result.ok) {
        throw new Error((result.stdout || result.stderr).slice(0, 300) || result.message);
      }
      return { status: "PASS", detail: "tsc --noEmit exit 0" };
    });

    // ---- lint: canonical target (like phase-2's npm run lint) + phase-3 surface
    record("lint", () => {
      const testTarget = new Set();
      for (const req of requirements) {
        for (const f of req.test_files ?? []) testTarget.add(f);
      }
      const canonical =
        "gateway security runtime router sandbox session skills tools ui verification vfs " +
        "domains ingestion harness.ts index.ts scripts benchmarks packages apps tests/phase-2/architecture";
      const target = `${canonical} evals/routing/eval.ts ${[...testTarget].join(" ")}`;
      const result = runCommand(
        `${join(repoRoot, "node_modules/.bin/eslint")} ${target} --quiet`,
        { timeout: 300_000 },
      );
      if (!result.ok) {
        throw new Error((result.stdout || result.stderr).slice(0, 300) || result.message);
      }
      return { status: "PASS", detail: "eslint exit 0" };
    });

    // ---- routing eval ---------------------------------------------------------
    record("routing-eval", () => {
      const result = runCommand(
        `${process.execPath} scripts/gates/run-phase3-evals.mjs --mode release`,
        { timeout: 600_000 },
      );
      if (!result.ok) {
        throw new Error((result.stdout || result.stderr).slice(0, 400) || result.message);
      }
      let evalReport;
      try {
        evalReport = JSON.parse(result.stdout);
      } catch {
        throw new Error("run-phase3-evals output unparsable");
      }
      if (!evalReport.releaseReady || evalReport.errors.length > 0) {
        throw new Error(evalReport.errors.join("; ").slice(0, 400));
      }
      const executed = evalReport.evaluationsExecuted[0];
      return {
        status: "PASS",
        detail: `dataset=${executed?.dataset?.task_count ?? "?"} tasks; behavior ${executed?.behavior?.all_passed === true ? "passed" : "unknown"}`,
      };
    });
  }

  // ---- publication ------------------------------------------------------------
  let commitSha = "unknown";
  try {
    commitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    /* report without sha rather than failing on git absence */
  }
  const outDir = join(repoRoot, "artifacts/phase-3");
  mkdirSync(outDir, { recursive: true });
  const now = new Date().toISOString();
  for (const req of requirements) {
    const evidence = {
      schema_version: "phase3-evidence/v1",
      requirement_id: req.id,
      phase: 3,
      gate_runner: RUNNER_VERSION,
      commit_sha: commitSha,
      status: errors.length === 0 ? "verified" : "failed",
      test_suites: req.test_suites,
      checks: results.map((r) => ({ check: r.check, status: r.status })),
      produced_at: now,
    };
    writeFileSync(
      join(outDir, `${req.id}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }
  const report = {
    schema_version: RUNNER_VERSION,
    phase: 3,
    mode,
    success: errors.length === 0,
    releaseReady: errors.length === 0,
    claims: {
      requirementsVerified: errors.length === 0 ? requirements.length : 0,
      evidencePassed: errors.length === 0 ? requirements.length : 0,
    },
    errors,
    warnings,
    checks: results,
    bindings: {
      commitSha,
      gatePath,
      requirementCount: requirements.length,
    },
  };
  writeFileSync(join(outDir, "phase3-gate-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
};

const parseMode = (argv) => {
  if (argv.length === 0) return "dev";
  if (argv.length === 2 && argv[0] === "--mode" && new Set(["dev", "local"]).has(argv[1])) {
    return argv[1];
  }
  throw new Error("usage: verify-phase3-local.mjs --mode <dev|local>");
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  let report;
  try {
    report = verifyPhase3(parseMode(process.argv.slice(2)));
  } catch (error) {
    report = {
      schema_version: RUNNER_VERSION,
      phase: 3,
      mode: "unknown",
      success: false,
      releaseReady: false,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
      checks: [],
      bindings: {},
    };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.success ? 0 : 1;
}
