import { describe, it, expect } from 'vitest';
import {
  createHarnessHookAttenuationPolicy,
  dispatchHookBoundary,
  type RuntimeHookRequest,
  type RuntimeHookScope,
  type HookRuntimePort,
} from '../../runtime/hook-port.js';

const policy = createHarnessHookAttenuationPolicy();

function makeScope(): RuntimeHookScope {
  return { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' };
}

function makeReq(overrides: Record<string, unknown> = {}): RuntimeHookRequest {
  return {
    event: 'pre_tool_use',
    scope: makeScope(),
    payload: { test: true },
    invocation_id: 'inv1',
    idempotency_key: 'key1',
    ...overrides,
  } as unknown as RuntimeHookRequest;
}

// ---- canonicalJson: test through sameJson via pre_turn/session_before_compact ----
describe('hook-port-survival-9: canonicalJson via sameJson', () => {
  it('sameJson correctly compares objects with keys', () => {
    // pre_turn uses sameJson - test with objects that have keys
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { a: 1, b: 2 },
      candidate_payload: { a: 1, b: 2 },
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson correctly detects different objects', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { a: 1, b: 2 },
      candidate_payload: { a: 1, b: 3 },
    });
    expect(result.allowed).toBe(false);
  });

  it('sameJson correctly compares arrays', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: [1, 2, 3],
      candidate_payload: [1, 2, 3],
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson correctly detects different arrays', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: [1, 2, 3],
      candidate_payload: [1, 2, 4],
    });
    expect(result.allowed).toBe(false);
  });

  it('sameJson handles key ordering (sorts keys)', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { b: 2, a: 1 },
      candidate_payload: { a: 1, b: 2 },
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson handles nested objects', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { outer: { inner: 'value' } },
      candidate_payload: { outer: { inner: 'value' } },
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson handles nested arrays in objects', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { items: [1, 2] },
      candidate_payload: { items: [1, 2] },
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson handles null and undefined', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: null,
      candidate_payload: null,
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson handles primitives', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope: makeScope(),
      original_payload: 'hello',
      candidate_payload: 'hello',
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson detects different primitives', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope: makeScope(),
      original_payload: 'hello',
      candidate_payload: 'world',
    });
    expect(result.allowed).toBe(false);
  });

  it('sameKeys detects different key sets via taskContractNarrows', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: makeScope(),
      original_payload: { prompt: 'test', constraints: [] },
      candidate_payload: { prompt: 'test', constraints: [], extra: true },
    });
    expect(result.allowed).toBe(false);
  });
});

// ---- validPortResult: test through dispatchHookBoundary ----
describe('hook-port-survival-9: validPortResult edge cases', () => {
  it('rejects result with wrong event field', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'wrong_event',
          action: 'continue',
          payload: {},
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('rejects result with invalid action', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'invalid_action',
          payload: {},
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('rejects result without payload', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'continue',
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('rejects result without follow_ups array', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'continue',
          payload: {},
          follow_ups: 'not_array',
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('rejects result without replayed boolean', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'continue',
          payload: {},
          follow_ups: [],
          replayed: 'not_boolean',
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('rejects continue action with reason_code', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'continue',
          payload: {},
          reason_code: 'should_not_be_here',
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('rejects deny action without reason_code', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'deny',
          payload: {},
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('rejects deny action with empty reason_code', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'deny',
          payload: {},
          reason_code: '   ',
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('accepts valid deny with non-empty reason_code', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'deny',
          payload: {},
          reason_code: 'policy_violation',
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('policy_violation');
  });

  it('rejects result with extra keys', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'continue',
          payload: {},
          follow_ups: [],
          replayed: false,
          extra_key: true,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const result = await dispatchHookBoundary(port, makeReq(), { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });
});

// ---- outcome function: reason_code conditional ----
describe('hook-port-survival-9: outcome reason_code', () => {
  it('outcome includes reason_code when provided (no port)', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = {
      async dispatch() { return {} as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>; },
    };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      signal: controller.signal,
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 1000, mode: 'decision' });
    expect(result.reason_code).toBe('hook_cancelled');
  });

  it('outcome does not include reason_code for continue without port', async () => {
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(undefined, request, { timeout_ms: 1000, mode: 'decision' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBeUndefined();
  });

  it('outcome includes reason_code for timeout in decision mode', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: {},
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 50, mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_timeout');
  });

  it('outcome includes reason_code for port error in decision mode', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        throw new Error('port crashed');
      },
    };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: {},
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_failed');
  });
});
