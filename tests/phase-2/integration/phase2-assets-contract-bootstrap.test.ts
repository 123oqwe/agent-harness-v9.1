import { describe, expect, it } from "vitest";

import {
  checkPhase2Assets,
  // @ts-expect-error The production checker intentionally ships as plain Node ESM.
} from "../../../scripts/gates/check-phase2-assets.mjs";

describe("Phase 2 asset contract bootstrap integration sentinel", () => {
  it("executes all structural contracts without claiming implementation evidence", () => {
    const result = checkPhase2Assets({ mode: "bootstrap" });

    expect(result.errors).toEqual([]);
    expect(result.claims).toEqual({
      requirementsVerified: 0,
      evidencePassed: 0,
    });
    expect(result.releaseReady).toBe(false);
  });
});
