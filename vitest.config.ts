import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.stryker-tmp/**',
      '**/spec/**',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'gateway/**/*.ts',
        'security/**/*.ts',
        'vfs/**/*.ts',
        'runtime/**/*.ts',
        'sandbox/**/*.ts',
        'router/**/*.ts',
        'session/**/*.ts',
        'skills/**/*.ts',
        'tools/**/*.ts',
        'verification/**/*.ts',
        'ingestion/**/*.ts',
        'domains/**/*.ts',
        'ui/**/*.ts',
        'harness.ts',
      ],
      exclude: ['**/*.d.ts', '**/*.test.ts', 'index.ts'],
      reporter: ['text', 'json', 'json-summary', 'html'],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
      },
    },
  },
});
