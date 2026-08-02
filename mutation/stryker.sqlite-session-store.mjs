import { strykerBase } from "./stryker.base.mjs";

export default {
  ...strykerBase,
  mutate: ["session/sqlite-session-store.ts"],
  testFiles: ["tests/session/sqlite-store.test.ts"],
  concurrency: 4,
  coverageAnalysis: "all",
  maxTestRunnerReuse: 1,
  vitest: { configFile: "vitest.mutation.config.ts" },
  jsonReporter: { fileName: "coverage/sqlite-session-store-stryker.json" },
  htmlReporter: { fileName: "coverage/sqlite-session-store-stryker.html" },
  thresholds: { high: 90, low: 90, break: 90 },
};
