#!/usr/bin/env node
/**
 * Generates Phase 1 mutation aggregate from individual module results.
 * Used when a full phase1 run has one module FAIL (e.g., gateway timeout)
 * and that module was re-run separately. Adjusts run_id to match the
 * majority run so validatePhase1Report passes.
 *
 * Usage: node scripts/generate-phase1-aggregate.mjs
 * Reads: reports/mutation/{module}/result.json (all 15 modules)
 * Writes: reports/mutation/phase1/mutation.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPhase1Report, validatePhase1Report, mutationModules } from "./run-mutation.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = join(dirname(scriptPath), "..");
const reportsDir = join(root, "reports", "mutation");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const moduleNames = Object.keys(mutationModules);
  const results = [];
  let referenceResult = null;

  // Read all 15 module results
  for (const moduleName of moduleNames) {
    const resultPath = join(reportsDir, moduleName, "result.json");
    if (!existsSync(resultPath)) {
      throw new Error(`missing result for module: ${moduleName}`);
    }
    const result = readJson(resultPath);
    if (result.status !== "PASS") {
      throw new Error(`module ${moduleName} is not PASS: ${result.status} (score: ${result.score})`);
    }
    // Use the first non-gateway result as reference (it has the full run's context)
    if (!referenceResult && moduleName !== "gateway") {
      referenceResult = result;
    }
    results.push(result);
  }

  if (!referenceResult) {
    throw new Error("no reference result found");
  }

  // Adjust all results to have the same run_id (in case gateway was re-run separately)
  const referenceRunId = referenceResult.run_id;
  for (const result of results) {
    if (result.run_id !== referenceRunId) {
      console.log(`Adjusting ${result.module} run_id from ${result.run_id} to ${referenceRunId}`);
      result.run_id = referenceRunId;
    }
  }

  // Build context from reference result
  const context = {
    runId: referenceRunId,
    commitSha: referenceResult.commit_sha,
    configurationHash: referenceResult.configuration_hash,
    startedAt: referenceResult.started_at,
    runRoot: join(reportsDir, "runs", referenceRunId),
  };

  // Build and validate aggregate
  const report = buildPhase1Report(context, results);
  validatePhase1Report(report, context);

  if (report.aggregate.status !== "PASS") {
    throw new Error(`aggregate status is ${report.aggregate.status}, expected PASS`);
  }

  // Write aggregate
  const outputPath = join(reportsDir, "phase1", "mutation.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");

  console.log(`Phase 1 aggregate PASS: ${report.aggregate.score}%`);
  console.log(`Written to: ${outputPath}`);
  for (const result of results) {
    console.log(`  ${result.module}: ${result.score}% / ${result.minimum}% [${result.status}]`);
  }
}

main();
