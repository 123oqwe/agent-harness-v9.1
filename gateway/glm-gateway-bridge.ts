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
} from './model-gateway.js';
import { glmProviderRuntime } from './glm-provider.js';

/** A minimal SecretsBrokerPort that returns a lease from env (no real broker). */
function makeSecretsBroker(): SecretsBrokerPort {
  return {
    async exchangeCredential(input) {
      const _key = process.env.GLM_API_KEY ?? '';
      return {
        lease_id: `lease-${input.operation_id}`,
        audience: input.audience,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
}

/** A minimal EgressPolicyPort that checks GLM_ALLOW_REMOTE. */
function makeEgressPolicy(): EgressPolicyPort {
  return {
    async authorize(input) {
      if (!input.network_required) return { allowed: true };
      const allowRemote = process.env.GLM_ALLOW_REMOTE === 'true';
      if (!allowRemote) return { allowed: false, reason: 'remote egress denied (set GLM_ALLOW_REMOTE=true)' };
      return { allowed: true };
    },
  };
}

/** A minimal UsageMeterPort that logs usage to an in-memory array. */
function makeUsageMeter(): UsageMeterPort & { getRecords: () => Array<{ provider_id: string; operation_id: string; usage: unknown }> } {
  const records: Array<{ provider_id: string; operation_id: string; usage: unknown }> = [];
  return {
    async record(input) { records.push({ ...input, usage: input.usage }); },
    getRecords() { return [...records]; },
  };
}

/** Build a ModelGateway with GLM registered as a real provider. */
export function createGlmGateway(): {
  gateway: ModelGateway;
  registry: FrozenProviderRegistry;
  usageMeter: ReturnType<typeof makeUsageMeter>;
} {
  const runtime = glmProviderRuntime();
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
  const secretsBroker = makeSecretsBroker();
  const egressPolicy = makeEgressPolicy();
  const usageMeter = makeUsageMeter();
  const gateway = new ModelGateway(registry, { secretsBroker, egressPolicy, usageMeter });
  return { gateway, registry, usageMeter };
}
