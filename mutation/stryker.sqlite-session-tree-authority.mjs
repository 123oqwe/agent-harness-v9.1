import { strykerBase } from "./stryker.base.mjs";

export default {
  ...strykerBase,
  mutate: ["session/sqlite-session-tree-authority.ts"],
  testFiles: [
    "tests/phase-2/unit/ah-runtime-sessiontree-001.test.ts",
    "tests/phase-2/security/ah-runtime-sessiontree-001-security.test.ts",
  ],
  concurrency: 4,
  coverageAnalysis: "all",
  maxTestRunnerReuse: 1,
  vitest: { configFile: "vitest.session-tree-storage.mutation.config.ts" },
  jsonReporter: {
    fileName: "coverage/sqlite-session-tree-authority-stryker.json",
  },
  htmlReporter: {
    fileName: "coverage/sqlite-session-tree-authority-stryker.html",
  },
  thresholds: { high: 90, low: 90, break: 90 },
};
