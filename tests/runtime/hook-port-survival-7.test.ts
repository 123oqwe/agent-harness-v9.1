import { describe, it, expect, vi } from 'vitest';
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

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    registry_snapshot_hash: 'h1',
    estimated_input_tokens: 100,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 },
    data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
    policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] },
    run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [] },
    ...overrides,
  };
}

describe('hook-port-survival-7: constraintsNarrow guard clause', () => {
  it('rejects privacy constraint with numeric values', () => {
    const o = { goal: 'g', success_criteria: [], constraints: [{ type: 'privacy', value: '100' }] };
    const c = { goal: 'g', success_criteria: [], constraints: [{ type: 'privacy', value: '50' }] };
    expect(policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects tool_restriction with numeric values', () => {
    const o = { goal: 'g', success_criteria: [], constraints: [{ type: 'tool_restriction', value: '10' }] };
    const c = { goal: 'g', success_criteria: [], constraints: [{ type: 'tool_restriction', value: '5' }] };
    expect(policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects model_restriction with numeric values', () => {
    const o = { goal: 'g', success_criteria: [], constraints: [{ type: 'model_restriction', value: '10' }] };
    const c = { goal: 'g', success_criteria: [], constraints: [{ type: 'model_restriction', value: '5' }] };
    expect(policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects budget with Infinity value', () => {
    const o = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: 'Infinity' }] };
    const c = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '50' }] };
    expect(policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('allows budget with zero candidate', () => {
    const o = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const c = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '0' }] };
    expect(policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
  it('allows budget with equal values', () => {
    const o = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const c = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    expect(policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
  it('rejects budget with non-numeric original', () => {
    const o = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: 'abc' }] };
    const c = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '50' }] };
    expect(policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects budget with non-numeric candidate', () => {
    const o = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const c = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: 'xyz' }] };
    expect(policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
});

describe('hook-port-survival-7: canonicalJson via sameJson', () => {
  it('allows identical array payloads for pre_turn', () => {
    expect(policy.validate({ event: 'pre_turn', scope: makeScope(), original_payload: { messages: [{ role: 'user', content: 'hi' }] }, candidate_payload: { messages: [{ role: 'user', content: 'hi' }] } }).allowed).toBe(true);
  });
  it('rejects different array payloads for pre_turn', () => {
    expect(policy.validate({ event: 'pre_turn', scope: makeScope(), original_payload: { messages: [{ role: 'user', content: 'hi' }] }, candidate_payload: { messages: [{ role: 'user', content: 'bye' }] } }).allowed).toBe(false);
  });
  it('allows identical nested objects for session_before_compact', () => {
    expect(policy.validate({ event: 'session_before_compact', scope: makeScope(), original_payload: { key: { nested: [1, 2, 3] } }, candidate_payload: { key: { nested: [1, 2, 3] } } }).allowed).toBe(true);
  });
  it('rejects different nested objects for session_before_compact', () => {
    expect(policy.validate({ event: 'session_before_compact', scope: makeScope(), original_payload: { key: { nested: [1, 2, 3] } }, candidate_payload: { key: { nested: [1, 2, 4] } } }).allowed).toBe(false);
  });
  it('allows identical primitives for pre_turn', () => {
    expect(policy.validate({ event: 'pre_turn', scope: makeScope(), original_payload: 'same', candidate_payload: 'same' }).allowed).toBe(true);
  });
  it('rejects different primitives for pre_turn', () => {
    expect(policy.validate({ event: 'pre_turn', scope: makeScope(), original_payload: 'a', candidate_payload: 'b' }).allowed).toBe(false);
  });
  it('handles array vs non-array', () => {
    expect(policy.validate({ event: 'pre_turn', scope: makeScope(), original_payload: [1, 2, 3], candidate_payload: { 0: 1, 1: 2, 2: 3 } }).allowed).toBe(false);
  });
});

describe('hook-port-survival-7: allowedSetNarrows', () => {
  it('allows when original allowed_provider_ids undefined, candidate is string array', () => {
    const o = makeReq({ policy: { allowed_provider_ids: undefined, denied_provider_ids: [] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
  it('allows when both allowed_provider_ids undefined', () => {
    const o = makeReq({ policy: { allowed_provider_ids: undefined, denied_provider_ids: [] } });
    const c = makeReq({ policy: { allowed_provider_ids: undefined, denied_provider_ids: [] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
  it('allows run_plan allowed_provider_ids narrowing', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1', 'p2'], required_capabilities: [] } });
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
});

describe('hook-port-survival-7: providerRequestNarrows capabilities', () => {
  it('rejects candidate with fewer capabilities', () => {
    const o = makeReq({ required_capabilities: ['text_reasoning', 'vision'] });
    const c = makeReq({ required_capabilities: ['text_reasoning'] });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('allows candidate with superset capabilities', () => {
    const o = makeReq({ required_capabilities: ['text_reasoning'] });
    const c = makeReq({ required_capabilities: ['text_reasoning', 'vision'] });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
  it('rejects original true candidate false for requires_structured_output', () => {
    const o = makeReq({ requires_structured_output: true });
    const c = makeReq({ requires_structured_output: false });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects non-boolean requires_structured_output', () => {
    const o = makeReq({ requires_structured_output: 'yes' });
    const c = makeReq({ requires_structured_output: 'yes' });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
});

describe('hook-port-survival-7: providerRequestNarrows max_tokens', () => {
  it('allows when both max_tokens undefined', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }] } });
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
  it('rejects original undefined candidate has max_tokens', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }] } });
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500 } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects negative candidate max_tokens', () => {
    const o = makeReq();
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: -1 } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects non-integer candidate max_tokens', () => {
    const o = makeReq();
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1.5 } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
});

describe('hook-port-survival-7: providerRequestNarrows data_policy', () => {
  it('rejects candidate local_only false when original true', () => {
    const o = makeReq({ data_policy: { local_only: true, allowed_regions: [], max_retention_days: 30, training_allowed: false } });
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: [], max_retention_days: 30, training_allowed: false } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects candidate allowed_regions not subset', () => {
    const o = makeReq({ data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false } });
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us', 'asia'], max_retention_days: 30, training_allowed: false } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects candidate max_retention_days exceeds original', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 60, training_allowed: false } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects candidate training_allowed true when original false', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: true } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('allows candidate max_retention_days zero', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 0, training_allowed: false } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
});

describe('hook-port-survival-7: providerRequestNarrows policy/run_plan', () => {
  it('allows candidate denied_provider_ids superset', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['bad-p1'] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['bad-p1', 'bad-p2'] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
  it('rejects candidate denied_provider_ids not superset', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['bad-p1', 'bad-p2'] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['bad-p1'] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('allows run_plan required_capabilities superset', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['rc1'] } });
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['rc1', 'rc2'] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
  it('rejects run_plan required_capabilities not superset', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['rc1', 'rc2'] } });
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['rc1'] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects policy not a record', () => {
    const o = makeReq({ policy: 'not-a-record' });
    const c = makeReq({ policy: 'not-a-record' });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects policy keys differ', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'] } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
});

describe('hook-port-survival-7: providerRequestNarrows request/tools', () => {
  it('rejects request not a record', () => {
    const o = makeReq({ request: 'not-a-record' });
    const c = makeReq({ request: 'not-a-record' });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('rejects candidate tools not in original', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 } });
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }, { name: 'write_file' }], max_tokens: 1000 } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(false);
  });
  it('allows candidate tools subset', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }, { name: 'write_file' }], max_tokens: 1000 } });
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 } });
    expect(policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: o, candidate_payload: c }).allowed).toBe(true);
  });
});

describe('hook-port-survival-7: dispatchHookBoundary', () => {
  function makeReq2(payload: unknown): RuntimeHookRequest {
    return { event: 'pre_tool_use', scope: makeScope(), payload, signal: undefined } as unknown as RuntimeHookRequest;
  }
  it('returns continue when port undefined', async () => {
    const r = await dispatchHookBoundary(undefined, makeReq2({ foo: 'bar' }), { mode: 'decision' });
    expect(r.action).toBe('continue');
    expect(r.payload).toEqual({ foo: 'bar' });
  });
  it('freezes outcome payload', async () => {
    const r = await dispatchHookBoundary(undefined, makeReq2({ nested: { key: 'val' } }), { mode: 'decision' });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.payload)).toBe(true);
    expect(Object.isFrozen((r.payload as Record<string, unknown>).nested)).toBe(true);
  });
  it('returns continue for observational with valid port result', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'pre_tool_use', action: 'continue', payload: { foo: 'bar' }, follow_ups: [], replayed: false }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({ foo: 'bar' }), { mode: 'observational' });
    expect(r.action).toBe('continue');
  });
  it('returns deny for invalid port result in decision mode', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'pre_tool_use', action: 'invalid', payload: {}, follow_ups: [], replayed: false }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
    expect(r.reason_code).toBe('invalid_hook_boundary_result');
  });
  it('returns deny when port throws', async () => {
    const port = { dispatch: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
  });
  it('returns continue when port throws in observational', async () => {
    const port = { dispatch: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'observational' });
    expect(r.action).toBe('continue');
  });
  it('returns deny when signal aborted (decision)', async () => {
    const ac = new AbortController(); ac.abort();
    const req = makeReq2({}); (req as unknown as { signal: AbortSignal }).signal = ac.signal;
    const port = { dispatch: vi.fn() } as unknown as HookRuntimePort; const r = await dispatchHookBoundary(port, req, { mode: 'decision' });
    expect(r.action).toBe('deny');
    expect(r.reason_code).toBe('hook_cancelled');
  });
  it('returns continue when signal aborted (observational)', async () => {
    const ac = new AbortController(); ac.abort();
    const req = makeReq2({}); (req as unknown as { signal: AbortSignal }).signal = ac.signal;
    const port = { dispatch: vi.fn() } as unknown as HookRuntimePort; const r = await dispatchHookBoundary(port, req, { mode: 'observational' });
    expect(r.action).toBe('continue');
    expect(r.reason_code).toBe('hook_observer_cancelled');
  });
  it('returns deny for circular ref payload from port', async () => {
    const port = { dispatch: vi.fn().mockImplementation(() => {
      const obj: Record<string, unknown> = {}; obj.self = obj;
      return Promise.resolve({ event: 'pre_tool_use', action: 'continue', payload: obj, follow_ups: [], replayed: false });
    }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
    expect(r.reason_code).toBe('invalid_hook_boundary_result');
  });
  it('returns deny for port result with extra keys', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false, extra: 'bad' }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
  });
  it('returns deny for non-array follow_ups', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: 'no', replayed: false }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
  });
  it('returns deny for non-boolean replayed', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: 'no' }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
  });
  it('returns deny when continue has reason_code', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'pre_tool_use', action: 'continue', payload: {}, reason_code: 'bad', follow_ups: [], replayed: false }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
  });
  it('returns deny when deny has empty reason_code', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'pre_tool_use', action: 'deny', payload: {}, reason_code: '   ', follow_ups: [], replayed: false }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
    expect(r.reason_code).toBe('invalid_hook_boundary_result');
  });
  it('returns deny when event mismatch', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'before_provider_request', action: 'continue', payload: {}, follow_ups: [], replayed: false }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
  });
  it('passes through deny with reason_code from port', async () => {
    const port = { dispatch: vi.fn().mockResolvedValue({ event: 'pre_tool_use', action: 'deny', payload: {}, reason_code: 'policy', follow_ups: [], replayed: false }) } as unknown as HookRuntimePort;
    const r = await dispatchHookBoundary(port, makeReq2({}), { mode: 'decision' });
    expect(r.action).toBe('deny');
    expect(r.reason_code).toBe('policy');
  });
});
