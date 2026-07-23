// Shared Stryker configuration base. Module-specific configs merge this.
// Uses vitest.config.ts (not vitest.mutation.config.ts) because tests
// depend on spec/ directory access via HARNESS_SPEC_ROOT env var.
export const strykerBase = {
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  timeoutMS: 30000,
  concurrency: 4,
  vitest: {
    configFile: 'vitest.config.ts',
  },
  thresholds: {
    high: 80,
    low: 70,
    break: 70,
  },
  symlinkNodeModules: true,
  cleanTempDir: 'always',
};
