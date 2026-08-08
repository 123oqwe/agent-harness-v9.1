import { describe, it, expect, vi } from 'vitest';
import {
  FrozenProviderRegistry,
  ModelGateway,
  ProviderDispatchError,
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

function makeErrorRuntime(errorFn: () => never): GatewayProviderRuntime {
  return {
    provider_type: 'scripted_test' as const,
    normalizeRequest: () => ({}),
    parseResponse: () => ({ content: '', model: 's', stop_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 } }),
    normalizeToolCall: () => { throw new Error('not supported'); },
    streamEvents: errorRuntimeStreamFn(errorFn),
    mapError: (e: unknown) => {
      if (e instanceof ProviderHttpError) {
        const status = e.status;
        if (status === 401) return { kind: 'auth', retryable: false, detail: e.message };
        if (status === 400) return { kind: 'invalid_request', retryable: false, detail: e.message };
        if (status === 429) return { kind: 'rate_limited', retryable: false, detail: e.message };
        if (status >= 500) return { kind: 'server', retryable: true, detail: e.message };
      }
      return { kind: 'unknown', retryable: false, detail: String(e) };
    },
    meterUsage: () => ({ input_tokens: 0, output_tokens: 0 }),
    checkHealth: () => 'healthy' as const,
    validateDataPolicy: () => ({ allowed: true }),
    resolve: errorFn,
  };
}

function errorRuntimeStreamFn(errorFn: () => never) {
  return async function* (): AsyncGenerator<StreamEvent> {
    errorFn();
    yield { type: 'message_stop' as const, stop_reason: 'stop' as const };
  };
}

function makeStreamingRuntime(events: StreamEvent[], errorAfter?: number): GatewayProviderRuntime {
  let callCount = 0;
  return {
    provider_type: 'scripted_test' as const,
    normalizeRequest: () => ({}),
    parseResponse: () => ({ content: 'ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }),
    normalizeToolCall: () => { throw new Error('not supported'); },
    streamEvents: async function* (): AsyncGenerator<StreamEvent> {
      callCount++;
      if (errorAfter !== undefined && callCount > errorAfter) {
        throw new ProviderHttpError(503);
      }
      for (const e of events) yield e;
    },
    mapError: (e: unknown) => {
      if (e instanceof ProviderHttpError) {
        if (e.status === 401) return { kind: 'auth', retryable: false, detail: e.message };
        if (e.status === 400) return { kind: 'invalid_request', retryable: false, detail: e.message };
        if (e.status >= 500) return { kind: 'server', retryable: true, detail: e.message };
      }
      return { kind: 'unknown', retryable: false, detail: String(e) };
    },
    meterUsage: () => ({ input_tokens: 1, output_tokens: 1 }),
    checkHealth: () => 'healthy' as const,
    validateDataPolicy: () => ({ allowed: true }),
    resolve: async () => ({ content: 'ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }),
  };
}

function makeSuccessRuntime(): GatewayProviderRuntime {
  const provider = new ScriptedTestProvider({
    queue: [{ content: 'ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 5, output_tokens: 3 } }],
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

function makeReg(id: string, runtime: GatewayProviderRuntime, caps: string[] = ['text_reasoning']): GatewayProviderRegistration {
  return {
    provider_id: id,
    contract: scriptedProviderContract,
    adapter: runtime,
    metadata: {
      capabilities: caps,
      max_context_tokens: 100000,
      structured_output: true,
      tool_calling: true,
      data_policy: { execution: 'local', regions: ['us'], retention_days: 30, training_allowed: false },
      pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2 },
      health: 'healthy',
      network: { required: false },
      credentials: { required: false, audience: 'none' },
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

function makeGateway(regs: GatewayProviderRegistration[]) {
  const registry = new FrozenProviderRegistry(regs);
  const ports = makePorts();
  const gateway = new ModelGateway(registry, ports);
  return { registry, gateway, ports };
}

function makeSel(hash: string, overrides: Partial<ProviderSelectionRequest> = {}): ProviderSelectionRequest {
  return {
    registry_snapshot_hash: hash,
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

describe('ModelGateway.dispatch error classification', () => {
  it('does not retry on auth error (non-retryable)', async () => {
    const errorFn = () => { throw new ProviderHttpError(401); };
    const runtime = makeErrorRuntime(errorFn);
    const { gateway, ports } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'auth-test' })).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'auth', retryable: false },
    });
    expect(ports.clock.sleep).not.toHaveBeenCalled();
  });

  it('does not retry on invalid_request error (non-retryable)', async () => {
    const errorFn = () => { throw new ProviderHttpError(400); };
    const runtime = makeErrorRuntime(errorFn);
    const { gateway, ports } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'invalid-test' })).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'invalid_request', retryable: false },
    });
    expect(ports.clock.sleep).not.toHaveBeenCalled();
  });

  it('retries on server error (retryable) and then fails after maxAttempts', async () => {
    const errorFn = () => { throw new ProviderHttpError(503); };
    const runtime = makeErrorRuntime(errorFn);
    const { gateway, ports } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'retry-test' })).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'server', retryable: true },
    });
    expect(ports.clock.sleep).toHaveBeenCalledTimes(2);
  });

  it('falls back to another provider on retryable error', async () => {
    const errorFn = () => { throw new ProviderHttpError(503); };
    const failRuntime = makeErrorRuntime(errorFn);
    const successRuntime = makeSuccessRuntime();
    const { gateway } = makeGateway([
      makeReg('p1', failRuntime),
      makeReg('p2', successRuntime),
    ]);
    const sel = makeSel(gateway.registrySnapshotHash);
    const result = await gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'fallback-test' });
    expect(result.provider_id).toBe('p2');
    expect(result.response.content).toBe('ok');
  });

  it('does not fall back on auth error (non-retryable)', async () => {
    const errorFn = () => { throw new ProviderHttpError(401); };
    const failRuntime = makeErrorRuntime(errorFn);
    const successRuntime = makeSuccessRuntime();
    const { gateway } = makeGateway([
      makeReg('p1', failRuntime),
      makeReg('p2', successRuntime),
    ]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'no-fallback-auth' })).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'auth' },
    });
  });

  it('does not fall back on invalid_request error (non-retryable)', async () => {
    const errorFn = () => { throw new ProviderHttpError(400); };
    const failRuntime = makeErrorRuntime(errorFn);
    const successRuntime = makeSuccessRuntime();
    const { gateway } = makeGateway([
      makeReg('p1', failRuntime),
      makeReg('p2', successRuntime),
    ]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'no-fallback-invalid' })).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'invalid_request' },
    });
  });
});

describe('ModelGateway.dispatchStream error classification', () => {
  it('does not retry stream on auth error', async () => {
    const errorFn = () => { throw new ProviderHttpError(401); };
    const runtime = makeErrorRuntime(errorFn);
    const { gateway, ports } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(async () => {
      for await (const _ of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-auth' })) {
        // consume
      }
    }).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'auth' },
    });
    expect(ports.clock.sleep).not.toHaveBeenCalled();
  });

  it('does not retry stream on invalid_request error', async () => {
    const errorFn = () => { throw new ProviderHttpError(400); };
    const runtime = makeErrorRuntime(errorFn);
    const { gateway, ports } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(async () => {
      for await (const _ of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-invalid' })) {
        // consume
      }
    }).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'invalid_request' },
    });
    expect(ports.clock.sleep).not.toHaveBeenCalled();
  });

  it('retries stream on server error up to maxAttempts', async () => {
    const errorFn = () => { throw new ProviderHttpError(503); };
    const runtime = makeErrorRuntime(errorFn);
    const { gateway, ports } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(async () => {
      for await (const _ of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-retry' })) {
        // consume
      }
    }).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'server' },
    });
    expect(ports.clock.sleep).toHaveBeenCalledTimes(2);
  });

  it('throws provider_failure when error occurs after events already yielded', async () => {
    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'partial' },
    ];
    let callCount = 0;
    const runtime: GatewayProviderRuntime = {
      provider_type: 'scripted_test' as const,
      normalizeRequest: () => ({}),
      parseResponse: () => ({ content: 'ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }),
      normalizeToolCall: () => { throw new Error('not supported'); },
      streamEvents: async function* (): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          yield { type: 'text_delta', text: 'partial' };
          throw new ProviderHttpError(503);
        }
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
      },
      mapError: (e: unknown) => {
        if (e instanceof ProviderHttpError && e.status >= 500) return { kind: 'server', retryable: true, detail: e.message };
        return { kind: 'unknown', retryable: false, detail: String(e) };
      },
      meterUsage: () => ({ input_tokens: 1, output_tokens: 1 }),
      checkHealth: () => 'healthy' as const,
      validateDataPolicy: () => ({ allowed: true }),
      resolve: async () => ({ content: 'ok', model: 's', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }),
    };
    const { gateway } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(async () => {
      for await (const _ of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-partial' })) {
        // consume
      }
    }).rejects.toMatchObject({
      code: 'provider_failure',
    });
  });

  it('records usage after successful stream', async () => {
    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    const runtime = makeStreamingRuntime(events);
    const { gateway, ports } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    const collected: StreamEvent[] = [];
    for await (const ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-usage' })) {
      collected.push(ev);
    }
    expect(ports.usageMeter.record).toHaveBeenCalledWith({
      provider_id: 'p1',
      operation_id: 'stream-usage',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  it('falls back to another provider on stream retryable error', async () => {
    const errorFn = () => { throw new ProviderHttpError(503); };
    const failRuntime = makeErrorRuntime(errorFn);
    const successEvents: StreamEvent[] = [
      { type: 'text_delta', text: 'recovered' },
      { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 3, output_tokens: 2 } },
    ];
    const successRuntime = makeStreamingRuntime(successEvents);
    const { gateway } = makeGateway([
      makeReg('p1', failRuntime),
      makeReg('p2', successRuntime),
    ]);
    const sel = makeSel(gateway.registrySnapshotHash);
    const collected: StreamEvent[] = [];
    for await (const ev of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-fallback' })) {
      collected.push(ev);
    }
    expect(collected.some(e => e.type === 'text_delta')).toBe(true);
  });

  it('does not fall back on stream auth error', async () => {
    const errorFn = () => { throw new ProviderHttpError(401); };
    const failRuntime = makeErrorRuntime(errorFn);
    const successEvents: StreamEvent[] = [
      { type: 'text_delta', text: 'should not reach' },
      { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 3, output_tokens: 2 } },
    ];
    const successRuntime = makeStreamingRuntime(successEvents);
    const { gateway } = makeGateway([
      makeReg('p1', failRuntime),
      makeReg('p2', successRuntime),
    ]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await expect(async () => {
      for await (const _ of gateway.dispatchStream(gateway.resolve(sel), sel, { operation_id: 'stream-no-fallback-auth' })) {
        // consume
      }
    }).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'auth' },
    });
  });
});

describe('ModelGateway.dispatch usage metering', () => {
  it('records usage after successful dispatch', async () => {
    const runtime = makeSuccessRuntime();
    const { gateway, ports } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'meter-test' });
    expect(ports.usageMeter.record).toHaveBeenCalledWith({
      provider_id: 'p1',
      operation_id: 'meter-test',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  });

  it('passes attempt_id to resolve when provided', async () => {
    const runtime = makeSuccessRuntime();
    runtime.resolve = vi.fn(runtime.resolve);
    const { gateway } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'attempt-test', attempt_id: 'att-1' });
    expect(runtime.resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attempt_id: 'att-1' }),
    );
  });

  it('passes deadline_at to resolve when provided', async () => {
    const runtime = makeSuccessRuntime();
    runtime.resolve = vi.fn(runtime.resolve);
    const { gateway } = makeGateway([makeReg('p1', runtime)]);
    const sel = makeSel(gateway.registrySnapshotHash);
    await gateway.dispatch(gateway.resolve(sel), sel, { operation_id: 'deadline-test', deadline_at: '2026-12-31T23:59:59Z' });
    expect(runtime.resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deadline_at: '2026-12-31T23:59:59Z' }),
    );
  });
});
