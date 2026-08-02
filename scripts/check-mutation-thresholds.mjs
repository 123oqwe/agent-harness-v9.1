#!/usr/bin/env node
/**
 * Independently checks published mutation results against the current commit
 * and the current mutation configuration. It never searches fallback paths.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationModules } from '../mutation/modules.mjs';
import {
  computeMutationConfigurationHash,
  loadEquivalentMutants,
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

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function emptyCounts() {
  return {
    total: 0,
    killed: 0,
    timeout: 0,
    survived: 0,
    noCoverage: 0,
    ignored: 0,
  };
}

function scoreFromCounts(counts) {
  const testable = counts.total - counts.ignored;
  if (testable <= 0) return 0;
  return Number(
    (((counts.killed + counts.timeout) / testable) * 100).toFixed(2),
  );
}

function countRawMutants(moduleName, sourceFile, mutants, waiverKeys) {
  const counts = emptyCounts();
  for (const mutant of mutants) {
    counts.total += 1;
    const waiverKey = `${moduleName}:${sourceFile}:${String(mutant.id)}`;
    if (waiverKeys.has(waiverKey)) {
      counts.ignored += 1;
      continue;
    }
    switch (mutant.status) {
      case 'Killed':
        counts.killed += 1;
        break;
      case 'Timeout':
        counts.timeout += 1;
        break;
      case 'Survived':
        counts.survived += 1;
        break;
      case 'NoCoverage':
        counts.noCoverage += 1;
        break;
      case 'Ignored':
        throw new Error(
          `raw report contains unreviewed ignored mutant ${moduleName}/${sourceFile}/${String(mutant.id)}`,
        );
      default:
        throw new Error(
          `raw report contains non-terminal mutant ${moduleName}/${sourceFile}/${String(mutant.id)}`,
        );
    }
  }
  return counts;
}

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

function assertRawMetrics(moduleName, label, actual, expected) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`raw report counts mismatch for ${moduleName}/${label}`);
  }
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isStrictDescendant(parent, child) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`);
}

function validateArtifactEnvelope(report, artifactReportsDir) {
  if (
    typeof report?.run_id !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      report.run_id,
    )
  ) {
    throw new Error('Phase 1 artifact run_id format is invalid');
  }
  const runsRoot = resolve(artifactReportsDir, 'runs');
  const runRoot = resolve(runsRoot, report.run_id);
  const runRelative = relative(runsRoot, runRoot);
  if (
    runRelative === '' ||
    runRelative === '..' ||
    runRelative.startsWith(`..${sep}`)
  ) {
    throw new Error('Phase 1 artifact run_id escapes the reports directory');
  }
  if (!validTimestamp(report.started_at) || !validTimestamp(report.completed_at)) {
    throw new Error('Phase 1 artifact timestamp is invalid');
  }
  const runStarted = Date.parse(report.started_at);
  const runCompleted = Date.parse(report.completed_at);
  if (runStarted > runCompleted) {
    throw new Error('Phase 1 artifact timestamp order is invalid');
  }
  for (const result of report.modules ?? []) {
    if (!validTimestamp(result.started_at) || !validTimestamp(result.completed_at)) {
      throw new Error(`module ${result.module} timestamp is invalid`);
    }
    const moduleStarted = Date.parse(result.started_at);
    const moduleCompleted = Date.parse(result.completed_at);
    if (
      moduleStarted < runStarted ||
      moduleStarted > moduleCompleted ||
      moduleCompleted > runCompleted
    ) {
      throw new Error(`module ${result.module} timestamp is outside the run envelope`);
    }
  }
  return { runRoot, runsRoot };
}

export function validatePublishedPhase1Artifacts({
  report,
  reportsDir: artifactReportsDir,
  commitSha,
  configurationHash,
  waiverKeys,
  root = harnessRoot,
}) {
  const { runRoot, runsRoot } = validateArtifactEnvelope(
    report,
    artifactReportsDir,
  );
  for (const result of report?.modules ?? []) {
    const moduleName = result?.module;
    if (!Object.hasOwn(mutationModules, moduleName)) {
      throw new Error(`raw report names unknown module: ${moduleName}`);
    }
    const module = mutationModules[moduleName];
    const rawPath = join(runRoot, moduleName, 'mutation.json');
    if (!existsSync(rawPath)) {
      throw new Error(`raw report missing: ${rawPath}`);
    }
    const realRunsRoot = realpathSync(runsRoot);
    const realRunRoot = realpathSync(runRoot);
    const realRawPath = realpathSync(rawPath);
    if (
      !isStrictDescendant(realRunsRoot, realRunRoot) ||
      !isStrictDescendant(realRunRoot, realRawPath)
    ) {
      throw new Error(`raw report path escapes the reports directory: ${rawPath}`);
    }
    const rawText = readFileSync(rawPath, 'utf8');
    const rawHash = createHash('sha256').update(rawText).digest('hex');
    if (result.raw_report_sha256 !== rawHash) {
      throw new Error(`raw report hash mismatch for ${moduleName}`);
    }
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`raw report JSON invalid for ${moduleName}: ${error.message}`, {
        cause: error,
      });
    }
    if (!raw?.files || typeof raw.files !== 'object') {
      throw new Error(`raw report files missing for ${moduleName}`);
    }
    const expectedFiles = [...module.mutate].sort();
    const actualFiles = Object.keys(raw.files).sort();
    if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) {
      throw new Error(`raw report source files mismatch for ${moduleName}`);
    }

    const moduleCounts = emptyCounts();
    const recomputedPerFile = {};
    for (const sourceFile of expectedFiles) {
      const rawFile = raw.files[sourceFile];
      if (!Array.isArray(rawFile?.mutants)) {
        throw new Error(`raw report mutants missing for ${moduleName}/${sourceFile}`);
      }
      if (rawFile.source !== readFileSync(join(root, sourceFile), 'utf8')) {
        throw new Error(`raw report source content mismatch for ${moduleName}/${sourceFile}`);
      }
      const counts = countRawMutants(
        moduleName,
        sourceFile,
        rawFile.mutants,
        waiverKeys,
      );
      addCounts(moduleCounts, counts);
      const score = scoreFromCounts(counts);
      const minimum = module.perFileMinimum ?? 0;
      recomputedPerFile[sourceFile] = {
        ...counts,
        score,
        minimum,
        status: score >= minimum ? 'PASS' : 'FAIL',
      };
    }
    assertRawMetrics(moduleName, 'module', result.counts, moduleCounts);
    if (result.score !== scoreFromCounts(moduleCounts)) {
      throw new Error(`raw report score mismatch for ${moduleName}`);
    }
    assertRawMetrics(
      moduleName,
      'per-file',
      result.per_file,
      recomputedPerFile,
    );
  }
  return validatePhase1Report(report, {
    runId: report.run_id,
    commitSha,
    configurationHash,
  });
}

function checkPhase1() {
  const report = readJson(join(reportsDir, 'phase1', 'mutation.json'));
  const commitSha = currentCommit();
  const configurationHash = computeMutationConfigurationHash(harnessRoot);
  const waiverKeys = loadEquivalentMutants(
    join(harnessRoot, 'mutation', 'equivalent-mutants.json'),
    commitSha,
    configurationHash,
  );
  validatePublishedPhase1Artifacts({
    report,
    reportsDir,
    commitSha,
    configurationHash,
    waiverKeys,
    root: harnessRoot,
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
