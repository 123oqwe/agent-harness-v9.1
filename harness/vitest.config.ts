import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.stryker-tmp/**',
      'coverage/**',
      // When running under Stryker, exclude tests that depend on external
      // spec/ directory (not available in the Stryker sandbox).
      ...(process.env.STRYKER === 'true'
        ? [
            'tests/contracts/**',
            'tests/state-machines/**',
            'tests/threat-model/**',
            'tests/api/**',
            'tests/spikes/**',
            'tests/gateway/scripted-provider.test.ts',
          ]
        : []),
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
        'eslint.config.js',
        'stryker.config.json',
      ],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
      },
    },
  },
});
