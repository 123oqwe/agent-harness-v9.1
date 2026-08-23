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
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPhase1Report, validatePhase1Report } from "./run-mutation.mjs";
import { mutationModules } from "../mutation/modules.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = join(dirname(scriptPath), "..");
const reportsDir = join(root, "reports", "mutation");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Rebind each chunk's config_sha256 to the consolidated on-disk bytes. In the
// split pipeline gateway runs in its own run dir; the verify job rewrites the
// run_id embedded in gateway's chunk stryker.config.json to the reference
// run_id, changing the bytes. check-mutation-thresholds compares
// claimed.config_sha256 against sha256 of those final bytes, so this must run
// AFTER consolidation. Idempotent for modules that never moved (their config
// bytes are unchanged, so the recomputed hash equals the recorded one).
function recomputeChunkConfigHashes(results, referenceRunId) {
  let recomputed = 0;
  for (const result of results) {
    for (const chunk of result.chunks ?? []) {
      const configPath = join(
        reportsDir,
        "runs",
        referenceRunId,
        result.module,
        "chunks",
        chunk.chunk_id,
        "stryker.config.json",
      );
      if (!existsSync(configPath)) {
        throw new Error(
          `missing chunk config for hash rebind: ${configPath}`,
        );
      }
      chunk.config_sha256 = sha256(readFileSync(configPath, "utf8"));
      recomputed += 1;
    }
  }
  console.log(`rebound config_sha256 for ${recomputed} chunks -> ${referenceRunId}`);
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

  // MUST run after the verify job consolidates run dirs (config bytes for the
  // moved run are rewritten to referenceRunId before this point).
  recomputeChunkConfigHashes(results, referenceRunId);

  // Build context from reference result. startedAt must be the EARLIEST module
  // start across all results, not the reference's: when gateway runs as a
  // separate job (split pipeline), its run starts before the reference run and
  // validateTimestampEnvelope requires every module started_at >= report
  // started_at.
  const startedAt = results.reduce(
    (earliest, result) =>
      !earliest || result.started_at < earliest ? result.started_at : earliest,
    null,
  );
  const context = {
    runId: referenceRunId,
    commitSha: referenceResult.commit_sha,
    configurationHash: referenceResult.configuration_hash,
    startedAt,
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
