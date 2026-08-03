import { describe, expect, it, vi } from "vitest";

import {
  ModelFallbackController,
  type FallbackResolvedProvider,
} from "../../../packages/runtime-core/src/model-fallback.js";

const resolved = (provider_id: string, overrides: Partial<FallbackResolvedProvider> = {}): FallbackResolvedProvider => ({
  provider_id,
  registry_snapshot_hash: "a".repeat(64),
  provider_metadata_hash: "b".repeat(64),
  selection_request_hash: "c".repeat(64),
  ...overrides,
});

describe("AH-RUNTIME-MODELFALLBACK-001 security invariants", () => {
  it("rejects a candidate that escapes the frozen registry or selection binding", async () => {
    const invalidate = vi.fn();
    const recompile = vi.fn();
    const dispatchExact = vi.fn();
    const controller = new ModelFallbackController({
      gateway: {
        switchProvider: () => resolved("secondary", {
          registry_snapshot_hash: "d".repeat(64),
          selection_request_hash: "e".repeat(64),
        }),
        dispatchExact,
        classifyFailure: () => ({ fallback_allowed: true, reason_code: "transient" }),
      },
      cache: { invalidate },
      context: { recompile },
    });

    await expect(controller.execute({
      current_provider: resolved("primary"), selection_request: {},
      dispatch_context: { operation_id: "operation-1" }, context_generation: 1,
      visited_provider_ids: ["primary"], initial_failure: new Error("failed"),
    })).rejects.toMatchObject({ code: "invalid_fallback_state", reason_code: "candidate_binding" });
    expect(invalidate).not.toHaveBeenCalled();
    expect(recompile).not.toHaveBeenCalled();
    expect(dispatchExact).not.toHaveBeenCalled();
  });

  it("rejects duplicate visited providers and generation overflow before Gateway access", async () => {
    const switchProvider = vi.fn();
    const controller = new ModelFallbackController({
      gateway: {
        switchProvider, dispatchExact: vi.fn(),
        classifyFailure: () => ({ fallback_allowed: true, reason_code: "transient" }),
      },
      cache: { invalidate: vi.fn() }, context: { recompile: vi.fn() },
    });
    const base = {
      current_provider: resolved("primary"), selection_request: {},
      dispatch_context: { operation_id: "operation-1" }, initial_failure: new Error("failed"),
    };
    await expect(controller.execute({
      ...base, context_generation: 1, visited_provider_ids: ["primary", "primary"],
    })).rejects.toMatchObject({ code: "invalid_fallback_state", reason_code: "duplicate_visited_provider" });
    await expect(controller.execute({
      ...base, context_generation: Number.MAX_SAFE_INTEGER, visited_provider_ids: ["primary"],
    })).rejects.toMatchObject({ code: "invalid_fallback_state", reason_code: "context_generation" });
    expect(switchProvider).not.toHaveBeenCalled();
  });
});
