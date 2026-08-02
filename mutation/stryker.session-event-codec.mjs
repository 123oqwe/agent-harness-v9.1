import { strykerBase } from "./stryker.base.mjs";

export default {
  ...strykerBase,
  mutate: ["session/session-event-codec.ts"],
  testFiles: [
    "tests/phase-2/unit/ah-runtime-sessiontree-001.test.ts",
    "tests/session/durable-authority.test.ts",
  ],
  concurrency: 4,
  coverageAnalysis: "all",
  maxTestRunnerReuse: 1,
  vitest: { configFile: "vitest.mutation.config.ts" },
  jsonReporter: { fileName: "coverage/session-event-codec-stryker.json" },
  htmlReporter: { fileName: "coverage/session-event-codec-stryker.html" },
  thresholds: { high: 90, low: 90, break: 90 },
};
