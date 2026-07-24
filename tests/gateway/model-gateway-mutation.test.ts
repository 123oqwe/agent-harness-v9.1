import { describe, it, expect, vi } from 'vitest';
import {
  FrozenProviderRegistry,
  ModelGateway,
  ProviderConfigurationError,
  ProviderResolutionError,
  ProviderDispatchError,
  type GatewayProviderRegistration,
  type ProviderSelectionRequest,
  type EgressPolicyPort,
  type SecretsBrokerPort,
  type UsageMeterPort,
} from '../../gateway/model-gateway.js';
import {
  ScriptedTestProvider,
  scriptedProviderContract,
  type ParsedResponse,
} from '../../gateway/scripted-provider.js';

function makeRuntime(response?: ParsedResponse) {
  const provider = new ScriptedTestProvider({
    queue: [response ?? { content: 'ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }],
  });
  return {
    provider_type: provider.provider_type,
    normalizeRequest: provider.normalizeRequest.bind(provider),
    parseResponse: provider.parseResponse.bind(provider),
    normalizeToolCall: provider.normalizeToolCall.bind(provider),
    streamEvents: provider.streamEvents.bind(provider),
    mapError: provider.mapError.bind(provider),
    meterUsage: provider.meterUsage.bind(provider),
    checkHealth: () => 'healthy' as const,
    validateDataPolicy: provider.validateDataPolicy.bind(provider),
    resolve: provider.resolve.bind(provider),
  };
}

function makeReg(overrides: Partial<GatewayProviderRegistration['metadata']> = {}, runtime?: ReturnType<typeof makeRuntime>): GatewayProviderRegistration {
  return {
    provider_id: 'p1',
    contract: scriptedProviderContract,
    adapter: runtime ?? makeRuntime(),
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
  };
}

function makePorts() {
  const credentialLease = Object.freeze({ lease_id: 'lease-1', audience: 'provider', expires_at: '2030-01-01T00:00:00.000Z' });
  const secretsBroker: SecretsBrokerPort = { exchangeCredential: vi.fn(async () => credentialLease) };
  const egressPolicy: EgressPolicyPort = { authorize: vi.fn(async () => ({ allowed: true })) };
  const usageMeter: UsageMeterPort = { record: vi.fn(async () => undefined) };
  return { secretsBroker, egressPolicy, usageMeter };
}

function makeGateway(reg?: GatewayProviderRegistration[], ports?: ReturnType<typeof makePorts>) {
  const registry = new FrozenProviderRegistry(reg ?? [makeReg()]);
  const p = ports ?? makePorts();
  const gateway = new ModelGateway(registry, p);
  return { registry, gateway, ports: p };
}

function makeSelection(snapshotHash: string, overrides: Partial<ProviderSelectionRequest> = {}): ProviderSelectionRequest {
  return {
    registry_snapshot_hash: snapshotHash,
    request: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
    estimated_input_tokens: 10,
    required_capabilities: [],
    requires_structured_output: false,
    data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 90, training_allowed: false },
    policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
    run_plan: { allowed_provider_ids: undefined, required_capabilities: [] },
    ...overrides,
  };
}

describe('ModelGateway mutation-killing edge cases', () => {
  it('rejects non-array registrations', () => {
    expect(() => new FrozenProviderRegistry('not-array' as unknown as GatewayProviderRegistration[])).toThrow(ProviderConfigurationError);
  });

  it('rejects adapter missing a runtime method', () => {
    const reg = makeReg();
    (reg.adapter as Record<string, unknown>).resolve = undefined;
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects adapter provider_type mismatch with contract', () => {
    const reg = makeReg();
    (reg.adapter as Record<string, unknown>).provider_type = 'openai';
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects duplicate provider IDs', () => {
    const reg1 = makeReg();
    const reg2 = makeReg();
    expect(() => new FrozenProviderRegistry([reg1, reg2])).toThrow(ProviderConfigurationError);
  });

  it('rejects network destination when required=false', () => {
    const reg = makeReg({ network: { required: false, destination: 'https://example.com' } as unknown as { required: false } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects non-HTTPS network destination', () => {
    const reg = makeReg({ network: { required: true, destination: 'http://example.com' } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects network destination with credentials in URL', () => {
    const reg = makeReg({ network: { required: true, destination: 'https://user:pass@example.com' } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects network destination that is not origin (has path)', () => {
    const reg = makeReg({ network: { required: true, destination: 'https://example.com/path' } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects non-USD currency in pricing', () => {
    const reg = makeReg({ pricing: { currency: 'EUR' as 'USD', input_per_million: 1, output_per_million: 2 } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects invalid health value', () => {
    const reg = makeReg({ health: 'invalid' as unknown as 'healthy' | 'degraded' | 'down' });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects duplicate capabilities', () => {
    const reg = makeReg({ capabilities: ['text_reasoning', 'text_reasoning'] });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects empty capabilities array', () => {
    const reg = makeReg({ capabilities: [] });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects non-finite pricing values', () => {
    const reg = makeReg({ pricing: { currency: 'USD', input_per_million: Infinity, output_per_million: 2 } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow(ProviderConfigurationError);
  });

  it('rejects ModelGateway constructed with non-FrozenProviderRegistry', () => {
    expect(() => new ModelGateway({} as unknown as FrozenProviderRegistry, makePorts())).toThrow(ProviderConfigurationError);
  });

  it('rejects ModelGateway with missing security ports', () => {
    const registry = new FrozenProviderRegistry([makeReg()]);
    expect(() => new ModelGateway(registry, {} as unknown as ReturnType<typeof makePorts>)).toThrow(ProviderConfigurationError);
  });

  it('resolve rejects when stale registry hash', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection('a'.repeat(64));
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('resolve rejects when no compatible provider after exclusion', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    expect(() => gateway.switchProvider(resolved, sel)).toThrow(ProviderResolutionError);
  });

  it('rejects context length exceeding max_context_tokens', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash, {
      estimated_input_tokens: 200000,
      request: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 50000 },
    });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when structured output required but not supported', () => {
    const reg = makeReg({ structured_output: false });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway['registry'].snapshot.hash, { requires_structured_output: true });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when tools requested but tool_calling not supported', () => {
    const reg = makeReg({ tool_calling: false });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway['registry'].snapshot.hash, {
      request: { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'test' }] },
    });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when data region incompatible', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash, {
      data_policy: { local_only: false, allowed_regions: ['eu'], max_retention_days: 90, training_allowed: false },
    });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when data retention exceeds max', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash, {
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 10, training_allowed: false },
    });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when training not allowed but provider trains', () => {
    const reg = makeReg({ data_policy: { execution: 'local', regions: ['us'], retention_days: 30, training_allowed: true } });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway['registry'].snapshot.hash, {
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 90, training_allowed: false },
    });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when local_only required but provider is remote', () => {
    const reg = makeReg({ data_policy: { execution: 'remote', regions: ['us'], retention_days: 30, training_allowed: false } });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway['registry'].snapshot.hash, {
      data_policy: { local_only: true, allowed_regions: ['us'], max_retention_days: 90, training_allowed: false },
    });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when required capability unavailable', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash, { required_capabilities: ['vision'] });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when policy denies provider', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash, {
      policy: { allowed_provider_ids: undefined, denied_provider_ids: ['p1'] },
    });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when RunPlan denies provider', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash, {
      run_plan: { allowed_provider_ids: ['other'], required_capabilities: [] },
    });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('dispatch rejects when resolved provider metadata hash changed', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    const tampered = { ...resolved, provider_metadata_hash: 'wrong' };
    await expect(gateway.dispatch(tampered, sel, { operation_id: 'op-1' })).rejects.toThrow(ProviderDispatchError);
  });

  it('dispatch rejects when egress policy denies', async () => {
    const ports = makePorts();
    ports.egressPolicy.authorize = vi.fn(async () => ({ allowed: false }));
    const { gateway } = makeGateway([makeReg()], ports);
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    await expect(gateway.dispatch(resolved, sel, { operation_id: 'op-1' })).rejects.toThrow(ProviderDispatchError);
  });

  it('dispatch rejects when egress policy throws', async () => {
    const ports = makePorts();
    ports.egressPolicy.authorize = vi.fn(async () => { throw new Error('network error'); });
    const { gateway } = makeGateway([makeReg()], ports);
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    await expect(gateway.dispatch(resolved, sel, { operation_id: 'op-1' })).rejects.toThrow(ProviderDispatchError);
  });

  it('dispatch rejects when usage metering throws', async () => {
    const ports = makePorts();
    ports.usageMeter.record = vi.fn(async () => { throw new Error('meter error'); });
    const { gateway } = makeGateway([makeReg()], ports);
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    await expect(gateway.dispatch(resolved, sel, { operation_id: 'op-1' })).rejects.toThrow(ProviderDispatchError);
  });

  it('dispatch rejects when provider resolve throws', async () => {
    const runtime = makeRuntime();
    runtime.resolve = () => { throw new Error('provider error'); };
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    await expect(gateway.dispatch(resolved, sel, { operation_id: 'op-1' })).rejects.toThrow(ProviderDispatchError);
  });

  it('dispatch exchanges credential when provider requires it', async () => {
    const ports = makePorts();
    const reg = makeReg({ credentials: { required: true, audience: 'test-audience' } });
    const { gateway } = makeGateway([reg], ports);
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    await gateway.dispatch(resolved, sel, { operation_id: 'op-1' });
    expect(ports.secretsBroker.exchangeCredential).toHaveBeenCalled();
  });

  it('dispatch rejects when credential exchange throws', async () => {
    const ports = makePorts();
    ports.secretsBroker.exchangeCredential = vi.fn(async () => { throw new Error('no secret'); });
    const reg = makeReg({ credentials: { required: true, audience: 'test' } });
    const { gateway } = makeGateway([reg], ports);
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    await expect(gateway.dispatch(resolved, sel, { operation_id: 'op-1' })).rejects.toThrow(ProviderDispatchError);
  });

  it('dispatch rejects when selection request hash changed', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    const changed = { ...sel, estimated_input_tokens: 999 };
    await expect(gateway.dispatch(resolved, changed, { operation_id: 'op-1' })).rejects.toThrow(ProviderDispatchError);
  });

  it('rejects empty string for operation_id in dispatch', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    await expect(gateway.dispatch(resolved, sel, { operation_id: '' })).rejects.toThrow();
  });

  it('selects lower-cost provider when two are compatible', () => {
    const reg1 = makeReg({ pricing: { currency: 'USD', input_per_million: 10, output_per_million: 20 } });
    reg1.provider_id = 'expensive';
    const reg2 = makeReg({ pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2 } });
    reg2.provider_id = 'cheap';
    const { gateway } = makeGateway([reg1, reg2]);
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    expect(resolved.provider_id).toBe('cheap');
  });

  it('switchProvider selects next compatible provider', () => {
    const reg1 = makeReg({ pricing: { currency: 'USD', input_per_million: 10, output_per_million: 20 } });
    reg1.provider_id = 'expensive';
    const reg2 = makeReg({ pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2 } });
    reg2.provider_id = 'cheap';
    const { gateway } = makeGateway([reg1, reg2]);
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    expect(resolved.provider_id).toBe('cheap');
    const switched = gateway.switchProvider(resolved, sel);
    expect(switched.provider_id).toBe('expensive');
  });

  it('switchProvider rejects stale selection request hash', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(sel);
    const changedSel = { ...sel, estimated_input_tokens: 999 };
    expect(() => gateway.switchProvider(resolved, changedSel)).toThrow(ProviderResolutionError);
  });
});

describe('ModelGateway validation mutation kills', () => {
  function makeRuntime() {
    const provider = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }] });
    return {
      provider_type: provider.provider_type,
      normalizeRequest: provider.normalizeRequest.bind(provider),
      parseResponse: provider.parseResponse.bind(provider),
      normalizeToolCall: provider.normalizeToolCall.bind(provider),
      streamEvents: provider.streamEvents.bind(provider),
      mapError: provider.mapError.bind(provider),
      meterUsage: provider.meterUsage.bind(provider),
      checkHealth: () => 'healthy' as const,
      validateDataPolicy: provider.validateDataPolicy.bind(provider),
      resolve: provider.resolve.bind(provider),
    };
  }

  function makeReg(overrides: Partial<GatewayProviderRegistration['metadata']> = {}) {
    return {
      provider_id: 'p1',
      contract: scriptedProviderContract,
      adapter: makeRuntime(),
      metadata: {
        capabilities: ['text_reasoning'],
        max_context_tokens: 128000,
        structured_output: true,
        tool_calling: true,
        data_policy: { execution: 'local', regions: ['us'], retention_days: 30, training_allowed: false },
        pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2 },
        health: 'healthy',
        network: { required: false },
        credentials: { required: false, audience: 'none' },
        ...overrides,
      },
    };
  }

  it('rejects provider_id that is empty string', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).provider_id = '';
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects provider_id that is whitespace only', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).provider_id = '   ';
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects max_context_tokens of 0', () => {
    const reg = makeReg({ max_context_tokens: 0 });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects max_context_tokens that is negative', () => {
    const reg = makeReg({ max_context_tokens: -1 });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects max_context_tokens that is not integer', () => {
    const reg = makeReg({ max_context_tokens: 1.5 });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects max_context_tokens that is NaN', () => {
    const reg = makeReg({ max_context_tokens: NaN });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects max_context_tokens that is Infinity', () => {
    const reg = makeReg({ max_context_tokens: Infinity });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects structured_output that is not boolean', () => {
    const reg = makeReg({ structured_output: 'true' as unknown as boolean });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects tool_calling that is not boolean', () => {
    const reg = makeReg({ tool_calling: 1 as unknown as boolean });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects health that is not a valid enum', () => {
    const reg = makeReg({ health: 'unknown' as unknown as string });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects capabilities that is not array', () => {
    const reg = makeReg({ capabilities: 'text_reasoning' as unknown as string[] });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects capabilities with empty array', () => {
    const reg = makeReg({ capabilities: [] });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects capabilities with empty string', () => {
    const reg = makeReg({ capabilities: [''] });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects capabilities with duplicates', () => {
    const reg = makeReg({ capabilities: ['text_reasoning', 'text_reasoning'] });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects pricing with non-USD currency', () => {
    const reg = makeReg({ pricing: { currency: 'EUR', input_per_million: 1, output_per_million: 2 } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects pricing with negative input_per_million', () => {
    const reg = makeReg({ pricing: { currency: 'USD', input_per_million: -1, output_per_million: 2 } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects pricing with NaN output_per_million', () => {
    const reg = makeReg({ pricing: { currency: 'USD', input_per_million: 1, output_per_million: NaN } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects data_policy.execution that is not local or remote', () => {
    const reg = makeReg({ data_policy: { execution: 'cloud' as unknown as 'local', regions: ['us'], retention_days: 30, training_allowed: false } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects data_policy.retention_days that is -1', () => {
    const reg = makeReg({ data_policy: { execution: 'local', regions: ['us'], retention_days: -1, training_allowed: false } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects data_policy.retention_days that is negative', () => {
    const reg = makeReg({ data_policy: { execution: 'local', regions: ['us'], retention_days: -1, training_allowed: false } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects data_policy.training_allowed that is not boolean', () => {
    const reg = makeReg({ data_policy: { execution: 'local', regions: ['us'], retention_days: 30, training_allowed: 'no' as unknown as boolean } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects data_policy.regions with empty array', () => {
    const reg = makeReg({ data_policy: { execution: 'local', regions: [], retention_days: 30, training_allowed: false } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects data_policy.regions with duplicates', () => {
    const reg = makeReg({ data_policy: { execution: 'local', regions: ['us', 'us'], retention_days: 30, training_allowed: false } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects data_policy.regions with empty string', () => {
    const reg = makeReg({ data_policy: { execution: 'local', regions: [''], retention_days: 30, training_allowed: false } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects network with required=true but no destination', () => {
    const reg = makeReg({ network: { required: true } as unknown as { required: true; destination: string } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects network.destination that is not HTTPS', () => {
    const reg = makeReg({ network: { required: true, destination: 'http://example.com' } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects network.destination with credentials in URL', () => {
    const reg = makeReg({ network: { required: true, destination: 'https://user:pass@example.com' } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects network.destination with path (not origin)', () => {
    const reg = makeReg({ network: { required: true, destination: 'https://example.com/path' } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects credentials.audience that is empty string', () => {
    const reg = makeReg({ credentials: { required: false, audience: '' } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects credentials.required that is not boolean', () => {
    const reg = makeReg({ credentials: { required: 'yes' as unknown as boolean, audience: 'test' } });
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects adapter that is null', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).adapter = null;
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects adapter that is an array', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).adapter = [];
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects adapter.provider_type mismatch with contract', () => {
    const reg = makeReg();
    (reg.adapter as Record<string, unknown>).provider_type = 'openai';
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects adapter missing resolve method', () => {
    const reg = makeReg();
    const adapter = reg.adapter as Record<string, unknown>;
    delete adapter.resolve;
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects adapter missing normalizeRequest method', () => {
    const reg = makeReg();
    const adapter = reg.adapter as Record<string, unknown>;
    delete adapter.normalizeRequest;
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects metadata that is not an object', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).metadata = null;
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects metadata with unknown field', () => {
    const reg = makeReg();
    (reg.metadata as Record<string, unknown>).unknown_field = true;
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects contract with unknown field', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).contract = { ...scriptedProviderContract, unknown_field: true };
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects contract.provider_type that is not in enum', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).contract = { ...scriptedProviderContract, provider_type: 'invalid' };
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects contract.normalize_request that is not true', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).contract = { ...scriptedProviderContract, normalize_request: false };
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects contract with optional field that is not boolean', () => {
    const reg = makeReg();
    (reg as Record<string, unknown>).contract = { ...scriptedProviderContract, rate_limiter: 'yes' };
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });
});
