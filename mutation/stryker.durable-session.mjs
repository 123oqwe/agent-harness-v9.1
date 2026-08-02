import { strykerBase } from "./stryker.base.mjs";

export default {
  ...strykerBase,
  mutate: ["session/durable-session.ts"],
  testFiles: [
    "tests/session/durable.test.ts",
    "tests/session/durable-authority.test.ts",
    "tests/session/file-persistence.test.ts",
    "tests/phase-2/unit/ah-runtime-sessiontree-001.test.ts",
  ],
  concurrency: 4,
  coverageAnalysis: "all",
  maxTestRunnerReuse: 1,
  vitest: { configFile: "vitest.mutation.config.ts" },
  jsonReporter: { fileName: "coverage/durable-session-stryker.json" },
  htmlReporter: { fileName: "coverage/durable-session-stryker.html" },
  thresholds: { high: 90, low: 90, break: 90 },
};
