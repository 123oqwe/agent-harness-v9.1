import { describe, it, expect, vi } from 'vitest';
import {
  FrozenProviderRegistry,
  ModelGateway,
  ProviderConfigurationError,
  ProviderDispatchError,
  ProviderResolutionError,
  type EgressPolicyPort,
  type GatewayProviderRegistration,
  type GatewayProviderRuntime,
  type ProviderSelectionRequest,
  type SecretsBrokerPort,
  type UsageMeterPort,
  type GatewayClockPort,
} from '../../gateway/model-gateway.js';
import {
  ScriptedTestProvider,
  scriptedProviderContract,
  type ParsedResponse,
  type StreamEvent,
} from '../../gateway/scripted-provider.js';

function makeRuntime(overrides: Partial<GatewayProviderRuntime> = {}): GatewayProviderRuntime {
  const provider = new ScriptedTestProvider({
    queue: [{ content: 'ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }],
  });
  return {
    provider_type: 'scripted_test',
    normalizeRequest: provider.normalizeRequest.bind(provider),
    parseResponse: provider.parseResponse.bind(provider),
    normalizeToolCall: provider.normalizeToolCall.bind(provider),
    streamEvents: provider.streamEvents.bind(provider),
    mapError: provider.mapError.bind(provider),
    meterUsage: provider.meterUsage.bind(provider),
    checkHealth: () => 'healthy' as const,
    validateDataPolicy: provider.validateDataPolicy.bind(provider),
    resolve: provider.resolve.bind(provider),
    ...overrides,
  };
}

function makeReg(overrides: Record<string, unknown> = {}): GatewayProviderRegistration {
  return {
    provider_id: 'p1',
    contract: scriptedProviderContract,
    adapter: makeRuntime(),
    metadata: {
      capabilities: ['text_reasoning'],
      max_context_tokens: 100000,
      structured_output: true,
      tool_calling: true,
      data_policy: { execution: 'local', regions: ['us'], retention_days: 30, training_allowed: false },
      pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2 },
      health: 'healthy',
      network: { required: false },
      credentials: { required: false, audience: 'none' },
      ...overrides,
    },
  } as unknown as GatewayProviderRegistration;
}

function makePorts() {
  const secretsBroker: SecretsBrokerPort = { exchangeCredential: vi.fn(async () => ({ lease_id: 'l1', audience: 'a', expires_at: '2030-01-01T00:00:00Z' })) };
  const egressPolicy: EgressPolicyPort = { authorize: vi.fn(async () => ({ allowed: true })) };
  const usageMeter: UsageMeterPort = { record: vi.fn(async () => undefined) };
  const clock: GatewayClockPort = { now: vi.fn(() => Date.now()), sleep: vi.fn(async () => undefined) };
  return { secretsBroker, egressPolicy, usageMeter, clock };
}

describe('FrozenProviderRegistry: registration validation', () => {
  it('rejects non-array registrations', () => {
    expect(() => new FrozenProviderRegistry('not array' as any)).toThrow(ProviderConfigurationError);
  });

  it('rejects duplicate provider_id', () => {
    expect(() => new FrozenProviderRegistry([makeReg(), makeReg()])).toThrow(ProviderConfigurationError);
  });

  it('rejects non-object registration', () => {
    expect(() => new FrozenProviderRegistry(["not object"] as any)).toThrow(ProviderConfigurationError);
  });

  it('rejects registration without provider_id', () => {
    const reg = makeReg();
    delete (reg as any).provider_id;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects empty provider_id', () => {
    const reg = makeReg();
    reg.provider_id = '   ';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects registration without contract', () => {
    const reg = makeReg();
    delete (reg as any).contract;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects contract with unsupported provider_type', () => {
    const reg = makeReg();
    reg.contract = { ...scriptedProviderContract, provider_type: 'unsupported' } as any;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects contract with required method set to false', () => {
    const reg = makeReg();
    reg.contract = { ...scriptedProviderContract, normalize_request: false } as any;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects contract with unknown field', () => {
    const reg = makeReg();
    reg.contract = { ...scriptedProviderContract, unknown_field: true } as any;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('accepts contract with optional fields undefined', () => {
    const reg = makeReg();
    reg.contract = { ...scriptedProviderContract } as any;
    expect(() => new FrozenProviderRegistry([reg])).not.toThrow();
  });

  it('rejects optional field as non-boolean', () => {
    const reg = makeReg();
    reg.contract = { ...scriptedProviderContract, rate_limiter: 'yes' as any } as any;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects adapter as non-object', () => {
    const reg = makeReg();
    (reg as any).adapter = 'not object';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects adapter missing required method', () => {
    const reg = makeReg();
    const incompleteAdapter = makeRuntime();
    delete (incompleteAdapter as any).resolve;
    reg.adapter = incompleteAdapter;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects adapter with mismatched provider_type', () => {
    const reg = makeReg();
    const mismatchedAdapter = makeRuntime();
    (mismatchedAdapter as any).provider_type = 'openai';
    reg.adapter = mismatchedAdapter;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata as non-object', () => {
    const reg = makeReg();
    (reg as any).metadata = 'not object';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata with unknown field', () => {
    const reg = makeReg();
    (reg.metadata as any).unknown_field = true;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.health as unsupported value', () => {
    const reg = makeReg();
    (reg.metadata as any).health = 'unknown_status';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('accepts metadata.health as degraded', () => {
    const reg = makeReg();
    (reg.metadata as any).health = 'degraded';
    expect(() => new FrozenProviderRegistry([reg])).not.toThrow();
  });

  it('accepts metadata.health as down', () => {
    const reg = makeReg();
    (reg.metadata as any).health = 'down';
    expect(() => new FrozenProviderRegistry([reg])).not.toThrow();
  });

  it('rejects metadata.capabilities as non-array', () => {
    const reg = makeReg();
    (reg.metadata as any).capabilities = 'not array';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.capabilities with empty array', () => {
    const reg = makeReg();
    (reg.metadata as any).capabilities = [];
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.capabilities with duplicates', () => {
    const reg = makeReg();
    (reg.metadata as any).capabilities = ['chat', 'chat'];
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.max_context_tokens below 1', () => {
    const reg = makeReg();
    (reg.metadata as any).max_context_tokens = 0;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.pricing.currency as non-USD', () => {
    const reg = makeReg();
    (reg.metadata as any).pricing.currency = 'EUR';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.pricing.input_per_million as negative', () => {
    const reg = makeReg();
    (reg.metadata as any).pricing.input_per_million = -1;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.pricing.input_per_million as Infinity', () => {
    const reg = makeReg();
    (reg.metadata as any).pricing.input_per_million = Infinity;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.data_policy.execution as unsupported', () => {
    const reg = makeReg();
    (reg.metadata as any).data_policy.execution = 'cloud';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.network with destination but required=false', () => {
    const reg = makeReg();
    (reg.metadata as any).network = { required: false, destination: 'https://api.test.com' };
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.network.destination as non-HTTPS', () => {
    const reg = makeReg();
    (reg.metadata as any).network = { required: true, destination: 'http://api.test.com' };
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.network.destination with credentials in URL', () => {
    const reg = makeReg();
    (reg.metadata as any).network = { required: true, destination: 'https://user:pass@api.test.com' };
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('accepts metadata.network with valid HTTPS destination', () => {
    const reg = makeReg();
    (reg.metadata as any).network = { required: true, destination: 'https://api.test.com' };
    expect(() => new FrozenProviderRegistry([reg])).not.toThrow();
  });

  it('rejects metadata.network.destination with path', () => {
    const reg = makeReg();
    (reg.metadata as any).network = { required: true, destination: 'https://api.test.com/v1' };
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.credentials.required as non-boolean', () => {
    const reg = makeReg();
    (reg.metadata as any).credentials.required = 'yes';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects metadata.credentials.audience as empty string', () => {
    const reg = makeReg();
    (reg.metadata as any).credentials.audience = '  ';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('snapshot hash is deterministic for same registrations', () => {
    const r1 = new FrozenProviderRegistry([makeReg()]);
    const r2 = new FrozenProviderRegistry([makeReg()]);
    expect(r1.snapshot.hash).toBe(r2.snapshot.hash);
  });

  it('snapshot hash differs for different registrations', () => {
    const r1 = new FrozenProviderRegistry([makeReg()]);
    const reg2 = makeReg();
    reg2.provider_id = 'p2';
    const r2 = new FrozenProviderRegistry([reg2]);
    expect(r1.snapshot.hash).not.toBe(r2.snapshot.hash);
  });

  it('snapshot is frozen', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    expect(Object.isFrozen(registry.snapshot)).toBe(true);
    expect(Object.isFrozen(registry.snapshot.providers)).toBe(true);
  });

  it('registry itself is frozen', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    expect(Object.isFrozen(registry)).toBe(true);
  });
});

describe('ModelGateway: selection validation', () => {
  const ports = makePorts();

  it('rejects selection with invalid registry_snapshot_hash', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    const gateway = new ModelGateway(registry, ports);
    const req = {
      registry_snapshot_hash: 'not-a-hash',
      request: { messages: [], max_tokens: 64 },
      estimated_input_tokens: 10,
      required_capabilities: [],
      requires_structured_output: false,
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
    } as unknown as ProviderSelectionRequest;
    expect(() => gateway.resolve(req)).toThrow(ProviderConfigurationError);
  });

  it('rejects selection with non-object request', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    const gateway = new ModelGateway(registry, ports);
    const req = {
      registry_snapshot_hash: registry.snapshot.hash,
      request: null,
      estimated_input_tokens: 10,
      required_capabilities: [],
      requires_structured_output: false,
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
    } as unknown as ProviderSelectionRequest;
    expect(() => gateway.resolve(req)).toThrow();
  });

  it('rejects selection with unknown field', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    const gateway = new ModelGateway(registry, ports);
    const req = {
      registry_snapshot_hash: registry.snapshot.hash,
      request: { messages: [], max_tokens: 64 },
      estimated_input_tokens: 10,
      required_capabilities: [],
      requires_structured_output: false,
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
      unknown_field: true,
    } as unknown as ProviderSelectionRequest;
    expect(() => gateway.resolve(req)).toThrow(ProviderConfigurationError);
  });

  it('rejects selection with negative estimated_input_tokens', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    const gateway = new ModelGateway(registry, ports);
    const req = {
      registry_snapshot_hash: registry.snapshot.hash,
      request: { messages: [], max_tokens: 64 },
      estimated_input_tokens: -1,
      required_capabilities: [],
      requires_structured_output: false,
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
    } as unknown as ProviderSelectionRequest;
    expect(() => gateway.resolve(req)).toThrow(ProviderConfigurationError);
  });

  it('rejects data_policy with duplicate regions', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    const gateway = new ModelGateway(registry, ports);
    const req = {
      registry_snapshot_hash: registry.snapshot.hash,
      request: { messages: [], max_tokens: 64 },
      estimated_input_tokens: 10,
      required_capabilities: [],
      requires_structured_output: false,
      data_policy: { local_only: false, allowed_regions: ['us', 'us'], max_retention_days: 30, training_allowed: false },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
    } as unknown as ProviderSelectionRequest;
    expect(() => gateway.resolve(req)).toThrow(ProviderConfigurationError);
  });

  it('rejects data_policy with empty allowed_regions', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    const gateway = new ModelGateway(registry, ports);
    const req = {
      registry_snapshot_hash: registry.snapshot.hash,
      request: { messages: [], max_tokens: 64 },
      estimated_input_tokens: 10,
      required_capabilities: [],
      requires_structured_output: false,
      data_policy: { local_only: false, allowed_regions: [], max_retention_days: 30, training_allowed: false },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
    } as unknown as ProviderSelectionRequest;
    expect(() => gateway.resolve(req)).toThrow(ProviderConfigurationError);
  });

  it('rejects data_policy with negative max_retention_days', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    const gateway = new ModelGateway(registry, ports);
    const req = {
      registry_snapshot_hash: registry.snapshot.hash,
      request: { messages: [], max_tokens: 64 },
      estimated_input_tokens: 10,
      required_capabilities: [],
      requires_structured_output: false,
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: -1, training_allowed: false },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
    } as unknown as ProviderSelectionRequest;
    expect(() => gateway.resolve(req)).toThrow(ProviderConfigurationError);
  });

  it('rejects requires_structured_output as non-boolean', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    const gateway = new ModelGateway(registry, ports);
    const req = {
      registry_snapshot_hash: registry.snapshot.hash,
      request: { messages: [], max_tokens: 64 },
      estimated_input_tokens: 10,
      required_capabilities: [],
      requires_structured_output: 'yes' as any,
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
    } as unknown as ProviderSelectionRequest;
    expect(() => gateway.resolve(req)).toThrow(ProviderConfigurationError);
  });
});
