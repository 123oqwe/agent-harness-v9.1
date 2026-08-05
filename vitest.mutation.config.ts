import { defineConfig } from 'vitest/config';

/**
 * Mutation-specific Vitest config.
 *
 * Differences from vitest.config.ts:
 * - Excludes tests/coverage/** (coverage-mirror tests are not valid mutation evidence)
 * - Excludes tests/glm-acceptance/** (requires GLM API key, not deterministic)
 * - Excludes tests/phase-2/** (Phase 2 tests test packages/* source files;
 *   their SQLite subprocess tests can timeout under mutation runner concurrency)
 * - Disables coverage thresholds (Stryker manages its own coverage analysis)
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.stryker-tmp/**',
      '**/spec/**',
      'coverage/**',
      // Coverage-mirror tests excluded: mutation acceptance must be earned
      // by behavioral unit, integration, and security tests.
      'tests/coverage/**',
      // GLM acceptance tests require a live API key and are non-deterministic
      'tests/glm-acceptance/**',
      // Phase 2 tests excluded from Phase 1 mutation: they test packages/*
      // source files and their SQLite subprocess tests timeout under load.
      'tests/phase-2/**',
    ],
  },
});
