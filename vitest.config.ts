import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.stryker-tmp/**'],
    coverage: {
      provider: 'v8',
      include: [
        'gateway/**/*.ts',
        'security/**/*.ts',
        'vfs/**/*.ts',
        'runtime/**/*.ts',
        'router/**/*.ts',
        'session/**/*.ts',
        'tools/**/*.ts',
        'verification/**/*.ts',
        'ingestion/**/*.ts',
        'domains/**/*.ts',
        'research/**/*.ts',
        'writing/**/*.ts',
        'planning/**/*.ts',
        'personal_assistant/**/*.ts',
        'ui/**/*.ts',
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
