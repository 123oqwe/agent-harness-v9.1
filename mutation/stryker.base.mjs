// Shared Stryker configuration base.
// Uses vitest.mutation.config.ts (NOT vitest.config.ts) so mutation acceptance
// is earned by real behavioral tests, not coverage-mirror tests.
export const strykerBase = {
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  timeoutMS: 300000,
  dryRunTimeoutMinutes: 10,
  // The checked-in compatibility patch gives every Vitest run a process
  // boundary, so Stryker can safely parallelize four mutant workers.
  concurrency: 4,
  vitest: {
    configFile: 'vitest.mutation.config.ts',
  },
  ignorePatterns: ['/reports', '.stryker-tmp'],
  thresholds: {
    high: 80,
    low: 70,
    break: 70,
  },
  symlinkNodeModules: true,
  cleanTempDir: 'always',
};
