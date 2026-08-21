#!/usr/bin/env node

/**
 * AH-ROUTER-EVAL-001 gate stage (mirrors scripts/gates/run-phase2-evals.mjs).
 *
 * Two halves:
 *  1. In-process dataset integrity checks over evals/routing/dataset.json
 *     (pure JSON — task count, schema, token vocabulary, per-task annotation
 *     presence, id uniqueness, route membership).
 *  2. Routing behavior via the real deterministic Router DAG: runs
 *     tests/router/eval.test.ts under vitest, which drives routeDag through
 *     every dataset task and asserts the frozen phase-3.yaml exit criteria
 *     (hard_constraint_violation=0, routing_regret<=15%,
 *     unnecessary_multi_agent_rate<=20%, forbidden routes never selected).
 *
 * The engine itself (evals/routing/eval.ts) is TypeScript, so this stage
 * delegates the behavior assertions to vitest rather than re-importing it —
 * same assertion set, one source of truth.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MIN_TASKS = 200;
const ANNOTATION_FIELDS = [
  "allowed_routes",
  "forbidden_routes",
  "hard_constraints",
  "preferred_order",
  "single_agent_sufficient",
];
const HARD_CONSTRAINT_TOKENS = new Set([
  "single_agent",
  "multi_agent",
  "execution_static_dag",
  "execution_routing_slip",
  "execution_workflow_script",
  "no_routing_slip",
  "no_workflow_script",
  "budget_usd_micros_le_1000000",
]);
const ROUTE_VOCABULARY = new Set([
  "static_dag/single",
  "routing_slip/single",
  "workflow_script/multi",
]);

export const runPhase3Evaluations = ({ repositoryRoot = root, mode = "bootstrap" } = {}) => {
  const errors = [];
  const warnings = [];
  const evaluationsExecuted = [];

  // ---- 1. dataset integrity (in-process, JSON only) -------------------------
  const datasetPath = join(repositoryRoot, "evals", "routing", "dataset.json");
  const integrity = { dataset_present: false, task_count: 0, category_counts: {}, checks: [] };
  if (!existsSync(datasetPath)) {
    errors.push("routing dataset missing: evals/routing/dataset.json");
  } else {
    let dataset;
    try {
      dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
    } catch (error) {
      errors.push(`routing dataset unparsable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (dataset !== undefined) {
      integrity.dataset_present = true;
      const tasks = dataset.tasks ?? [];
      integrity.task_count = tasks.length;
      if (dataset.schema !== "routing-dataset/v1") {
        errors.push(`routing dataset schema mismatch: ${String(dataset.schema)}`);
      }
      if (tasks.length < MIN_TASKS) {
        errors.push(`routing dataset undersized: ${tasks.length} < ${MIN_TASKS}`);
      }
      if (Number.isInteger(dataset.task_count) && dataset.task_count !== tasks.length) {
        errors.push(`routing dataset task_count mismatch: ${dataset.task_count} != ${tasks.length}`);
      }
      const ids = new Set();
      for (const task of tasks) {
        integrity.category_counts[task.category] = (integrity.category_counts[task.category] ?? 0) + 1;
        if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
        ids.add(task.id);
        if (typeof task.goal !== "string" || task.goal.length === 0) {
          errors.push(`task ${task.id}: missing goal`);
        }
        for (const field of ANNOTATION_FIELDS) {
          if (task[field] === undefined) {
            errors.push(`task ${task.id}: missing annotation field ${field}`);
          }
        }
        for (const route of [...(task.allowed_routes ?? []), ...(task.forbidden_routes ?? [])]) {
          if (!ROUTE_VOCABULARY.has(route)) errors.push(`task ${task.id}: unknown route ${route}`);
        }
        for (const token of task.hard_constraints ?? []) {
          if (!HARD_CONSTRAINT_TOKENS.has(token)) errors.push(`task ${task.id}: unknown token ${token}`);
        }
      }
    }
  }

  // ---- 2. routing behavior (vitest on tests/router/eval.test.ts) ------------
  const evalTestPath = join(repositoryRoot, "tests", "router", "eval.test.ts");
  const vitest = join(repositoryRoot, "node_modules/vitest/vitest.mjs");
  const behavior = { suite: "tests/router/eval.test.ts", executed: false, all_passed: false };
  if (!existsSync(evalTestPath)) {
    errors.push("routing eval test missing: tests/router/eval.test.ts");
  } else {
    const run = spawnSync(
      process.execPath,
      [vitest, "run", "tests/router/eval.test.ts", "--reporter=dot"],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 300_000 },
    );
    behavior.executed = true;
    behavior.all_passed = run.status === 0;
    const tail = String(run.stdout ?? "").slice(-1200).trim();
    if (run.status === 0) {
      warnings.push("routing behavior: all exit-criteria assertions passed");
    } else {
      errors.push(
        `routing behavior failed (vitest exit ${String(run.status)}): ${tail || String(run.stderr).slice(-600)}`,
      );
    }
  }
  evaluationsExecuted.push({
    domain: "routing",
    case_id: "AH-ROUTER-EVAL-001",
    requirement_ids: ["AH-ROUTER-EVAL-001", "AH-ROUTER-DAG-001"],
    dataset: integrity,
    behavior,
  });

  const allPassed =
    integrity.dataset_present &&
    integrity.task_count >= MIN_TASKS &&
    behavior.executed &&
    behavior.all_passed &&
    errors.length === 0;

  if (mode === "release" && !allPassed) {
    errors.push("Phase 3 routing evaluation: not all evals passed");
  }

  return {
    mode,
    errors,
    warnings,
    evaluationsExecuted,
    releaseReady: allPassed,
    claims: {
      requirementsVerified: allPassed ? evaluationsExecuted.length : 0,
      evidencePassed: allPassed ? evaluationsExecuted.length : 0,
    },
  };
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex === -1 ? "bootstrap" : process.argv[modeIndex + 1];
  const result = runPhase3Evaluations({ mode });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}
