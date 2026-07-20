import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.stryker-tmp/**'],
    coverage: {
      provider: 'v8',
      include: ['gateway/**/*.ts'],
      exclude: ['**/*.d.ts'],
      reporter: ['text', 'json', 'json-summary', 'html'],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
      },
    },
  },
});
