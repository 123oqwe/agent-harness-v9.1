#!/usr/bin/env node
/**
 * Reads raw Stryker JSON and reports mutation metrics.
 * Verifies module and per-file floors.
 * Returns non-zero when a floor fails.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationModules, phase1Minimum } from '../mutation/modules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, '..');
const reportsDir = join(harnessRoot, 'reports', 'mutation');

function readStrykerJson(moduleName) {
  const p = join(reportsDir, moduleName, 'mutation.json');
  if (!existsSync(p)) {
    console.error(`No mutation.json for module '${moduleName}' at ${p}`);
    process.exit(3);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function countMutants(data) {
  const files = data.files || [];
  const result = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
  for (const f of files) {
    for (const m of f.mutants || []) {
      result.total++;
      switch (m.status) {
        case 'Killed': result.killed++; break;
        case 'Timeout': result.timeout++; break;
        case 'Survived': result.survived++; break;
        case 'NoCoverage': result.noCoverage++; break;
        case 'Ignored': result.ignored++; break;
      }
    }
  }
  return result;
}

function computeScore(counts) {
  const testable = counts.total - counts.ignored;
  if (testable === 0) return 0;
  return parseFloat(((counts.killed + counts.timeout) / testable * 100).toFixed(2));
}

function checkModule(moduleName) {
  const mod = mutationModules[moduleName];
  if (!mod) {
    console.error(`Unknown module: ${moduleName}`);
    process.exit(2);
  }

  const data = readStrykerJson(moduleName);
  const counts = countMutants(data);
  const score = computeScore(counts);

  console.log(`\n=== Mutation Report: ${moduleName} ===`);
  console.log(`Source files: ${(data.files || []).map(f => f.name).join(', ') || 'N/A'}`);
  console.log(`Total mutants:  ${counts.total}`);
  console.log(`Killed:         ${counts.killed}`);
  console.log(`Timeout:        ${counts.timeout}`);
  console.log(`Survived:       ${counts.survived}`);
  console.log(`No coverage:    ${counts.noCoverage}`);
  console.log(`Ignored:        ${counts.ignored}`);
  console.log(`Mutation score: ${score}%`);
  console.log(`Required score: ${mod.minimum}%`);
  console.log(`Status:         ${score >= mod.minimum ? 'PASS' : 'FAIL'}`);

  let failed = score < mod.minimum;

  if (mod.perFileMinimum) {
    for (const f of data.files || []) {
      const mutants = f.mutants || [];
      const fc = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
      for (const m of mutants) {
        fc.total++;
        switch (m.status) {
          case 'Killed': fc.killed++; break;
          case 'Timeout': fc.timeout++; break;
          case 'Survived': fc.survived++; break;
          case 'NoCoverage': fc.noCoverage++; break;
          case 'Ignored': fc.ignored++; break;
        }
      }
      const fScore = computeScore(fc);
      if (fScore < mod.perFileMinimum) {
        console.log(`  [FAIL] ${f.name}: ${fScore}% < ${mod.perFileMinimum}%`);
        failed = true;
      } else {
        console.log(`  [OK]   ${f.name}: ${fScore}% >= ${mod.perFileMinimum}%`);
      }
    }
  }

  if (counts.survived > 0 || counts.noCoverage > 0) {
    console.log(`\nSurviving / uncovered mutants:`);
    for (const f of data.files || []) {
      for (const m of f.mutants || []) {
        if (m.status === 'Survived' || m.status === 'NoCoverage') {
          console.log(`  [${m.status}] ${f.name}:${m.location?.start?.line ?? '?'} - ${m.mutatorName} (${m.replacement ?? m.description ?? 'N/A'})`);
        }
      }
    }
  }

  if (failed) process.exit(1);
}

function checkPhase1() {
  const phase1Path = join(reportsDir, 'phase1', 'mutation.json');
  if (!existsSync(phase1Path)) {
    console.error('No phase1/mutation.json found. Run with phase1 first.');
    process.exit(3);
  }
  const data = JSON.parse(readFileSync(phase1Path, 'utf8'));
  const agg = data.aggregate;
  console.log(`\n=== Phase 1 Aggregate ===`);
  console.log(`Score: ${agg.score}% (required: ${agg.required}%)`);
  console.log(`Status: ${agg.status}`);
  console.log(`\nPer-module:`);
  let failed = false;
  for (const m of data.modules) {
    if (m.status === 'FAIL') failed = true;
    console.log(`  ${m.module}: ${m.score}% / ${m.minimum}% [${m.status}] (S:${m.survived} NC:${m.noCoverage})`);
  }
  if (failed || agg.status === 'FAIL') process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/check-mutation-thresholds.mjs <module|phase1>');
  process.exit(2);
}
if (arg === 'phase1') checkPhase1();
else checkModule(arg);
