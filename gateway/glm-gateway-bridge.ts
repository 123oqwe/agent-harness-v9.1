/**
 * GLM → ModelGateway bridge.
 *
 * Registers GlmProvider into a FrozenProviderRegistry so GLM calls go through
 * the full gateway chain: egress policy → credential exchange → provider
 * dispatch → usage metering → audit. No direct fetch bypass.
 */
import {
  FrozenProviderRegistry,
  ModelGateway,
  type GatewayProviderRegistration,
  type GatewayProviderRuntime,
  type GatewayProviderMetadata,
  type SecretsBrokerPort,
  type EgressPolicyPort,
  type UsageMeterPort,
  type GatewayClockPort,
} from './model-gateway.js';
import { glmProviderRuntime, type GlmProviderOptions } from './glm-provider.js';

/** A minimal UsageMeterPort that logs usage to an in-memory array. */
function makeUsageMeter(): UsageMeterPort & { getRecords: () => Array<{ provider_id: string; operation_id: string; usage: unknown }> } {
  const records: Array<{ provider_id: string; operation_id: string; usage: unknown }> = [];
  return {
    async record(input) { records.push({ ...input, usage: input.usage }); },
    getRecords() { return [...records]; },
  };
}

/** Build a ModelGateway with GLM registered as a real provider. */
export interface CreateGlmGatewayOptions extends GlmProviderOptions {
  secretsBroker: SecretsBrokerPort;
  egressPolicy: EgressPolicyPort;
  usageMeter?: UsageMeterPort & { getRecords?: () => unknown[] };
  clock?: GatewayClockPort;
}

export function createGlmGateway(options: CreateGlmGatewayOptions): {
  gateway: ModelGateway;
  registry: FrozenProviderRegistry;
  usageMeter: UsageMeterPort & {
    getRecords: () => Array<{ provider_id: string; operation_id: string; usage: unknown }>;
  };
} {
  const runtime = glmProviderRuntime(options);
  const contract = {
    provider_type: 'openai' as const,
    normalize_request: true,
    parse_response: true,
    normalize_tool_call: true,
    stream_events: true,
    map_error: true,
    meter_usage: true,
    check_health: true,
    validate_data_policy: true,
  };
  const metadata: GatewayProviderMetadata = {
    capabilities: ['text_reasoning', 'tool_calling', 'structured_output'],
    max_context_tokens: 128_000,
    structured_output: true,
    tool_calling: true,
    data_policy: { execution: 'remote', regions: ['cn'], retention_days: 30, training_allowed: false },
    pricing: { currency: 'USD', input_per_million: 0.5, output_per_million: 1.5 },
    health: 'healthy',
    network: { required: true, destination: 'https://open.bigmodel.cn' },
    credentials: { required: true, audience: 'https://open.bigmodel.cn' },
  };
  const registration: GatewayProviderRegistration = {
    provider_id: 'glm',
    contract,
    adapter: runtime as unknown as GatewayProviderRuntime,
    metadata,
  };
  const registry = new FrozenProviderRegistry([registration]);
  const recordedUsage = makeUsageMeter();
  const usageMeter = options.usageMeter
    ? {
        async record(input: Parameters<UsageMeterPort['record']>[0]) {
          await options.usageMeter!.record(input);
          await recordedUsage.record(input);
        },
        getRecords: recordedUsage.getRecords,
      }
    : recordedUsage;
  const clock = options.clock ?? {
    now: () => Date.now(),
    sleep: (milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('cancelled'));
        }, { once: true });
      }),
  };
  const gateway = new ModelGateway(registry, {
    secretsBroker: options.secretsBroker,
    egressPolicy: options.egressPolicy,
    usageMeter,
    clock,
  });
  return { gateway, registry, usageMeter };
}
