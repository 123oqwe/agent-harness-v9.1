/**
 * Mutation infrastructure tests.
 *
 * Verifies that the mutation runner and checker are structurally sound:
 * - All files in the module manifest exist on disk
 * - Equivalent mutants use exact Stryker mutant IDs (not file+line)
 * - Report source files must match module configuration
 * - Empty mutate lists are rejected
 * - Gateway report cannot satisfy identitySecrets module
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const harnessRoot = resolve(import.meta.dirname, '..', '..');
const equivPath = join(harnessRoot, 'mutation', 'equivalent-mutants.json');
const checkerPath = join(harnessRoot, 'scripts', 'check-mutation-thresholds.mjs');
const runnerPath = join(harnessRoot, 'scripts', 'run-mutation.mjs');

const equivSource = readFileSync(equivPath, 'utf8');
const checkerSource = readFileSync(checkerPath, 'utf8');
const runnerSource = readFileSync(runnerPath, 'utf8');

interface ModuleConfig { mutate: string[]; minimum: number; perFileMinimum?: number }
type ModulesMap = Record<string, ModuleConfig>;

// Read and eval the modules.mjs to get the export (can't import .mjs in TS)
const modulesSource = readFileSync(join(harnessRoot, 'mutation', 'modules.mjs'), 'utf8');
function parseModules(): ModulesMap {
  // Extract the mutationModules object from source
  const match = modulesSource.match(/export const mutationModules = (\{[\s\S]*?\n\});/);
  if (!match) throw new Error('cannot parse mutationModules from source');
  // Use eval to parse (safe: we control the source)
  return eval(`(${match[1]})`);
}

describe('Mutation infrastructure', () => {
  describe('Module manifest', () => {
    it('every file in every module exists on disk', () => {
      const mods = parseModules();
      const missing: string[] = [];
      for (const [moduleName, mod] of Object.entries(mods)) {
        for (const pattern of mod.mutate) {
          if (pattern.includes('*')) {
            // Skip glob patterns — validated separately
            continue;
          }
          if (!existsSync(join(harnessRoot, pattern))) {
            missing.push(`${moduleName}: ${pattern}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it('no module has an empty mutate list', () => {
      const mods = parseModules();
      for (const [name, mod] of Object.entries(mods)) {
        expect(mod.mutate.length, `module ${name} has empty mutate list`).toBeGreaterThan(0);
      }
    });

    it('every module has a minimum score', () => {
      const mods = parseModules();
      for (const [name, mod] of Object.entries(mods)) {
        expect(mod.minimum, `module ${name} missing minimum`).toBeGreaterThan(0);
      }
    });

    it('strategies module does not point to non-existent files', () => {
      const mods = parseModules();
      const strategies = mods.strategies!;
      for (const f of strategies.mutate) {
        expect(existsSync(join(harnessRoot, f)), `strategies file does not exist: ${f}`).toBe(true);
      }
    });
  });

  describe('Equivalent mutant waivers', () => {
    it('equivalent-mutants.json is valid JSON array', () => {
      const arr = JSON.parse(equivSource);
      expect(Array.isArray(arr)).toBe(true);
    });

    it('every waiver has a strykerMutantId field (not file+line matching)', () => {
      const arr = JSON.parse(equivSource);
      for (const eq of arr) {
        expect(eq.strykerMutantId, 'waiver missing strykerMutantId').toBeDefined();
        expect(typeof eq.strykerMutantId).toBe('string');
      }
    });

    it('every waiver has a human reviewer (not agent)', () => {
      const arr = JSON.parse(equivSource);
      for (const eq of arr) {
        expect(eq.reviewedBy, 'waiver missing reviewedBy').toBeDefined();
        expect(eq.reviewedBy).not.toBe('agent');
      }
    });

    it('checker uses exact mutant ID matching, not file+line', () => {
      expect(checkerSource).toContain('equivalentMutantIds.has(m.id)');
      expect(checkerSource).not.toContain('eqLineMatch');
    });
  });

  describe('Runner guarantees', () => {
    it('runner deletes old report before running', () => {
      expect(runnerSource).toContain('rmSync(moduleReportDir');
    });

    it('runner fails on Stryker non-zero exit (no fallback copy)', () => {
      expect(runnerSource).toContain('Stryker exited with code');
      expect(runnerSource).toContain('throw new Error');
    });

    it('runner validates report source files match module config', () => {
      expect(runnerSource).toContain('missingFromReport');
      expect(runnerSource).toContain('extraInReport');
      expect(runnerSource).toContain('Report source file mismatch');
    });

    it('runner deletes shared reports/mutation/mutation.json before running', () => {
      expect(runnerSource).toContain('rmSync(sharedJson');
    });

    it('runModule does not call process.exit inside the function', () => {
      const runModuleStart = runnerSource.indexOf('function runModule(');
      const runModuleEnd = runnerSource.indexOf('function countFromReport(');
      const runModuleBody = runnerSource.substring(runModuleStart, runModuleEnd);
      expect(runModuleBody).not.toContain('process.exit');
    });
  });

  describe('Checker guarantees', () => {
    it('checker validates report source files match module config', () => {
      expect(checkerSource).toContain('Source file mismatch');
    });

    it('checker does not match equivalent mutants by file+line', () => {
      expect(checkerSource).not.toContain('eqLineMatch');
    });
  });

  describe('Cross-contamination prevention', () => {
    it('gateway report cannot satisfy identitySecrets module', () => {
      const gatewayReportPath = join(harnessRoot, 'reports', 'mutation', 'gateway', 'mutation.json');
      if (!existsSync(gatewayReportPath)) return;

      const report = JSON.parse(readFileSync(gatewayReportPath, 'utf8'));
      const reportFiles = Object.keys(report.files || {}).sort();
      const identityFiles = ['security/auth.ts', 'security/secrets-broker.ts'];
      const intersection = reportFiles.filter(f => identityFiles.includes(f));
      expect(intersection.length, 'gateway report contains identitySecrets files').toBe(0);
    });

    it('mock report with wrong source files would be rejected', () => {
      expect(checkerSource).toContain('Source file mismatch');
      expect(checkerSource).toContain('reportFiles');
      expect(checkerSource).toContain('expectedFiles');
    });
  });
});
