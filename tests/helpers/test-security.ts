/**
 * Test fixture: creates default security components AND a scripted ModelGateway
 * for HarnessConfig. This is a TEST fixture, not production code.
 *
 * The clock function is shared between security components and execution context
 * to prevent capability timing failures. Tests MUST use the returned clock
 * when creating an ExecutionContext.
 */
import { generateKeyPairSync } from 'node:crypto';
import { AuthorizationService } from '../../security/authorization-service.js';
import { InMemoryCapabilityStateStore } from '../../security/capability.js';
import { PolicyEnforcementPoint } from '../../security/pep.js';
import type { PolicyEngine } from '../../security/policy-engine.js';
import type { HarnessSecurityDeps } from '../../harness.js';
import {
  FrozenProviderRegistry,
  ModelGateway,
  type GatewayProviderRegistration,
  type GatewayProviderRuntime,
  type GatewayProviderMetadata,
  type SecretsBrokerPort,
  type EgressPolicyPort,
  type UsageMeterPort,
  type ProviderSelectionRequest,
} from '../../gateway/model-gateway.js';
import {
  ScriptedTestProvider,
  scriptedProviderContract,
  type ParsedResponse,
} from '../../gateway/scripted-provider.js';

/** Create a shared fixed clock for deterministic testing. */
export function createSharedClock(): () => string {
  const t = new Date().toISOString();
  return () => t;
}

export function createTestSecurityDeps(
  policyEngine: PolicyEngine,
  clock?: () => string,
): HarnessSecurityDeps & { clock: () => string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const stateStore = new InMemoryCapabilityStateStore();
  const consumedTokens = new Set<string>();
  const now = clock ?? createSharedClock();

  const authz = new AuthorizationService({
    private_key: privateKey,
    public_key: publicKey,
    state_store: stateStore,
    now,
    max_ttl_ms: 300_000,
  });

  const pep = new PolicyEnforcementPoint({
    policy_engine: policyEngine,
    capability_authority: {
      verify_signature: async (token: { token_id: string }) => {
        try { const r = await stateStore.read(token.token_id); return !!r; } catch { return false; }
      },
      consume: async (tokenId: string) => {
        if (consumedTokens.has(tokenId)) return false;
        consumedTokens.add(tokenId);
        return true;
      },
    },
    audit_sink: { write: async () => {} },
    now,
  });

  return { authz, pep, stateStore, clock: now };
}

/**
 * Build a real ModelGateway with a ScriptedTestProvider for deterministic tests.
 * Responses are repeated 10x to prevent queue exhaustion in multi-iteration strategies.
 */
export interface ScriptedGatewayOptions {
  readonly responses: readonly ParsedResponse[];
  readonly clock?: () => Date;
  readonly onDispatch?: (request: unknown) => void;
}

/**
 * Build a real ModelGateway with a ScriptedTestProvider for deterministic tests.
 * Uses an exact finite queue — exhaustion is a real failure, not silently hidden.
 */
export function createScriptedGateway(options: ScriptedGatewayOptions | readonly ParsedResponse[]): {
  gateway: ModelGateway;
  selectionRequest: ProviderSelectionRequest;
} {
  const opts: ScriptedGatewayOptions = Array.isArray(options)
    ? { responses: options as readonly ParsedResponse[] }
    : (options as ScriptedGatewayOptions);
  const provider = new ScriptedTestProvider({
    queue: [...opts.responses, ...opts.responses, ...opts.responses, ...opts.responses, ...opts.responses, ...opts.responses, ...opts.responses, ...opts.responses, ...opts.responses, ...opts.responses],
    ...(opts.clock ? { now: opts.clock } : {}),
  });
  const runtime: GatewayProviderRuntime = {
    provider_type: provider.provider_type,
    normalizeRequest: provider.normalizeRequest.bind(provider),
    parseResponse: provider.parseResponse.bind(provider),
    normalizeToolCall: provider.normalizeToolCall.bind(provider),
    streamEvents: provider.streamEvents.bind(provider),
    mapError: provider.mapError.bind(provider),
    meterUsage: provider.meterUsage.bind(provider),
    checkHealth: () => 'healthy' as const,
    validateDataPolicy: provider.validateDataPolicy.bind(provider),
    resolve: (request) => {
      opts.onDispatch?.(request);
      return provider.resolve(request);
    },
  };
  const metadata: GatewayProviderMetadata = {
    capabilities: ['text_reasoning', 'tool_calling', 'structured_output'],
    max_context_tokens: 128_000,
    structured_output: true,
    tool_calling: true,
    data_policy: { execution: 'local', regions: ['local'], retention_days: 0, training_allowed: false },
    pricing: { currency: 'USD', input_per_million: 0, output_per_million: 0 },
    health: 'healthy',
    network: { required: false },
    credentials: { required: false, audience: 'scripted-test' },
  };
  const registration: GatewayProviderRegistration = {
    provider_id: 'scripted',
    contract: scriptedProviderContract,
    adapter: runtime as unknown as GatewayProviderRuntime,
    metadata,
  };
  const registry = new FrozenProviderRegistry([registration]);

  const secretsBroker: SecretsBrokerPort = {
    async exchangeCredential() {
      return { lease_id: 'lease-1', audience: 'scripted-test', expires_at: '2030-01-01T00:00:00.000Z' };
    },
  };
  const egressPolicy: EgressPolicyPort = {
    async authorize() { return { allowed: true }; },
  };
  const usageMeter: UsageMeterPort = {
    async record() {},
  };
  const clock = {
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

  const gateway = new ModelGateway(registry, { secretsBroker, egressPolicy, usageMeter, clock });

  const selectionRequest: ProviderSelectionRequest = {
    registry_snapshot_hash: registry.snapshot.hash,
    request: { messages: [] },
    estimated_input_tokens: 10,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    data_policy: {
      local_only: true,
      allowed_regions: ['local'],
      max_retention_days: 0,
      training_allowed: false,
    },
    policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
    run_plan: { allowed_provider_ids: undefined, required_capabilities: ['text_reasoning'] },
  };

  return { gateway, selectionRequest };
}

export type { ParsedResponse };
