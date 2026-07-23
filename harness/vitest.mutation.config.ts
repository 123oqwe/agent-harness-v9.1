import { defineConfig } from 'vitest/config';

// Mutation-specific vitest config: excludes coverage-mirror tests
// so mutation acceptance is earned by real behavioral tests.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.stryker-tmp/**',
      'coverage/**',
      'tests/coverage/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'gateway/**/*.ts',
        'router/**/*.ts',
        'runtime/**/*.ts',
        'security/**/*.ts',
        'session/**/*.ts',
        'vfs/**/*.ts',
        'tools/**/*.ts',
        'ingestion/**/*.ts',
        'verification/evidence.ts',
        'verification/eval-runner.ts',
        'domains/**/*.ts',
        'research/**/*.ts',
        'writing/**/*.ts',
        'planning/**/*.ts',
        'personal_assistant/**/*.ts',
        'ui/**/*.ts',
        'index.ts',
      ],
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        'verification/glm-acceptance.ts',
        '**/*.d.ts',
        '**/*.test.ts',
        'vitest.config.ts',
        'vitest.mutation.config.ts',
        'eslint.config.js',
      ],
    },
  },
});
