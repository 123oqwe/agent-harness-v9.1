import { describe, expect, it } from "vitest";

import {
  checkPhase2Assets,
  // @ts-expect-error The production checker intentionally ships as plain Node ESM.
} from "../../../scripts/gates/check-phase2-assets.mjs";

describe("Phase 2 asset contract security sentinel", () => {
  it("rejects unknown modes instead of weakening release checks", () => {
    const result = checkPhase2Assets({ mode: "permissive" });

    expect(result.errors).toEqual([
      "unsupported verification mode: permissive",
    ]);
    expect(result.releaseReady).toBe(false);
    expect(result.claims).toEqual({
      requirementsVerified: 0,
      evidencePassed: 0,
    });
  });
});
