#!/usr/bin/env node
/**
 * Independently checks published mutation results against the current commit
 * and the current mutation configuration. It never searches fallback paths.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationModules } from '../mutation/modules.mjs';
import {
  computeMutationConfigurationHash,
  validatePhase1Report,
} from './run-mutation.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const harnessRoot = resolve(dirname(scriptPath), '..');
const reportsDir = join(harnessRoot, 'reports', 'mutation');

function currentCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: harnessRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`cannot resolve current commit: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`required report missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid report JSON at ${path}: ${error.message}`, {
      cause: error,
    });
  }
}

function checkPhase1() {
  const report = readJson(join(reportsDir, 'phase1', 'mutation.json'));
  validatePhase1Report(report, {
    runId: report.run_id,
    commitSha: currentCommit(),
    configurationHash: computeMutationConfigurationHash(harnessRoot),
  });
  console.log(
    `Phase 1 mutation PASS: ${report.aggregate.score}% ` +
      `(run ${report.run_id}, commit ${report.commit_sha})`,
  );
  for (const module of report.modules) {
    console.log(
      `  ${module.module}: ${module.score}% / ${module.minimum}% [PASS]`,
    );
  }
}

function checkModule(moduleName) {
  if (!mutationModules[moduleName]) {
    throw new Error(`unknown mutation module: ${moduleName}`);
  }
  const result = readJson(join(reportsDir, moduleName, 'result.json'));
  const commitSha = currentCommit();
  const configurationHash = computeMutationConfigurationHash(harnessRoot);
  if (
    result.module !== moduleName ||
    result.commit_sha !== commitSha ||
    result.configuration_hash !== configurationHash ||
    result.status !== 'PASS' ||
    result.score < mutationModules[moduleName].minimum
  ) {
    throw new Error(
      `${moduleName} report is stale, mismatched, or below threshold`,
    );
  }
  const expectedFiles = [...mutationModules[moduleName].mutate].sort();
  const actualFiles = [...(result.source_files ?? [])].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`${moduleName} report source file mismatch`);
  }
  for (const [sourceFile, metrics] of Object.entries(result.per_file ?? {})) {
    if (
      metrics.status !== 'PASS' ||
      metrics.score < (mutationModules[moduleName].perFileMinimum ?? 0)
    ) {
      throw new Error(`${moduleName}/${sourceFile} is below its file floor`);
    }
  }
  console.log(
    `${moduleName} mutation PASS: ${result.score}% / ` +
      `${mutationModules[moduleName].minimum}%`,
  );
}

function main() {
  const target = process.argv[2];
  if (!target) {
    throw new Error(
      'usage: node scripts/check-mutation-thresholds.mjs <module|phase1>',
    );
  }
  if (target === 'phase1') checkPhase1();
  else checkModule(target);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
