// Shared Stryker configuration base.
// Uses vitest.mutation.config.ts (NOT vitest.config.ts) so mutation acceptance
// is earned by real behavioral tests, not coverage-mirror tests.
export const strykerBase = {
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  timeoutMS: 30000,
  // @stryker-mutator/vitest-runner 9.6.1 still supplies Vitest's removed
  // poolOptions shape. One isolated runner avoids native-addon/Vitest worker
  // crashes while retaining complete mutant and behavioral-test coverage.
  concurrency: 1,
  vitest: {
    configFile: 'vitest.mutation.config.ts',
  },
  thresholds: {
    high: 80,
    low: 70,
    break: 70,
  },
  symlinkNodeModules: true,
  cleanTempDir: 'always',
};
