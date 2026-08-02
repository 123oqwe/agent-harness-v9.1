import { strykerBase } from "./stryker.base.mjs";

export default {
  ...strykerBase,
  mutate: ["packages/runtime-core/src/session-tree.ts"],
  testFiles: ["tests/phase-2/unit/ah-runtime-sessiontree-001.test.ts"],
  concurrency: 4,
  coverageAnalysis: "all",
  vitest: { configFile: "vitest.session-tree-pure.mutation.config.ts" },
  jsonReporter: { fileName: "coverage/session-tree-core-stryker.json" },
  htmlReporter: { fileName: "coverage/session-tree-core-stryker.html" },
  thresholds: { high: 90, low: 90, break: 90 },
};
