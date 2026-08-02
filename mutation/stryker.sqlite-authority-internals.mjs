import { strykerBase } from "./stryker.base.mjs";

export default {
  ...strykerBase,
  mutate: ["session/sqlite-authority-internals.ts"],
  testFiles: [
    "tests/phase-2/unit/ah-runtime-sessiontree-001.test.ts",
    "tests/session/sqlite-store.test.ts",
  ],
  concurrency: 4,
  coverageAnalysis: "all",
  maxTestRunnerReuse: 1,
  vitest: { configFile: "vitest.mutation.config.ts" },
  jsonReporter: { fileName: "coverage/sqlite-authority-internals-stryker.json" },
  htmlReporter: { fileName: "coverage/sqlite-authority-internals-stryker.html" },
  thresholds: { high: 90, low: 90, break: 90 },
};
