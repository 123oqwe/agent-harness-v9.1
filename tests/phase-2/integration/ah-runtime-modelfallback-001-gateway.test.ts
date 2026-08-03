import { describe, expect, it, vi } from "vitest";

import {
  FrozenProviderRegistry,
  ModelGateway,
  type GatewayProviderRegistration,
  type GatewayProviderRuntime,
  type ProviderSelectionRequest,
} from "../../../gateway/model-gateway.js";
import {
  ProviderHttpError,
  ScriptedTestProvider,
  scriptedProviderContract,
  type ParsedResponse,
} from "../../../gateway/scripted-provider.js";
import { ModelFallbackGatewayAdapter } from "../../../runtime/model-fallback-port.js";
import { ModelFallbackController } from "../../../packages/runtime-core/src/model-fallback.js";

const runtime = (response?: ParsedResponse) => {
  const provider = new ScriptedTestProvider({ queue: [response ?? {
    content: "ok", model: "scripted", stop_reason: "stop",
    usage: { input_tokens: 3, output_tokens: 2 },
  }] });
  const adapter: GatewayProviderRuntime = {
    provider_type: provider.provider_type,
    normalizeRequest: provider.normalizeRequest.bind(provider),
    parseResponse: provider.parseResponse.bind(provider),
    normalizeToolCall: provider.normalizeToolCall.bind(provider),
    streamEvents: provider.streamEvents.bind(provider),
    mapError: provider.mapError.bind(provider),
    meterUsage: provider.meterUsage.bind(provider),
    checkHealth: provider.checkHealth.bind(provider),
    validateDataPolicy: provider.validateDataPolicy.bind(provider),
    resolve: provider.resolve.bind(provider),
  };
  return { adapter, provider };
};

const registration = (provider_id: string, adapter: GatewayProviderRuntime): GatewayProviderRegistration => ({
  provider_id, contract: scriptedProviderContract, adapter,
  metadata: {
    capabilities: ["text_reasoning", "vision_understanding"],
    max_context_tokens: 8_192, structured_output: true, tool_calling: true,
    data_policy: { execution: "remote", regions: ["eu"], retention_days: 0, training_allowed: false },
    pricing: { currency: "USD", input_per_million: 1, output_per_million: 1 },
    health: "healthy",
    network: { required: true, destination: "https://provider.invalid" },
    credentials: { required: true, audience: "provider-api" },
  },
});

describe("AH-RUNTIME-MODELFALLBACK-001 existing ModelGateway integration", () => {
  it("revalidates selection, egress, and brokered credentials after context recompute", async () => {
    const primary = runtime();
    primary.adapter.resolve = vi.fn(() => { throw new ProviderHttpError(429); });
    const secondary = runtime();
    const registry = new FrozenProviderRegistry([
      registration("provider-a", primary.adapter),
      registration("provider-b", secondary.adapter),
    ]);
    const authorize = vi.fn(async () => ({ allowed: true }));
    const exchangeCredential = vi.fn(async () => ({
      lease_id: "lease", audience: "provider-api", expires_at: "2030-01-01T00:00:00.000Z",
    }));
    const gateway = new ModelGateway(registry, {
      egressPolicy: { authorize }, secretsBroker: { exchangeCredential },
      usageMeter: { record: vi.fn(async () => undefined) },
      clock: { now: () => Date.parse("2026-08-03T00:00:00.000Z"), sleep: vi.fn(async () => undefined) },
    });
    const selection: ProviderSelectionRequest = {
      registry_snapshot_hash: registry.snapshot.hash,
      request: { messages: [{ role: "user", content: "inspect image" }], max_tokens: 64 },
      estimated_input_tokens: 32,
      required_capabilities: ["vision_understanding"],
      requires_structured_output: true,
      data_policy: { local_only: false, allowed_regions: ["eu"], max_retention_days: 0, training_allowed: false },
      policy: { allowed_provider_ids: ["provider-a", "provider-b"], denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: ["provider-a", "provider-b"], required_capabilities: ["text_reasoning"] },
    };
    const selected = gateway.resolve(selection);
    const initialFailure = await gateway.dispatchExact(selected, selection, { operation_id: "operation-1" })
      .catch((error: unknown) => error);
    const controller = new ModelFallbackController({
      gateway: new ModelFallbackGatewayAdapter(gateway),
      cache: { invalidate: vi.fn(async () => undefined) },
      context: { recompile: vi.fn(async ({ provider_id, context_generation }) => ({
        provider_id, context_generation, manifest_hash: "c".repeat(64),
      })) },
    });

    const result = await controller.execute({
      current_provider: selected, selection_request: selection,
      dispatch_context: { operation_id: "operation-1" }, context_generation: 4,
      visited_provider_ids: ["provider-a"], initial_failure: initialFailure,
    });

    expect(result.provider.provider_id).toBe("provider-b");
    expect(result.context_generation).toBe(5);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(exchangeCredential).toHaveBeenCalledTimes(2);
    expect(secondary.provider.callCount).toBe(1);
  });
});
