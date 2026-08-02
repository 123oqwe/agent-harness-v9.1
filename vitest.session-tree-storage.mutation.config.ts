import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testNamePattern: /AH-RUNTIME-SESSIONTREE-001 SQLite authority integration/,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.stryker-tmp/**",
      "**/spec/**",
      "coverage/**",
      "tests/coverage/**",
      "tests/glm-acceptance/**",
    ],
  },
});
