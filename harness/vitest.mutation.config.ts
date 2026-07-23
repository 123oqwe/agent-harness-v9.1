import { defineConfig } from 'vitest/config';

/**
 * Mutation-specific Vitest config.
 *
 * Differences from vitest.config.ts:
 * - Excludes tests/coverage/** (coverage-mirror tests are not valid mutation evidence)
 * - Excludes tests/glm-acceptance/** (requires GLM API key, not deterministic)
 * - Disables coverage thresholds (Stryker manages its own coverage analysis)
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.stryker-tmp/**',
      'coverage/**',
      // Coverage-mirror tests excluded: mutation acceptance must be earned
      // by behavioral unit, integration, and security tests.
      'tests/coverage/**',
      // GLM acceptance tests require a live API key and are non-deterministic
      'tests/glm-acceptance/**',
    ],
  },
});
