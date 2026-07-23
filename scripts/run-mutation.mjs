#!/usr/bin/env node
/**
 * Mutation test runner — runs Stryker for a named module or all Phase 1 modules.
 *
 * Usage:
 *   node scripts/run-mutation.mjs <module>
 *   node scripts/run-mutation.mjs phase1
 *
 * Writes JSON to reports/mutation/<module>/mutation.json
 * Then runs check-mutation-thresholds.mjs to verify floors.
 * Returns non-zero when a module or per-file floor fails.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, cpSync, globSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationModules, phase1Minimum, mutationExclusions } from '../mutation/modules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, '..');
const reportsDir = join(harnessRoot, 'reports', 'mutation');

function resolveGlob(patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    let matches;
    try { matches = globSync(pattern, { cwd: harnessRoot }); } catch { matches = []; }
    for (const m of matches) {
      // Apply exclusions
      const isExcluded = mutationExclusions.some(ex => {
        const exPattern = ex.replace(/\*\*/g, '*').replace(/\*\./g, '*.');
        if (ex === '**/index.ts') return m.endsWith('index.ts');
        if (ex === '**/*.d.ts') return m.endsWith('.d.ts');
        if (ex === '**/*.test.ts') return m.endsWith('.test.ts');
        if (ex === '**/*.spec.ts') return m.endsWith('.spec.ts');
        if (ex === 'contracts/**') return m.startsWith('contracts/');
        if (ex === 'tests/**') return m.startsWith('tests/');
        if (ex === 'dist/**') return m.startsWith('dist/');
        if (ex === 'node_modules/**') return m.startsWith('node_modules/');
        if (ex === 'vitest.config.ts') return m === 'vitest.config.ts';
        if (ex === 'vitest.mutation.config.ts') return m === 'vitest.mutation.config.ts';
        if (ex === 'eslint.config.js') return m === 'eslint.config.js';
        if (ex === '**/*.json') return m.endsWith('.json');
        return false;
      });
      if (!isExcluded) files.add(m);
    }
  }
  return [...files].sort();
}

function runModule(moduleName) {
  const mod = mutationModules[moduleName];
  if (!mod) {
    console.error(`Unknown module: ${moduleName}`);
    console.error(`Available: ${Object.keys(mutationModules).join(', ')}, phase1`);
    process.exit(2);
  }

  const mutateFiles = resolveGlob(mod.mutate);
  if (mutateFiles.length === 0) {
    console.error(`Module '${moduleName}' has an empty mutate list. Patterns: ${mod.mutate.join(', ')}`);
    process.exit(2);
  }

  const moduleReportDir = join(reportsDir, moduleName);
  mkdirSync(moduleReportDir, { recursive: true });

  // Build a temporary Stryker config for this module
  const strykerBaseContent = readFileSync(join(harnessRoot, 'mutation', 'stryker.base.mjs'), 'utf8');
  const baseMatch = strykerBaseContent.match(/export const strykerBase = (\{[\s\S]*\});/);
  const baseConfig = baseMatch ? JSON.parse(baseMatch[1]) : {};

  const config = {
    ...baseConfig,
    mutate: mutateFiles,
    tempDirName: `.stryker-tmp/${moduleName}`,
    thresholds: {
      high: mod.minimum,
      low: mod.minimum - 5,
      break: mod.minimum - 5,
    },
  };

  // Write temp config
  const configPath = join(harnessRoot, `.stryker.${moduleName}.config.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`\n=== Running mutation for module: ${moduleName} ===`);
  console.log(`Mutating ${mutateFiles.length} file(s): ${mutateFiles.join(', ')}`);
  console.log(`Minimum score: ${mod.minimum}%`);

  try {
    execSync(`npx stryker run ${configPath}`, {
      cwd: harnessRoot,
      stdio: 'inherit',
      timeout: 600000,
      env: { ...process.env, STRYKER: 'true' },
    });
  } catch (err) {
    console.error(`Stryker exited with code ${err.status ?? 'unknown'} for module ${moduleName}`);
  }

  // Stryker v9 writes to reports/mutation/mutation.json by default
  const defaultJson = join(harnessRoot, 'reports', 'mutation', 'mutation.json');
  const sandboxJson = join(harnessRoot, '.stryker-tmp', moduleName, 'reports', 'mutation', 'mutation.json');

  let jsonFound = false;
  if (existsSync(sandboxJson)) {
    cpSync(sandboxJson, join(moduleReportDir, 'mutation.json'));
    jsonFound = true;
  } else if (existsSync(defaultJson)) {
    cpSync(defaultJson, join(moduleReportDir, 'mutation.json'));
    jsonFound = true;
  }

  if (!jsonFound) {
    console.error(`No mutation.json found for module ${moduleName}`);
    process.exit(3);
  }

  // Clean up temp config
  try { writeFileSync(configPath, ''); } catch {}

  // Run threshold checker
  try {
    execSync(`node scripts/check-mutation-thresholds.mjs ${moduleName}`, {
      cwd: harnessRoot,
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }
}

function runPhase1() {
  const moduleNames = Object.keys(mutationModules);
  console.log(`\n=== Running Phase 1 mutation for all ${moduleNames.length} modules ===`);
  let allPassed = true;
  const aggregate = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };

  for (const mod of moduleNames) {
    try {
      runModule(mod);
      const jsonPath = join(reportsDir, mod, 'mutation.json');
      if (existsSync(jsonPath)) {
        const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
        const files = data.files || [];
        for (const f of files) {
          const mutants = f.mutants || [];
          aggregate.total += mutants.length;
          for (const m of mutants) {
            if (m.status === 'Killed') aggregate.killed++;
            else if (m.status === 'Timeout') aggregate.timeout++;
            else if (m.status === 'Survived') aggregate.survived++;
            else if (m.status === 'NoCoverage') aggregate.noCoverage++;
            else if (m.status === 'Ignored') aggregate.ignored++;
          }
        }
      }
    } catch {
      allPassed = false;
    }
  }

  const testableTotal = aggregate.total - aggregate.ignored;
  const aggregateScore = testableTotal > 0
    ? ((aggregate.killed + aggregate.timeout) / testableTotal) * 100
    : 0;

  const phase1Report = {
    aggregate: {
      ...aggregate,
      score: parseFloat(aggregateScore.toFixed(2)),
      required: phase1Minimum,
      status: aggregateScore >= phase1Minimum ? 'PASS' : 'FAIL',
    },
    modules: moduleNames.map(m => {
      const jp = join(reportsDir, m, 'mutation.json');
      if (!existsSync(jp)) return { module: m, status: 'MISSING' };
      const d = JSON.parse(readFileSync(jp, 'utf8'));
      const total = (d.files || []).reduce((s, f) => s + (f.mutants || []).length, 0);
      const killed = (d.files || []).reduce((s, f) => s + (f.mutants || []).filter(x => x.status === 'Killed').length, 0);
      const timeout = (d.files || []).reduce((s, f) => s + (f.mutants || []).filter(x => x.status === 'Timeout').length, 0);
      const survived = (d.files || []).reduce((s, f) => s + (f.mutants || []).filter(x => x.status === 'Survived').length, 0);
      const noCov = (d.files || []).reduce((s, f) => s + (f.mutants || []).filter(x => x.status === 'NoCoverage').length, 0);
      const ignored = (d.files || []).reduce((s, f) => s + (f.mutants || []).filter(x => x.status === 'Ignored').length, 0);
      const testable = total - ignored;
      const score = testable > 0 ? parseFloat(((killed + timeout) / testable * 100).toFixed(2)) : 0;
      const min = mutationModules[m].minimum;
      return { module: m, total, killed, timeout, survived, noCoverage: noCov, ignored, score, minimum: min, status: score >= min ? 'PASS' : 'FAIL' };
    }),
  };

  const phase1Dir = join(reportsDir, 'phase1');
  mkdirSync(phase1Dir, { recursive: true });
  writeFileSync(join(phase1Dir, 'mutation.json'), JSON.stringify(phase1Report, null, 2));

  console.log(`\n=== Phase 1 Aggregate ===`);
  console.log(`Score: ${phase1Report.aggregate.score}% (required: ${phase1Minimum}%)`);
  console.log(`Status: ${phase1Report.aggregate.status}`);

  if (!allPassed || phase1Report.aggregate.status === 'FAIL') {
    process.exit(1);
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/run-mutation.mjs <module|phase1>');
  process.exit(2);
}

if (arg === 'phase1') {
  runPhase1();
} else {
  runModule(arg);
}
