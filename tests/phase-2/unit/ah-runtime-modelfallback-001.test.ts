import { describe, expect, it, vi } from "vitest";

import {
  ModelFallbackController,
  type FallbackResolvedProvider,
} from "../../../packages/runtime-core/src/model-fallback.js";

const provider = (provider_id: string): FallbackResolvedProvider => ({
  provider_id,
  registry_snapshot_hash: "a".repeat(64),
  provider_metadata_hash: "d".repeat(64),
  selection_request_hash: "b".repeat(64),
});

describe("AH-RUNTIME-MODELFALLBACK-001 model fallback", () => {
  it("requires every control port", () => {
    const good = {
      gateway: { switchProvider: vi.fn(), dispatchExact: vi.fn(), classifyFailure: vi.fn() },
      cache: { invalidate: vi.fn() }, context: { recompile: vi.fn() },
    };
    for (const mutate of [
      () => undefined,
      () => ({ ...good, gateway: { ...good.gateway, switchProvider: undefined } }),
      () => ({ ...good, gateway: { ...good.gateway, dispatchExact: undefined } }),
      () => ({ ...good, gateway: { ...good.gateway, classifyFailure: undefined } }),
      () => ({ ...good, cache: { invalidate: undefined } }),
      () => ({ ...good, context: { recompile: undefined } }),
    ]) expect(() => new ModelFallbackController(mutate() as never)).toThrow("ModelFallbackController ports are required");
  });

  it("invalidates and fully recompiles context before exact dispatch on every hop", async () => {
    const primary = provider("primary");
    const secondary = provider("secondary");
    const tertiary = provider("tertiary");
    const switchProvider = vi
      .fn()
      .mockReturnValueOnce(secondary)
      .mockReturnValueOnce(tertiary);
    const dispatchExact = vi
      .fn()
      .mockRejectedValueOnce(new Error("secondary unavailable"))
      .mockResolvedValueOnce({ provider_id: "tertiary", response: { text: "ok" } });
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const recompile = vi.fn(async ({ provider_id, context_generation }) => ({
      provider_id,
      context_generation,
      manifest_hash: `${provider_id}-${context_generation}`,
    }));
    const controller = new ModelFallbackController({
      gateway: {
        switchProvider,
        dispatchExact,
        classifyFailure: () => ({ fallback_allowed: true, reason_code: "transient" }),
      },
      cache: { invalidate },
      context: { recompile },
    });

    const result = await controller.execute({
      current_provider: primary,
      selection_request: { request: "same-frozen-selection" },
      dispatch_context: { operation_id: "operation-1" },
      context_generation: 7,
      visited_provider_ids: ["primary"],
      initial_failure: new Error("primary unavailable"),
    });

    expect(result.provider.provider_id).toBe("tertiary");
    expect(result.context_generation).toBe(9);
    expect(result.visited_provider_ids).toEqual(["primary", "secondary", "tertiary"]);
    expect(invalidate.mock.calls).toEqual([
      [{ context_generation: 7, provider_id: "primary", reason: "model_fallback" }],
      [{ context_generation: 8, provider_id: "secondary", reason: "model_fallback" }],
    ]);
    expect(recompile.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ provider_id: "secondary", context_generation: 8, full_recompute: true }),
      expect.objectContaining({ provider_id: "tertiary", context_generation: 9, full_recompute: true }),
    ]);
    expect(dispatchExact).toHaveBeenNthCalledWith(
      1,
      secondary,
      { request: "same-frozen-selection" },
      { operation_id: "operation-1", context_generation: 8, context_manifest_hash: "secondary-8" },
    );
    expect(dispatchExact).toHaveBeenNthCalledWith(
      2,
      tertiary,
      { request: "same-frozen-selection" },
      { operation_id: "operation-1", context_generation: 9, context_manifest_hash: "tertiary-9" },
    );
    expect(switchProvider.mock.calls[0]![2]).toEqual(["primary"]);
    expect(switchProvider.mock.calls[1]![2]).toEqual(["primary", "secondary"]);
  });

  it("never dispatches when context recomputation fails", async () => {
    const dispatchExact = vi.fn();
    const controller = new ModelFallbackController({
      gateway: {
        switchProvider: () => provider("secondary"),
        dispatchExact,
        classifyFailure: () => ({ fallback_allowed: true, reason_code: "transient" }),
      },
      cache: { invalidate: vi.fn() },
      context: { recompile: vi.fn().mockRejectedValue(new Error("context incompatible")) },
    });

    await expect(controller.execute({
      current_provider: provider("primary"),
      selection_request: {},
      dispatch_context: { operation_id: "operation-1" },
      context_generation: 0,
      visited_provider_ids: ["primary"],
      initial_failure: new Error("primary unavailable"),
    })).rejects.toThrow("context incompatible");
    expect(dispatchExact).not.toHaveBeenCalled();
  });

  it("rejects a visited candidate before cache, context, or provider access", async () => {
    const invalidate = vi.fn();
    const recompile = vi.fn();
    const dispatchExact = vi.fn();
    const controller = new ModelFallbackController({
      gateway: {
        switchProvider: () => provider("primary"),
        dispatchExact,
        classifyFailure: () => ({ fallback_allowed: true, reason_code: "transient" }),
      },
      cache: { invalidate },
      context: { recompile },
    });

    await expect(controller.execute({
      current_provider: provider("primary"), selection_request: {},
      dispatch_context: { operation_id: "operation-1" }, context_generation: 0,
      visited_provider_ids: ["primary"], initial_failure: new Error("failed"),
    })).rejects.toMatchObject({ code: "fallback_loop" });
    expect(invalidate).not.toHaveBeenCalled();
    expect(recompile).not.toHaveBeenCalled();
    expect(dispatchExact).not.toHaveBeenCalled();
  });

  it("does not fallback for auth, invalid-request, policy, or non-retryable failures", async () => {
    const switchProvider = vi.fn();
    const controller = new ModelFallbackController({
      gateway: {
        switchProvider,
        dispatchExact: vi.fn(),
        classifyFailure: () => ({ fallback_allowed: false, reason_code: "auth" }),
      },
      cache: { invalidate: vi.fn() },
      context: { recompile: vi.fn() },
    });

    await expect(controller.execute({
      current_provider: provider("primary"), selection_request: {},
      dispatch_context: { operation_id: "operation-1" }, context_generation: 0,
      visited_provider_ids: ["primary"], initial_failure: new Error("auth"),
    })).rejects.toEqual(expect.objectContaining({ code: "fallback_forbidden" }));
    expect(switchProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["provider id", { current_provider: provider("../primary") }],
    ["operation id", { dispatch_context: { operation_id: "../operation" } }],
    ["negative generation", { context_generation: -1 }],
    ["fractional generation", { context_generation: 1.5 }],
    ["visited shape", { visited_provider_ids: null }],
    ["unsafe visited id", { visited_provider_ids: ["primary", "../bad"] }],
    ["missing current visit", { visited_provider_ids: ["other"] }],
  ])("rejects invalid %s before fallback selection", async (_label, override) => {
    const switchProvider = vi.fn();
    const controller = new ModelFallbackController({
      gateway: { switchProvider, dispatchExact: vi.fn(), classifyFailure: vi.fn(() => ({ fallback_allowed: true, reason_code: "transient" })) },
      cache: { invalidate: vi.fn() }, context: { recompile: vi.fn() },
    });
    await expect(controller.execute({
      current_provider: provider("primary"), selection_request: {},
      dispatch_context: { operation_id: "operation-1" }, context_generation: 1,
      visited_provider_ids: ["primary"], initial_failure: new Error("failed"),
      ...override,
    } as never)).rejects.toMatchObject({ code: "invalid_fallback_state" });
    expect(switchProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["registry_snapshot_hash", "x".repeat(64)],
    ["provider_metadata_hash", "A".repeat(64)],
    ["selection_request_hash", "short"],
  ] as const)("rejects malformed current %s", async (field, value) => {
    const controller = new ModelFallbackController({
      gateway: { switchProvider: vi.fn(), dispatchExact: vi.fn(), classifyFailure: vi.fn() },
      cache: { invalidate: vi.fn() }, context: { recompile: vi.fn() },
    });
    await expect(controller.execute({
      current_provider: { ...provider("primary"), [field]: value }, selection_request: {},
      dispatch_context: { operation_id: "operation-1" }, context_generation: 1,
      visited_provider_ids: ["primary"], initial_failure: new Error("failed"),
    })).rejects.toMatchObject({ code: "invalid_fallback_state" });
  });

  it.each([
    ["provider", { provider_id: "wrong", context_generation: 2, manifest_hash: "m" }],
    ["generation", { provider_id: "secondary", context_generation: 3, manifest_hash: "m" }],
    ["manifest", { provider_id: "secondary", context_generation: 2, manifest_hash: "../bad" }],
  ])("rejects mismatched compiled %s before dispatch", async (_label, compiled) => {
    const dispatchExact = vi.fn();
    const controller = new ModelFallbackController({
      gateway: {
        switchProvider: () => provider("secondary"), dispatchExact,
        classifyFailure: () => ({ fallback_allowed: true, reason_code: "transient" }),
      },
      cache: { invalidate: vi.fn() }, context: { recompile: vi.fn().mockResolvedValue(compiled) },
    });
    await expect(controller.execute({
      current_provider: provider("primary"), selection_request: {},
      dispatch_context: { operation_id: "operation-1" }, context_generation: 1,
      visited_provider_ids: ["primary"], initial_failure: new Error("failed"),
    })).rejects.toMatchObject({ code: "invalid_fallback_state", reason_code: "compiled_context" });
    expect(dispatchExact).not.toHaveBeenCalled();
  });
});
