import { describe, it, expect, vi } from 'vitest';
import {
  FrozenProviderRegistry,
  ModelGateway,
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

function makeStreamRuntime(events: StreamEvent[]): GatewayProviderRuntime {
  const provider = new ScriptedTestProvider({ queue: [] });
  return {
    provider_type: provider.provider_type,
    normalizeRequest: provider.normalizeRequest.bind(provider),
    parseResponse: provider.parseResponse.bind(provider),
    normalizeToolCall: provider.normalizeToolCall.bind(provider),
    streamEvents: async function* (): AsyncGenerator<StreamEvent> {
      for (const e of events) yield e;
    },
    mapError: provider.mapError.bind(provider),
    meterUsage: provider.meterUsage.bind(provider),
    checkHealth: () => 'healthy' as const,
    validateDataPolicy: provider.validateDataPolicy.bind(provider),
    resolve: provider.resolve.bind(provider),
  };
}

function makeReg(overrides: Partial<GatewayProviderRegistration['metadata']> = {}, runtime?: GatewayProviderRuntime): GatewayProviderRegistration {
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
  const clock: GatewayClockPort = { now: vi.fn(() => Date.now()), sleep: vi.fn(async () => undefined) };
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

describe('ModelGateway.dispatchExact deep coverage', () => {
  it('returns the exact provider result without fallback on success', async () => {
    const runtime = makeRuntime({ content: 'exact-ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 5, output_tokens: 3 } });
    runtime.resolve = vi.fn(runtime.resolve);
    const { gateway, ports } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const result = await gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-success' });
    expect(result.provider_id).toBe('p1');
    expect(result.response.content).toBe('exact-ok');
    expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
    expect(runtime.resolve).toHaveBeenCalledTimes(1);
    expect(ports.usageMeter.record).toHaveBeenCalledWith({ provider_id: 'p1', operation_id: 'exact-success', usage: { input_tokens: 5, output_tokens: 3 } });
  });

  it('retries retryable failures up to maxAttempts before failing', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn().mockRejectedValueOnce(new ProviderHttpError(503)).mockRejectedValueOnce(new ProviderHttpError(503)).mockRejectedValueOnce(new ProviderHttpError(503));
    const ports = makePorts();
    const { gateway } = makeGateway([makeReg({}, runtime)], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-retry' })).rejects.toMatchObject({ code: 'provider_failure', provider_error: { kind: 'server', retryable: true } });
    expect(runtime.resolve).toHaveBeenCalledTimes(3);
    expect(ports.clock.sleep).toHaveBeenCalledTimes(2);
    expect(ports.clock.sleep).toHaveBeenNthCalledWith(1, 100, expect.any(AbortSignal));
    expect(ports.clock.sleep).toHaveBeenNthCalledWith(2, 200, expect.any(AbortSignal));
  });

  it('does not retry non-retryable auth failure', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn().mockRejectedValue(new ProviderHttpError(401));
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-auth' })).rejects.toMatchObject({ code: 'provider_failure', provider_error: { kind: 'auth', retryable: false } });
    expect(runtime.resolve).toHaveBeenCalledTimes(1);
  });

  it('does not retry invalid_request failure', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn().mockRejectedValue(new ProviderHttpError(400));
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-invalid' })).rejects.toMatchObject({ code: 'provider_failure', provider_error: { kind: 'invalid_request', retryable: false } });
    expect(runtime.resolve).toHaveBeenCalledTimes(1);
  });

  it('rejects when registry snapshot hash mismatch', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash);
    const resolved = gateway.resolve(sel);
    const tampered = { ...resolved, registry_snapshot_hash: 'b'.repeat(64) };
    await expect(gateway.dispatchExact(tampered, sel, { operation_id: 'op' })).rejects.toThrow(ProviderDispatchError);
  });

  it('rejects when selection request hash changed', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash);
    const resolved = gateway.resolve(sel);
    const changed = { ...sel, estimated_input_tokens: 999 };
    await expect(gateway.dispatchExact(resolved, changed, { operation_id: 'op' })).rejects.toThrow(ProviderDispatchError);
  });

  it('rejects empty operation_id', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: '' })).rejects.toThrow();
  });

  it('rejects invalid deadline_at', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'op', deadline_at: 'not-a-date' })).rejects.toThrow('dispatchExact.deadline_at must be an ISO timestamp');
  });

  it('exchanges credential when provider requires it', async () => {
    const ports = makePorts();
    const reg = makeReg({ credentials: { required: true, audience: 'test-audience' } });
    const { gateway } = makeGateway([reg], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-cred' });
    expect(ports.secretsBroker.exchangeCredential).toHaveBeenCalled();
  });

  it('fails on egress denied', async () => {
    const ports = makePorts();
    ports.egressPolicy.authorize = vi.fn(async () => ({ allowed: false }));
    const { gateway } = makeGateway([makeReg()], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-egress' })).rejects.toMatchObject({ code: 'egress_denied' });
  });

  it('fails on egress policy throw', async () => {
    const ports = makePorts();
    ports.egressPolicy.authorize = vi.fn(async () => { throw new Error('egress crash'); });
    const { gateway } = makeGateway([makeReg()], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-egress-throw' })).rejects.toMatchObject({ code: 'egress_policy_failure' });
  });

  it('fails on metering throw', async () => {
    const ports = makePorts();
    ports.usageMeter.record = vi.fn(async () => { throw new Error('meter crash'); });
    const { gateway } = makeGateway([makeReg()], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-meter' })).rejects.toMatchObject({ code: 'metering_failed' });
  });

  it('fails on unhealthy provider', async () => {
    const runtime = makeRuntime();
    runtime.checkHealth = vi.fn(async () => 'degraded' as const);
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-unhealthy' })).rejects.toMatchObject({ code: 'provider_unhealthy' });
  });

  it('passes attempt_id through to provider resolve', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn(runtime.resolve);
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-att', attempt_id: 'custom-att' });
    expect(runtime.resolve).toHaveBeenCalledWith(sel.request, expect.objectContaining({ operation_id: 'exact-att', attempt_id: 'custom-att' }));
  });

  it('pre-cancels with cancelled code', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn(runtime.resolve);
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const controller = new AbortController();
    controller.abort();
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-cancel', signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(runtime.resolve).not.toHaveBeenCalled();
  });

  it('times out with timeout code', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn(() => new Promise<ParsedResponse>((resolve) => setTimeout(() => resolve({ content: 'late' }), 200)));
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-timeout', deadline_at: new Date(Date.now() + 10).toISOString() })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('fails when mapError itself throws', async () => {
    const runtime = makeRuntime();
    runtime.resolve = vi.fn(() => { throw new Error('unknown'); });
    runtime.mapError = vi.fn(() => { throw new Error('mapper crash'); });
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(gateway.dispatchExact(gateway.resolve(sel), sel, { operation_id: 'exact-mapper' })).rejects.toMatchObject({ code: 'provider_failure', provider_error: { kind: 'unknown', retryable: false, detail: 'Provider error normalization failed' } });
  });
});

describe('ModelGateway.dispatchStream deep coverage', () => {
  it('streams events and meters terminal usage', async () => {
    const runtime = makeStreamRuntime([
      { type: 'text_delta', text: 'hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const ports = makePorts();
    const { gateway } = makeGateway([makeReg({}, runtime)], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const events: StreamEvent[] = [];
    for await (const ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-ok' })) { events.push(ev); }
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'message_stop']);
    expect(ports.usageMeter.record).toHaveBeenCalledWith({ provider_id: 'p1', operation_id: 'stream-ok', usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it('falls back to another provider on retryable stream failure', async () => {
    const failing = makeStreamRuntime([]);
    failing.streamEvents = async function* () { throw new ProviderHttpError(503); };
    const working = makeStreamRuntime([
      { type: 'text_delta', text: 'fallback' },
      { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const cheap = makeReg({ pricing: { currency: 'USD', input_per_million: 0, output_per_million: 0 } }, failing);
    cheap.provider_id = 'cheap-failing';
    const backup = makeReg({ pricing: { currency: 'USD', input_per_million: 10, output_per_million: 10 } }, working);
    backup.provider_id = 'backup';
    const { gateway } = makeGateway([cheap, backup]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const events: StreamEvent[] = [];
    for await (const ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-fallback' })) { events.push(ev); }
    expect(events.at(-1)?.type).toBe('message_stop');
  });

  it('does not fall back after auth failure', async () => {
    const failing = makeStreamRuntime([]);
    failing.streamEvents = async function* () { throw new ProviderHttpError(401); };
    const backup = makeStreamRuntime([{ type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }]);
    const first = makeReg({ pricing: { currency: 'USD', input_per_million: 0, output_per_million: 0 } }, failing);
    first.provider_id = 'a-failing';
    const second = makeReg({}, backup);
    second.provider_id = 'z-backup';
    const { gateway } = makeGateway([first, second]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(async () => { for await (const _ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-auth' })) { /* consume */ } }).rejects.toMatchObject({ code: 'provider_failure', provider_error: { kind: 'auth', retryable: false } });
  });

  it('does not retry on same provider after events already yielded', async () => {
    // When events are already yielded, the inner loop does not retry on the same
    // provider even for retryable errors. The outer dispatchStream may still
    // switch providers for retryable failures.
    const partial = makeStreamRuntime([]);
    let streamCallCount = 0;
    partial.streamEvents = async function* () {
      streamCallCount++;
      yield { type: 'text_delta', text: 'partial' };
      throw new ProviderHttpError(503);
    };
    const backup = makeStreamRuntime([
      { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const first = makeReg({ pricing: { currency: 'USD', input_per_million: 0, output_per_million: 0 } }, partial);
    first.provider_id = 'a-partial';
    const second = makeReg({}, backup);
    second.provider_id = 'z-backup';
    const { gateway } = makeGateway([first, second]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const collected: StreamEvent[] = [];
    for await (const ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-partial' })) {
      collected.push(ev);
    }
    // The first provider was called exactly once (no retry), then fallback to backup
    expect(streamCallCount).toBe(1);
    // Collected events include the partial + backup's message_stop
    expect(collected.map((e) => e.type)).toContain('message_stop');
  });

  it('retries retryable stream failure with backoff', async () => {
    const runtime = makeStreamRuntime([]);
    let callCount = 0;
    runtime.streamEvents = async function* () {
      callCount++;
      if (callCount < 3) throw new ProviderHttpError(503);
      yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    const ports = makePorts();
    const { gateway } = makeGateway([makeReg({}, runtime)], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const events: StreamEvent[] = [];
    for await (const ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-retry' })) { events.push(ev); }
    expect(events.at(-1)?.type).toBe('message_stop');
    expect(ports.clock.sleep).toHaveBeenCalledTimes(2);
  });

  it('rejects stale registry snapshot', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash);
    const resolved = gateway.resolve(sel);
    const tampered = { ...resolved, registry_snapshot_hash: 'c'.repeat(64) };
    await expect(async () => { for await (const _ev of gateway.dispatchStream(tampered, sel, { operation_id: 'stream-stale' })) { /* consume */ } }).rejects.toThrow(ProviderDispatchError);
  });

  it('rejects invalid deadline_at', async () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(async () => { for await (const _ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream', deadline_at: 'bad' })) { /* consume */ } }).rejects.toThrow('dispatchStream.deadline_at must be an ISO timestamp');
  });

  it('pre-cancels with cancelled code', async () => {
    const runtime = makeStreamRuntime([{ type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }]);
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const controller = new AbortController();
    controller.abort();
    await expect(async () => { for await (const _ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-cancel', signal: controller.signal })) { /* consume */ } }).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('exchanges credential when provider requires it', async () => {
    const ports = makePorts();
    const reg = makeReg({ credentials: { required: true, audience: 'test-audience' } });
    const streamRuntime = makeStreamRuntime([{ type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }]);
    reg.adapter = streamRuntime;
    const { gateway } = makeGateway([reg], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    for await (const _ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-cred' })) { /* consume */ }
    expect(ports.secretsBroker.exchangeCredential).toHaveBeenCalled();
  });

  it('fails on unhealthy provider', async () => {
    const runtime = makeStreamRuntime([{ type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }]);
    runtime.checkHealth = vi.fn(async () => 'down' as const);
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(async () => { for await (const _ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-unhealthy' })) { /* consume */ } }).rejects.toMatchObject({ code: 'provider_unhealthy' });
  });

  it('fails on metering throw after successful stream', async () => {
    const runtime = makeStreamRuntime([{ type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }]);
    const ports = makePorts();
    ports.usageMeter.record = vi.fn(async () => { throw new Error('meter crash'); });
    const { gateway } = makeGateway([makeReg({}, runtime)], ports);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(async () => { for await (const _ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-meter' })) { /* consume */ } }).rejects.toMatchObject({ code: 'metering_failed' });
  });

  it('fails when mapError throws on stream error', async () => {
    const runtime = makeStreamRuntime([]);
    runtime.streamEvents = async function* () { throw new Error('stream crash'); };
    runtime.mapError = vi.fn(() => { throw new Error('mapper crash'); });
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    await expect(async () => { for await (const _ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-mapper' })) { /* consume */ } }).rejects.toMatchObject({ code: 'provider_failure', provider_error: { kind: 'unknown', retryable: false, detail: 'Provider error normalization failed' } });
  });

  it('passes attempt_id through to stream context', async () => {
    const seenContexts: unknown[] = [];
    const runtime = makeStreamRuntime([]);
    runtime.streamEvents = vi.fn(async function* (_req, ctx): AsyncGenerator<StreamEvent> {
      seenContexts.push(ctx);
      yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    for await (const _ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-att', attempt_id: 'custom-stream-att' })) { /* consume */ }
    expect(seenContexts[0]).toEqual(expect.objectContaining({ operation_id: 'stream-att', attempt_id: 'custom-stream-att' }));
  });
});

describe('ModelGateway.resolve deep edge cases', () => {
  it('selects cheapest when RunPlan allowed_provider_ids restricts', () => {
    const expensive = makeReg({ pricing: { currency: 'USD', input_per_million: 100, output_per_million: 200 } });
    expensive.provider_id = 'expensive';
    const cheap = makeReg({ pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2 } });
    cheap.provider_id = 'cheap';
    const { gateway } = makeGateway([expensive, cheap]);
    const sel = makeSelection(gateway.registrySnapshotHash, { run_plan: { allowed_provider_ids: ['cheap', 'expensive'], required_capabilities: [] } });
    expect(gateway.resolve(sel).provider_id).toBe('cheap');
  });

  it('combines required_capabilities from request and run_plan', () => {
    const reg = makeReg({ capabilities: ['text_reasoning', 'vision'] });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway.registrySnapshotHash, { required_capabilities: ['text_reasoning'], run_plan: { allowed_provider_ids: undefined, required_capabilities: ['vision'] } });
    expect(gateway.resolve(sel).provider_id).toBe('p1');
  });

  it('rejects when run_plan required capability is missing', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash, { run_plan: { allowed_provider_ids: undefined, required_capabilities: ['vision'] } });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('accepts exact context boundary (input + max_tokens == capacity)', () => {
    const reg = makeReg({ max_context_tokens: 74 });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway.registrySnapshotHash, { estimated_input_tokens: 10, request: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 } });
    expect(gateway.resolve(sel).provider_id).toBe('p1');
  });

  it('rejects when input + max_tokens exceeds capacity by 1', () => {
    const reg = makeReg({ max_context_tokens: 73 });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway.registrySnapshotHash, { estimated_input_tokens: 10, request: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 } });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('accepts provider with zero max_tokens in request', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash, { request: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(gateway.resolve(sel).provider_id).toBe('p1');
  });

  it('rejects when adapter normalizeRequest throws', () => {
    const runtime = makeRuntime();
    runtime.normalizeRequest = vi.fn(() => { throw new Error('bad request'); });
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when adapter validateDataPolicy returns allowed=false', () => {
    const runtime = makeRuntime();
    runtime.validateDataPolicy = vi.fn(() => ({ allowed: false, reason: 'denied' }));
    const { gateway } = makeGateway([makeReg({}, runtime)]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when snapshot health is degraded', () => {
    const reg = makeReg({ health: 'degraded' as const });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('rejects when snapshot health is down', () => {
    const reg = makeReg({ health: 'down' as const });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('allows when policy allowed_provider_ids includes provider', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash, { policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] } });
    expect(gateway.resolve(sel).provider_id).toBe('p1');
  });

  it('rejects when policy allowed_provider_ids excludes provider', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash, { policy: { allowed_provider_ids: ['other'], denied_provider_ids: [] } });
    expect(() => gateway.resolve(sel)).toThrow(ProviderResolutionError);
  });

  it('describeResolved returns execution type', () => {
    const reg = makeReg({ data_policy: { execution: 'remote', regions: ['us'], retention_days: 30, training_allowed: false } });
    const { gateway } = makeGateway([reg]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const resolved = gateway.resolve(sel);
    const desc = gateway.describeResolved(resolved);
    expect(desc.execution).toBe('remote');
    expect(desc.provider_type).toBe('scripted_test');
  });

  it('switchProvider with attempted list excludes prior providers', () => {
    const r1 = makeReg({ pricing: { currency: 'USD', input_per_million: 10, output_per_million: 20 } });
    r1.provider_id = 'a';
    const r2 = makeReg({ pricing: { currency: 'USD', input_per_million: 5, output_per_million: 10 } });
    r2.provider_id = 'b';
    const r3 = makeReg({ pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2 } });
    r3.provider_id = 'c';
    const { gateway } = makeGateway([r1, r2, r3]);
    const sel = makeSelection(gateway.registrySnapshotHash);
    const first = gateway.resolve(sel);
    expect(first.provider_id).toBe('c');
    const second = gateway.switchProvider(first, sel, []);
    expect(second.provider_id).toBe('b');
    const third = gateway.switchProvider(second, sel, [first.provider_id]);
    expect(third.provider_id).toBe('a');
  });

  it('switchProvider fails when no provider left after exclusion', () => {
    const { gateway } = makeGateway();
    const sel = makeSelection(gateway.registrySnapshotHash);
    const resolved = gateway.resolve(sel);
    expect(() => gateway.switchProvider(resolved, sel, [resolved.provider_id])).toThrow(ProviderResolutionError);
  });

  it('registrySnapshot returns frozen providers list', () => {
    const { gateway } = makeGateway();
    const snap = gateway.registrySnapshot;
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.providers)).toBe(true);
    expect(snap.providers.length).toBe(1);
    expect(snap.providers[0]!.provider_id).toBe('p1');
  });

  it('estimatedPrice uses both input and output pricing', () => {
    const reg1 = makeReg({ pricing: { currency: 'USD', input_per_million: 0, output_per_million: 100 } });
    reg1.provider_id = 'a';
    const reg2 = makeReg({ pricing: { currency: 'USD', input_per_million: 100, output_per_million: 0 } });
    reg2.provider_id = 'b';
    const { gateway } = makeGateway([reg1, reg2]);
    const sel = makeSelection(gateway.registrySnapshotHash, { estimated_input_tokens: 10, request: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 } });
    expect(gateway.resolve(sel).provider_id).toBe('b');
  });
});
