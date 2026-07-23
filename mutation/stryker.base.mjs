// Shared Stryker configuration base. Module-specific configs merge this.
export const strykerBase = {
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  timeoutMS: 30000,
  concurrency: 4,
  vitest: {
    configFile: 'vitest.mutation.config.ts',
  },
  thresholds: {
    high: 80,
    low: 70,
    break: 70,
  },
  symlinkNodeModules: true,
};
