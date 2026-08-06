import { describe, expect, it, vi } from "vitest";

import {
  ModelGateway,
  ProviderDispatchError,
} from "../../../gateway/model-gateway.js";
import { ModelFallbackGatewayAdapter } from "../../../runtime/model-fallback-port.js";

const gatewayDouble = () => {
  const value = Object.create(ModelGateway.prototype) as ModelGateway;
  Object.defineProperties(value, {
    switchProvider: { value: vi.fn(() => ({ provider_id: "secondary" })) },
    dispatchExact: { value: vi.fn(async () => ({ provider_id: "secondary" })) },
  });
  return value;
};

describe("AH-RUNTIME-MODELFALLBACK-001 Gateway adapter", () => {
  it("requires the existing ModelGateway authority", () => {
    expect(() => new ModelFallbackGatewayAdapter({} as ModelGateway))
      .toThrow("ModelFallbackGatewayAdapter requires ModelGateway");
  });

  it("passes the complete visited chain to ModelGateway.switchProvider", () => {
    const gateway = gatewayDouble();
    const adapter = new ModelFallbackGatewayAdapter(gateway);
    const previous = {
      provider_id: "primary", registry_snapshot_hash: "a".repeat(64),
      provider_metadata_hash: "b".repeat(64), selection_request_hash: "c".repeat(64),
    };
    const selection = { request: "frozen" } as never;
    adapter.switchProvider(previous, selection, ["primary", "prior"]);
    expect(gateway.switchProvider).toHaveBeenCalledWith(previous, selection, ["primary", "prior"]);
  });

  it("forwards only Gateway-owned dispatch context fields", async () => {
    const gateway = gatewayDouble();
    const adapter = new ModelFallbackGatewayAdapter(gateway);
    const controller = new AbortController();
    const resolved = {
      provider_id: "secondary", registry_snapshot_hash: "a".repeat(64),
      provider_metadata_hash: "b".repeat(64), selection_request_hash: "c".repeat(64),
    };
    await adapter.dispatchExact(resolved, {} as never, {
      operation_id: "operation-1", attempt_id: "attempt-1", signal: controller.signal,
      deadline_at: "2026-08-03T00:00:00.000Z", context_generation: 2,
      context_manifest_hash: "d".repeat(64),
    });
    expect(gateway.dispatchExact).toHaveBeenCalledWith(resolved, {}, {
      operation_id: "operation-1", attempt_id: "attempt-1", signal: controller.signal,
      deadline_at: "2026-08-03T00:00:00.000Z",
    });
    await adapter.dispatchExact(resolved, {} as never, {
      operation_id: "operation-2", context_generation: 3, context_manifest_hash: "e".repeat(64),
    });
    expect(gateway.dispatchExact).toHaveBeenLastCalledWith(resolved, {}, { operation_id: "operation-2" });
  });

  it.each([
    [new Error("unknown"), false, "unclassified_failure"],
    [new ProviderDispatchError("provider_unhealthy"), true, "provider_unhealthy"],
    [new ProviderDispatchError("provider_failure", { kind: "rate_limited", retryable: true, detail: "retry" }), true, "retryable_provider_failure"],
    [new ProviderDispatchError("provider_failure", { kind: "rate_limited", retryable: false, detail: "stop" }), true, "rate_limited"],
    [new ProviderDispatchError("provider_failure", { kind: "auth", retryable: true, detail: "auth" }), false, "provider_failure"],
    [new ProviderDispatchError("provider_failure", { kind: "invalid_request", retryable: true, detail: "invalid" }), false, "provider_failure"],
    [new ProviderDispatchError("egress_denied"), false, "egress_denied"],
  ] as const)("classifies %s without weakening failure policy", (failure, fallback_allowed, reason_code) => {
    const adapter = new ModelFallbackGatewayAdapter(gatewayDouble());
    expect(adapter.classifyFailure(failure)).toEqual({ fallback_allowed, reason_code });
  });
});
