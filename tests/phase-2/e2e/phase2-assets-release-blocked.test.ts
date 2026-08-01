import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Phase 2 asset contract release sentinel", () => {
  it("fails closed because real public and consented datasets are not yet authorized", () => {
    const checker = resolve("scripts/gates/check-phase2-assets.mjs");
    const result = spawnSync(process.execPath, [checker, "--mode", "release"], {
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      releaseReady: false,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    });
  });
});
