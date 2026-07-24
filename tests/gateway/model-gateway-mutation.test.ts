import { describe, it, expect, vi } from 'vitest';
import {
  FrozenProviderRegistry,
  ModelGateway,
  ProviderConfigurationError,
  ProviderResolutionError,
  ProviderDispatchError,
  type GatewayProviderRegistration,
  type GatewayProviderRuntime,
  type ProviderSelectionRequest,
  type EgressPolicyPort,
  type SecretsBrokerPort,
  type UsageMeterPort,
} from '../../gateway/model-gateway.js';
import {
  ProviderHttpError,
  ScriptedTestProvider,
  scriptedProviderContract,
  type ParsedResponse,
  type StreamEvent,
} from '../../gateway/scripted-provider.js';

function makeRuntime(response?: ParsedResponse): GatewayProviderRuntime {
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
  const credentialLease = Object.freeze({ lease_id: 'lease-1', audience: 'test-audience', expires_at: '2030-01-01T00:00:00.000Z' });
  const secretsBroker: SecretsBrokerPort = { exchangeCredential: vi.fn(async () => credentialLease) };
  const egressPolicy: EgressPolicyPort = { authorize: vi.fn(async () => ({ allowed: true })) };
  const usageMeter: UsageMeterPort = { record: vi.fn(async () => undefined) };
  const clock = {
    now: vi.fn(() => Date.now()),
    sleep: vi.fn(async () => undefined),
  };
  return { secretsBroker, egressPolicy, usageMeter, clock };
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
  it('cancels an in-flight provider even when the adapter ignores AbortSignal', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn(
      () =>
        new Promise<ParsedResponse>((resolve) =>
          setTimeout(() => resolve({ content: 'late' }), 100),
        ),
    );
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const selection = makeSelection(gateway['registry'].snapshot.hash);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(
      gateway.dispatch(gateway.resolve(selection), selection, {
        operation_id: 'cancel-in-flight',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('enforces an absolute deadline while a provider call is in flight', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn(
      () =>
        new Promise<ParsedResponse>((resolve) =>
          setTimeout(() => resolve({ content: 'late' }), 100),
        ),
    );
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const selection = makeSelection(gateway['registry'].snapshot.hash);

    await expect(
      gateway.dispatch(gateway.resolve(selection), selection, {
        operation_id: 'deadline-in-flight',
        deadline_at: new Date(Date.now() + 10).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('uses bounded backoff for retryable failures and not for auth failures', async () => {
    const retryable = makeRuntime();
    retryable.resolve = vi
      .fn()
      .mockRejectedValueOnce(new ProviderHttpError(503))
      .mockRejectedValueOnce(new ProviderHttpError(503))
      .mockResolvedValue({ content: 'ok', stop_reason: 'stop' });
    const retryPorts = makePorts();
    const retryGateway = makeGateway([makeReg({}, retryable)], retryPorts).gateway;
    const retrySelection = makeSelection(retryGateway['registry'].snapshot.hash);

    await retryGateway.dispatch(retryGateway.resolve(retrySelection), retrySelection, {
      operation_id: 'retryable',
    });
    expect(retryable.resolve).toHaveBeenCalledTimes(3);
    expect(retryPorts.clock.sleep).toHaveBeenNthCalledWith(1, 100, expect.any(AbortSignal));
    expect(retryPorts.clock.sleep).toHaveBeenNthCalledWith(2, 200, expect.any(AbortSignal));

    const auth = makeRuntime();
    auth.resolve = vi.fn().mockRejectedValue(new ProviderHttpError(401));
    const authPorts = makePorts();
    const authGateway = makeGateway([makeReg({}, auth)], authPorts).gateway;
    const authSelection = makeSelection(authGateway['registry'].snapshot.hash);
    await expect(
      authGateway.dispatch(authGateway.resolve(authSelection), authSelection, {
        operation_id: 'auth',
      }),
    ).rejects.toMatchObject({ code: 'provider_failure' });
    expect(auth.resolve).toHaveBeenCalledTimes(1);
    expect(authPorts.clock.sleep).not.toHaveBeenCalled();
  });

  it('falls back through switchProvider without changing frozen selection hashes', async () => {
    const failing = makeRuntime();
    failing.resolve = vi.fn().mockRejectedValue(new ProviderHttpError(503));
    const working = makeRuntime({
      content: 'fallback',
      model: 's',
      stop_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const cheap = makeReg(
      { pricing: { currency: 'USD', input_per_million: 0, output_per_million: 0 } },
      failing,
    );
    cheap.provider_id = 'cheap-failing';
    const backup = makeReg(
      { pricing: { currency: 'USD', input_per_million: 10, output_per_million: 10 } },
      working,
    );
    backup.provider_id = 'backup';
    const { gateway } = makeGateway([cheap, backup]);
    const selection = makeSelection(gateway['registry'].snapshot.hash);
    const resolved = gateway.resolve(selection);

    const result = await gateway.dispatch(resolved, selection, {
      operation_id: 'fallback',
    });
    expect(result.provider_id).toBe('backup');
    expect(result.response.content).toBe('fallback');
    expect(resolved.registry_snapshot_hash).toBe(gateway.registrySnapshotHash);
  });

  it('normalizes complete and stream paths to equivalent content, tool calls and usage', async () => {
    const response: ParsedResponse = {
      content: 'use it',
      tool_calls: [{ id: 'call-1', name: 'read_file', arguments: { path: '/workspace/a' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 4 },
      model: 's',
    };
    const completeGateway = makeGateway([makeReg({}, makeRuntime(response))]);
    const completeSelection = makeSelection(completeGateway.gateway['registry'].snapshot.hash);
    const complete = await completeGateway.gateway.dispatch(
      completeGateway.gateway.resolve(completeSelection),
      completeSelection,
      { operation_id: 'complete' },
    );

    const streamPorts = makePorts();
    const streamGateway = makeGateway([makeReg({}, makeRuntime(response))], streamPorts);
    const streamSelection = makeSelection(streamGateway.gateway['registry'].snapshot.hash);
    const events = [];
    for await (const event of streamGateway.gateway.stream(
      streamGateway.gateway.resolve(streamSelection),
      streamSelection,
      { operation_id: 'stream' },
    )) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')).toBe(
      complete.response.content,
    );
    expect(events.filter((event) => event.type === 'tool_call').map((event) => event.tool_call)).toEqual(
      complete.response.tool_calls,
    );
    expect(events.at(-1)).toEqual({
      type: 'message_stop',
      stop_reason: complete.response.stop_reason,
      usage: complete.usage,
    });
    expect(streamPorts.usageMeter.record).toHaveBeenCalledWith(
      expect.objectContaining({ operation_id: 'stream', usage: complete.usage }),
    );
  });

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

  it('rejects expired or wrong-audience credential leases before provider execution', async () => {
    for (const lease of [
      { lease_id: 'expired', audience: 'test-audience', expires_at: '2000-01-01T00:00:00.000Z' },
      { lease_id: 'wrong', audience: 'another-audience', expires_at: '2030-01-01T00:00:00.000Z' },
    ]) {
      const runtime = makeRuntime();
      runtime.resolve = vi.fn(runtime.resolve);
      const ports = makePorts();
      ports.secretsBroker.exchangeCredential = vi.fn(async () => lease);
      const { gateway } = makeGateway(
        [makeReg({ credentials: { required: true, audience: 'test-audience' } }, runtime)],
        ports,
      );
      const selection = makeSelection(gateway['registry'].snapshot.hash);

      await expect(
        gateway.dispatch(gateway.resolve(selection), selection, {
          operation_id: `invalid-lease-${lease.lease_id}`,
        }),
      ).rejects.toMatchObject({ code: 'credential_exchange_failed' });
      expect(runtime.resolve).not.toHaveBeenCalled();
    }
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
  function makeRuntime(): GatewayProviderRuntime {
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

  function makeReg(
    overrides: Partial<GatewayProviderRegistration['metadata']> = {},
  ): GatewayProviderRegistration {
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
    (reg as unknown as Record<string, unknown>).provider_id = '';
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects provider_id that is whitespace only', () => {
    const reg = makeReg();
    (reg as unknown as Record<string, unknown>).provider_id = '   ';
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
    const reg = makeReg({
      health: 'unknown' as unknown as GatewayProviderRegistration['metadata']['health'],
    });
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
    const reg = makeReg({
      pricing: {
        currency: 'EUR' as unknown as 'USD',
        input_per_million: 1,
        output_per_million: 2,
      },
    });
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
    (reg as unknown as Record<string, unknown>).adapter = null;
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects adapter that is an array', () => {
    const reg = makeReg();
    (reg as unknown as Record<string, unknown>).adapter = [];
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
    (reg as unknown as Record<string, unknown>).metadata = null;
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects metadata with unknown field', () => {
    const reg = makeReg();
    (reg.metadata as unknown as Record<string, unknown>).unknown_field = true;
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects contract with unknown field', () => {
    const reg = makeReg();
    (reg as unknown as Record<string, unknown>).contract = { ...scriptedProviderContract, unknown_field: true };
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects contract.provider_type that is not in enum', () => {
    const reg = makeReg();
    (reg as unknown as Record<string, unknown>).contract = { ...scriptedProviderContract, provider_type: 'invalid' };
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects contract.normalize_request that is not true', () => {
    const reg = makeReg();
    (reg as unknown as Record<string, unknown>).contract = { ...scriptedProviderContract, normalize_request: false };
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });

  it('rejects contract with optional field that is not boolean', () => {
    const reg = makeReg();
    (reg as unknown as Record<string, unknown>).contract = { ...scriptedProviderContract, rate_limiter: 'yes' };
    expect(() => new FrozenProviderRegistry([reg])).toThrow();
  });
});

describe('ModelGateway externally observable boundary contracts', () => {
  it('exposes stable typed error identity without fabricating provider detail', () => {
    const configuration = new ProviderConfigurationError('bad config');
    expect({
      name: configuration.name,
      message: configuration.message,
    }).toEqual({
      name: 'ProviderConfigurationError',
      message: 'bad config',
    });

    const resolution = new ProviderResolutionError(
      'stale_registry_snapshot',
      'stale',
    );
    expect({
      name: resolution.name,
      message: resolution.message,
      code: resolution.code,
    }).toEqual({
      name: 'ProviderResolutionError',
      message: 'stale',
      code: 'stale_registry_snapshot',
    });

    const dispatch = new ProviderDispatchError('cancelled');
    expect({
      name: dispatch.name,
      message: dispatch.message,
      code: dispatch.code,
      providerError: dispatch.provider_error,
    }).toEqual({
      name: 'ProviderDispatchError',
      message: 'ModelGateway dispatch failed: cancelled',
      code: 'cancelled',
      providerError: undefined,
    });
  });

  it('rejects non-record registry entries with their exact location', () => {
    for (const value of [null, [], 1, 'provider']) {
      expect(
        () =>
          new FrozenProviderRegistry([
            value as unknown as GatewayProviderRegistration,
          ]),
      ).toThrow('providers[0] must be an object');
    }
  });

  it('accepts exact context and retention boundaries without requiring tools', () => {
    const registration = makeReg({
      max_context_tokens: 74,
      tool_calling: false,
      data_policy: {
        execution: 'local',
        regions: ['eu', 'us'],
        retention_days: 90,
        training_allowed: false,
      },
    });
    const { gateway } = makeGateway([registration]);
    const selection = makeSelection(gateway.registrySnapshotHash, {
      estimated_input_tokens: 10,
      request: {
        messages: [{ role: 'user', content: 'boundary' }],
        max_tokens: 64,
      },
      data_policy: {
        local_only: false,
        allowed_regions: ['us'],
        max_retention_days: 90,
        training_allowed: false,
      },
    });

    expect(gateway.resolve(selection).provider_id).toBe('p1');
  });

  it('requires a complete SHA-256 snapshot hash', () => {
    const { gateway } = makeGateway();
    for (const registry_snapshot_hash of [
      `prefix${gateway.registrySnapshotHash}`,
      `${gateway.registrySnapshotHash}suffix`,
      gateway.registrySnapshotHash.slice(1),
    ]) {
      expect(() =>
        gateway.resolve(
          makeSelection(registry_snapshot_hash),
        ),
      ).toThrow('selection.registry_snapshot_hash must be SHA-256');
    }
  });

  it('treats an explicit empty provider allowlist as deny-all', () => {
    const { gateway } = makeGateway();
    const selection = makeSelection(gateway.registrySnapshotHash, {
      policy: { allowed_provider_ids: [], denied_provider_ids: [] },
    });

    expect(() => gateway.resolve(selection)).toThrow(
      'No provider satisfies Policy, RunPlan, context, tool and data-policy constraints',
    );
  });

  it('describes only a provider bound to the same frozen registry metadata', () => {
    const { gateway } = makeGateway();
    const selection = makeSelection(gateway.registrySnapshotHash);
    const resolved = gateway.resolve(selection);

    expect(gateway.describeResolved(resolved)).toEqual({
      provider_id: 'p1',
      provider_type: 'scripted_test',
      execution: 'local',
      metadata_hash: resolved.provider_metadata_hash,
    });
    expect(() =>
      gateway.describeResolved({
        ...resolved,
        registry_snapshot_hash: 'a'.repeat(64),
      }),
    ).toThrow('Resolved provider does not belong to this frozen registry');
    expect(() =>
      gateway.describeResolved({
        ...resolved,
        provider_metadata_hash: 'a'.repeat(64),
      }),
    ).toThrow(
      'Resolved provider metadata does not match the frozen registry',
    );
  });

  it('passes stable operation and attempt identity through dispatch and metering', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn(runtime.resolve);
    const ports = makePorts();
    const { gateway } = makeGateway([makeReg({}, runtime)], ports);
    const selection = makeSelection(gateway.registrySnapshotHash);

    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      await gateway.dispatch(gateway.resolve(selection), selection, {
        operation_id: 'operation-exact',
        attempt_id: 'attempt-exact',
        deadline_at: '2030-01-01T00:00:00.000Z',
      });
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
    } finally {
      timer.mockRestore();
    }

    expect(runtime.resolve).toHaveBeenCalledWith(
      selection.request,
      expect.objectContaining({
        operation_id: 'operation-exact',
        attempt_id: 'attempt-exact',
        deadline_at: '2030-01-01T00:00:00.000Z',
      }),
    );
    expect(ports.usageMeter.record).toHaveBeenCalledWith({
      provider_id: 'p1',
      operation_id: 'operation-exact',
      attempt_id: 'attempt-exact',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it('fails closed on invalid dispatch and stream deadlines', async () => {
    const { gateway } = makeGateway();
    const selection = makeSelection(gateway.registrySnapshotHash);
    const resolved = gateway.resolve(selection);

    await expect(
      gateway.dispatch(resolved, selection, {
        operation_id: 'dispatch',
        deadline_at: 'invalid',
      }),
    ).rejects.toThrow('dispatch.deadline_at must be an ISO timestamp');
    await expect(async () => {
      for await (const _event of gateway.stream(resolved, selection, {
        operation_id: 'stream',
        deadline_at: 'invalid',
      })) {
        // No provider event may escape an invalid deadline.
      }
    }).rejects.toThrow('stream.deadline_at must be an ISO timestamp');
  });

  it('distinguishes a pre-cancelled dispatch from a timed-out dispatch', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn(runtime.resolve);
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const selection = makeSelection(gateway.registrySnapshotHash);
    const resolved = gateway.resolve(selection);
    const controller = new AbortController();
    controller.abort();

    await expect(
      gateway.dispatch(resolved, selection, {
        operation_id: 'cancelled',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(
      gateway.dispatch(resolved, selection, {
        operation_id: 'timed-out',
        deadline_at: '1970-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(runtime.resolve).not.toHaveBeenCalled();
  });

  it('rejects a stream without exactly one terminal event', async () => {
    const runtime = makeRuntime();
    runtime.streamEvents = async function* () {
      yield { type: 'text_delta', text: 'partial' };
    };
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const selection = makeSelection(gateway.registrySnapshotHash);

    await expect(async () => {
      for await (const _event of gateway.stream(
        gateway.resolve(selection),
        selection,
        { operation_id: 'missing-terminal' },
      )) {
        // Consume partial output before terminal validation.
      }
    }).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: {
        kind: 'invalid_request',
        retryable: false,
        detail: 'Provider stream ended without terminal event',
      },
    });

    runtime.streamEvents = async function* () {
      yield { type: 'message_stop', stop_reason: 'stop' };
      yield { type: 'text_delta', text: 'illegal' };
    };
    const second = makeGateway([makeReg({}, runtime)]);
    const secondSelection = makeSelection(second.gateway.registrySnapshotHash);
    await expect(async () => {
      for await (const _event of second.gateway.stream(
        second.gateway.resolve(secondSelection),
        secondSelection,
        { operation_id: 'after-terminal' },
      )) {
        // The second event must fail closed.
      }
    }).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: {
        kind: 'invalid_request',
        retryable: false,
        detail: 'Provider emitted data after terminal stream event',
      },
    });
  });

  it('normalizes stream adapter failures and metering failures', async () => {
    const runtime = makeRuntime();
    runtime.streamEvents = async function* () {
      throw new Error('stream failed');
    };
    runtime.mapError = vi.fn(() => {
      throw new Error('mapper failed');
    });
    const first = makeGateway([makeReg({}, runtime)]);
    const selection = makeSelection(first.gateway.registrySnapshotHash);
    await expect(async () => {
      for await (const _event of first.gateway.stream(
        first.gateway.resolve(selection),
        selection,
        { operation_id: 'normalize' },
      )) {
        // No event is expected.
      }
    }).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: {
        kind: 'unknown',
        retryable: false,
        detail: 'Provider error normalization failed',
      },
    });

    const ports = makePorts();
    ports.usageMeter.record = vi.fn(async () => {
      throw new Error('meter unavailable');
    });
    const second = makeGateway([makeReg()], ports);
    const secondSelection = makeSelection(second.gateway.registrySnapshotHash);
    await expect(async () => {
      for await (const _event of second.gateway.stream(
        second.gateway.resolve(secondSelection),
        secondSelection,
        { operation_id: 'meter' },
      )) {
        // Consume the valid stream before metering.
      }
    }).rejects.toMatchObject({ code: 'metering_failed' });
  });

  it('checks live provider health before egress or execution', async () => {
    const runtime = makeRuntime();
    runtime.checkHealth = vi.fn(async () => 'down' as const);
    runtime.resolve = vi.fn(runtime.resolve);
    const ports = makePorts();
    const { gateway } = makeGateway([makeReg({}, runtime)], ports);
    const selection = makeSelection(gateway.registrySnapshotHash);

    await expect(
      gateway.dispatch(gateway.resolve(selection), selection, {
        operation_id: 'unhealthy',
      }),
    ).rejects.toMatchObject({ code: 'provider_unhealthy' });
    expect(ports.egressPolicy.authorize).not.toHaveBeenCalled();
    expect(runtime.resolve).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth'],
    [400, 'invalid_request'],
  ] as const)(
    'never falls back after a non-retryable %s provider failure',
    async (status, kind) => {
      const failing = makeRuntime();
      failing.resolve = vi.fn().mockRejectedValue(new ProviderHttpError(status));
      const backup = makeRuntime();
      backup.resolve = vi.fn(backup.resolve);
      const firstRegistration = makeReg(
        {
          pricing: {
            currency: 'USD',
            input_per_million: 0,
            output_per_million: 0,
          },
        },
        failing,
      );
      firstRegistration.provider_id = 'a-failing';
      const backupRegistration = makeReg({}, backup);
      backupRegistration.provider_id = 'z-backup';
      const { gateway } = makeGateway([
        firstRegistration,
        backupRegistration,
      ]);
      const selection = makeSelection(gateway.registrySnapshotHash);

      await expect(
        gateway.dispatch(gateway.resolve(selection), selection, {
          operation_id: `non-retryable-${status}`,
        }),
      ).rejects.toMatchObject({
        code: 'provider_failure',
        provider_error: { kind, retryable: false },
      });
      expect(failing.resolve).toHaveBeenCalledOnce();
      expect(backup.resolve).not.toHaveBeenCalled();
    },
  );

  it('orders compatible candidates by price even when identity order conflicts', () => {
    const expensive = makeReg({
      pricing: {
        currency: 'USD',
        input_per_million: 100,
        output_per_million: 200,
      },
    });
    expensive.provider_id = 'a-expensive';
    const cheap = makeReg({
      pricing: {
        currency: 'USD',
        input_per_million: 1,
        output_per_million: 2,
      },
    });
    cheap.provider_id = 'z-cheap';
    const { gateway } = makeGateway([expensive, cheap]);
    const selection = makeSelection(gateway.registrySnapshotHash, {
      estimated_input_tokens: 1000,
      request: { messages: [], max_tokens: 500 },
    });

    expect(gateway.resolve(selection).provider_id).toBe('z-cheap');
  });

  it('passes exact stream authority context and meters terminal usage', async () => {
    const seenContexts: unknown[] = [];
    const runtime = makeRuntime();
    runtime.streamEvents = vi.fn(async function* (
      _request,
      streamContext,
    ): AsyncGenerator<StreamEvent> {
      seenContexts.push(streamContext);
      yield { type: 'text_delta', text: 'ok' };
      yield {
        type: 'message_stop',
        stop_reason: 'stop',
        usage: { input_tokens: 7, output_tokens: 3 },
      };
    });
    const ports = makePorts();
    const { gateway } = makeGateway(
      [
        makeReg(
          {
            credentials: {
              required: true,
              audience: 'test-audience',
            },
          },
          runtime,
        ),
      ],
      ports,
    );
    const selection = makeSelection(gateway.registrySnapshotHash);
    const deadline_at = new Date(Date.now() + 60_000).toISOString();
    const events = [];

    for await (const event of gateway.stream(
      gateway.resolve(selection),
      selection,
      {
        operation_id: 'stream-authority',
        attempt_id: 'attempt-authority',
        deadline_at,
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'ok' },
      {
        type: 'message_stop',
        stop_reason: 'stop',
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    ]);
    expect(seenContexts).toEqual([
      expect.objectContaining({
        operation_id: 'stream-authority',
        attempt_id: 'attempt-authority',
        deadline_at,
        credential: {
          lease_id: 'lease-1',
          audience: 'test-audience',
          expires_at: '2030-01-01T00:00:00.000Z',
        },
        signal: expect.any(AbortSignal),
      }),
    ]);
    expect(ports.usageMeter.record).toHaveBeenCalledWith({
      provider_id: 'p1',
      operation_id: 'stream-authority',
      attempt_id: 'attempt-authority',
      usage: { input_tokens: 7, output_tokens: 3 },
    });
  });

  it('stops a stream immediately after caller cancellation', async () => {
    const runtime = makeRuntime();
    runtime.streamEvents = async function* () {
      yield { type: 'text_delta', text: 'first' };
      yield { type: 'text_delta', text: 'must-not-escape' };
      yield { type: 'message_stop', stop_reason: 'stop' };
    };
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const selection = makeSelection(gateway.registrySnapshotHash);
    const controller = new AbortController();
    const observed: StreamEvent[] = [];

    await expect(async () => {
      for await (const event of gateway.stream(
        gateway.resolve(selection),
        selection,
        {
          operation_id: 'cancel-stream',
          signal: controller.signal,
        },
      )) {
        observed.push(event);
        controller.abort();
      }
    }).rejects.toMatchObject({ code: 'cancelled' });
    expect(observed).toEqual([{ type: 'text_delta', text: 'first' }]);
  });

  it('rejects a credential expiring exactly now and empty lease identity', async () => {
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    for (const lease of [
      {
        lease_id: '',
        audience: 'test-audience',
        expires_at: '2030-01-02T00:00:00.000Z',
      },
      {
        lease_id: 'lease',
        audience: 'test-audience',
        expires_at: '2030-01-01T00:00:00.000Z',
      },
    ]) {
      const runtime = makeRuntime();
      runtime.resolve = vi.fn(runtime.resolve);
      const ports = makePorts();
      ports.clock.now = vi.fn(() => now);
      ports.secretsBroker.exchangeCredential = vi.fn(async () => lease);
      const { gateway } = makeGateway(
        [
          makeReg(
            {
              credentials: {
                required: true,
                audience: 'test-audience',
              },
            },
            runtime,
          ),
        ],
        ports,
      );
      const selection = makeSelection(gateway.registrySnapshotHash);

      await expect(
        gateway.dispatch(gateway.resolve(selection), selection, {
          operation_id: 'credential-boundary',
        }),
      ).rejects.toMatchObject({ code: 'credential_exchange_failed' });
      expect(runtime.resolve).not.toHaveBeenCalled();
    }
  });
});
