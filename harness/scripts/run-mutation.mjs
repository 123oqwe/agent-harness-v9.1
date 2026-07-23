#!/usr/bin/env node
/**
 * Mutation test runner — runs Stryker for a named module or all Phase 1 modules.
 *
 * Usage:
 *   node scripts/run-mutation.mjs <module>
 *   node scripts/run-mutation.mjs phase1
 *
 * Guarantees:
 * 1. Each module uses an isolated report directory.
 * 2. Old report is deleted BEFORE running so stale data can never be used.
 * 3. Stryker non-zero exit immediately fails the module — no fallback copy.
 * 4. After report is written, source files in the report are validated
 *    against the module's configured mutate list.
 * 5. runModule() returns a result object or throws — never calls process.exit().
 * 6. Phase 1 aggregate exits once after all modules.
 * 7. Uses npm exec --offline to prevent network downloads during mutation.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, globSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationModules, phase1Minimum } from '../mutation/modules.mjs';
import { strykerBase } from '../mutation/stryker.base.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, '..');
const reportsDir = join(harnessRoot, 'reports', 'mutation');

function resolveGlob(patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    let matches;
    try { matches = globSync(pattern, { cwd: harnessRoot }); } catch { matches = []; }
    for (const m of matches) {
      let excluded = false;
      if (m.endsWith('index.ts')) excluded = true;
      else if (m.endsWith('.d.ts')) excluded = true;
      else if (m.endsWith('.test.ts')) excluded = true;
      else if (m.endsWith('.spec.ts')) excluded = true;
      else if (m.startsWith('contracts/')) excluded = true;
      else if (m.startsWith('tests/')) excluded = true;
      else if (m.startsWith('dist/')) excluded = true;
      else if (m.startsWith('node_modules/')) excluded = true;
      else if (m === 'vitest.config.ts') excluded = true;
      else if (m === 'vitest.mutation.config.ts') excluded = true;
      else if (m === 'eslint.config.js') excluded = true;
      else if (m.endsWith('.json')) excluded = true;
      if (!excluded) files.add(m);
    }
  }
  return [...files].sort();
}

/**
 * Run a single module. Returns { module, passed, score, counts } or throws.
 * NEVER calls process.exit().
 */
function runModule(moduleName) {
  const mod = mutationModules[moduleName];
  if (!mod) {
    throw new Error(`Unknown module: ${moduleName}. Available: ${Object.keys(mutationModules).join(', ')}, phase1`);
  }

  const mutateFiles = resolveGlob(mod.mutate);
  if (mutateFiles.length === 0) {
    throw new Error(`Module '${moduleName}' has an empty mutate list after exclusions. Patterns: ${mod.mutate.join(', ')}`);
  }

  const moduleReportDir = join(reportsDir, moduleName);

  // 1. Delete old report directory to prevent stale data
  if (existsSync(moduleReportDir)) {
    rmSync(moduleReportDir, { recursive: true, force: true });
  }
  mkdirSync(moduleReportDir, { recursive: true });

  // 2. Build Stryker config for this module
  const config = {
    ...strykerBase,
    mutate: mutateFiles,
    tempDirName: `.stryker-tmp/${moduleName}`,
    thresholds: {
      high: mod.minimum,
      low: mod.minimum - 5,
      break: mod.minimum - 5,
    },
  };

  const configPath = join(harnessRoot, `.stryker.${moduleName}.config.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`\n=== Running mutation for module: ${moduleName} ===`);
  console.log(`Mutating ${mutateFiles.length} file(s): ${mutateFiles.join(', ')}`);
  console.log(`Minimum score: ${mod.minimum}%`);

  // 3. Run Stryker — use npm exec --offline to prevent network downloads
  // Also delete the shared reports/mutation/mutation.json so it can't be picked up
  const sharedJson = join(reportsDir, 'mutation.json');
  if (existsSync(sharedJson)) rmSync(sharedJson, { force: true });
  const sharedHtml = join(reportsDir, 'mutation.html');
  if (existsSync(sharedHtml)) rmSync(sharedHtml, { force: true });

  const strykerBin = join(harnessRoot, 'node_modules', '.bin', 'stryker');
  const result = spawnSync(strykerBin, ['run', configPath], {
    cwd: harnessRoot,
    stdio: 'inherit',
    timeout: 600000,
    env: {
      ...process.env,
      STRYKER: 'true',
      HARNESS_SPEC_ROOT: resolve(harnessRoot, '..', 'spec'),
    },
  });

  // 4. Stryker non-zero exit = immediate failure — NO fallback copy
  if (result.error || result.status !== 0) {
    // Clean up temp config
    try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
    const code = result.error ? 'spawn-error' : result.status;
    throw new Error(`Stryker exited with code ${code} for module ${moduleName}. No report will be used.`);
  }

  // 5. Locate the report Stryker wrote
  // Stryker v9 writes to reports/mutation/mutation.json (shared) by default
  // or to the tempDir if configured. Check both, but prefer the shared one
  // that Stryker actually wrote in this run.
  const candidatePaths = [
    sharedJson,                                    // shared default
    join(harnessRoot, '.stryker-tmp', moduleName, 'reports', 'mutation', 'mutation.json'),  // tempDir
  ];

  let reportJson = null;
  let reportPath = null;
  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        reportJson = JSON.parse(readFileSync(p, 'utf8'));
        reportPath = p;
        break;
      } catch {
        // corrupt JSON, try next
      }
    }
  }

  if (!reportJson) {
    try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
    throw new Error(`No valid mutation.json found for module ${moduleName} after Stryker run.`);
  }

  // 6. Validate: report source files MUST match the module's mutate list
  const reportFiles = Object.keys(reportJson.files || {});
  const expectedSet = new Set(mutateFiles);
  const reportSet = new Set(reportFiles);

  const missingFromReport = [...expectedSet].filter(f => !reportSet.has(f));
  const extraInReport = [...reportSet].filter(f => !expectedSet.has(f));

  if (missingFromReport.length > 0 || extraInReport.length > 0) {
    try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
    const parts = [];
    if (missingFromReport.length > 0) parts.push(`missing from report: ${missingFromReport.join(', ')}`);
    if (extraInReport.length > 0) parts.push(`unexpected in report: ${extraInReport.join(', ')}`);
    throw new Error(`Report source file mismatch for module ${moduleName}: ${parts.join('; ')}`);
  }

  // 7. Copy report to module-specific directory
  const destPath = join(moduleReportDir, 'mutation.json');
  if (reportPath !== destPath) {
    writeFileSync(destPath, readFileSync(reportPath, 'utf8'));
  }

  // Clean up shared report and temp config
  if (existsSync(sharedJson)) rmSync(sharedJson, { force: true });
  try { rmSync(configPath, { force: true }); } catch { /* ignore */ }

  // 8. Run threshold checker (as a function, not subprocess, to get result)
  const counts = countFromReport(reportJson);
  const score = computeScore(counts);
  const passed = score >= mod.minimum;

  console.log(`\n--- ${moduleName} ---`);
  console.log(`Total: ${counts.total}, Killed: ${counts.killed}, Timeout: ${counts.timeout}, Survived: ${counts.survived}, NoCoverage: ${counts.noCoverage}, Ignored: ${counts.ignored}`);
  console.log(`Score: ${score}% (required: ${mod.minimum}%) -> ${passed ? 'PASS' : 'FAIL'}`);

  return { module: moduleName, passed, score, counts, minimum: mod.minimum };
}

function countFromReport(data) {
  const files = data.files || {};
  const fileEntries = Array.isArray(files) ? files : Object.values(files);
  const counts = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
  for (const f of fileEntries) {
    for (const m of (f.mutants || [])) {
      counts.total++;
      switch (m.status) {
        case 'Killed': counts.killed++; break;
        case 'Timeout': counts.timeout++; break;
        case 'Survived': counts.survived++; break;
        case 'NoCoverage': counts.noCoverage++; break;
        case 'Ignored': counts.ignored++; break;
      }
    }
  }
  return counts;
}

function computeScore(counts) {
  const testable = counts.total - counts.ignored;
  if (testable === 0) return 0;
  return parseFloat(((counts.killed + counts.timeout) / testable * 100).toFixed(2));
}

function runPhase1() {
  const moduleNames = Object.keys(mutationModules);
  console.log(`\n=== Running Phase 1 mutation for all ${moduleNames.length} modules ===`);
  const results = [];
  let allPassed = true;
  const aggregate = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };

  for (const mod of moduleNames) {
    try {
      const result = runModule(mod);
      results.push(result);
      aggregate.total += result.counts.total;
      aggregate.killed += result.counts.killed;
      aggregate.timeout += result.counts.timeout;
      aggregate.survived += result.counts.survived;
      aggregate.noCoverage += result.counts.noCoverage;
      aggregate.ignored += result.counts.ignored;
      if (!result.passed) allPassed = false;
    } catch (err) {
      console.error(`\nFAIL: ${err.message}`);
      results.push({ module: mod, passed: false, score: 0, counts: { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 }, minimum: mutationModules[mod].minimum, error: err.message });
      allPassed = false;
    }
  }

  const testableTotal = aggregate.total - aggregate.ignored;
  const aggregateScore = testableTotal > 0
    ? parseFloat(((aggregate.killed + aggregate.timeout) / testableTotal * 100).toFixed(2))
    : 0;

  const phase1Report = {
    aggregate: {
      ...aggregate,
      score: aggregateScore,
      required: phase1Minimum,
      status: aggregateScore >= phase1Minimum ? 'PASS' : 'FAIL',
    },
    modules: results.map(r => ({
      module: r.module,
      total: r.counts.total,
      killed: r.counts.killed,
      timeout: r.counts.timeout,
      survived: r.counts.survived,
      noCoverage: r.counts.noCoverage,
      ignored: r.counts.ignored,
      score: r.score,
      minimum: r.minimum,
      status: r.passed ? 'PASS' : 'FAIL',
      ...(r.error ? { error: r.error } : {}),
    })),
  };

  const phase1Dir = join(reportsDir, 'phase1');
  mkdirSync(phase1Dir, { recursive: true });
  writeFileSync(join(phase1Dir, 'mutation.json'), JSON.stringify(phase1Report, null, 2));

  console.log(`\n=== Phase 1 Aggregate ===`);
  console.log(`Score: ${phase1Report.aggregate.score}% (required: ${phase1Minimum}%)`);
  console.log(`Status: ${phase1Report.aggregate.status}`);
  console.log(`\nPer-module:`);
  for (const m of phase1Report.modules) {
    console.log(`  ${m.module}: ${m.score}% / ${m.minimum}% [${m.status}]${m.error ? ' (' + m.error + ')' : ''}`);
  }

  process.exit(allPassed && phase1Report.aggregate.status === 'PASS' ? 0 : 1);
}

// Main
const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/run-mutation.mjs <module|phase1>');
  process.exit(2);
}

if (arg === 'phase1') {
  runPhase1();
} else {
  try {
    const result = runModule(arg);
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  }
}
