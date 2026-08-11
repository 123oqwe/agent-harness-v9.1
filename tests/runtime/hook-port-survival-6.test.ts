import { describe, it, expect, vi } from 'vitest';
import { createHarnessHookAttenuationPolicy, dispatchHookBoundary } from '../../runtime/hook-port.js';

const policy = createHarnessHookAttenuationPolicy();

function makeScope() {
  return { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' };
}

// ---- constraintsNarrow edge cases (L261-295) ----
describe('hook-port-survival-6: constraintsNarrow edge cases', () => {
  it('rejects when original is not an array', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: makeScope(),
      original_payload: { goal: 'g', success_criteria: [], constraints: 'not-array' },
      candidate_payload: { goal: 'g', success_criteria: [], constraints: [] },
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate is not an array', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: makeScope(),
      original_payload: { goal: 'g', success_criteria: [], constraints: [] },
      candidate_payload: { goal: 'g', success_criteria: [], constraints: 'not-array' },
    });
    expect(result.allowed).toBe(false);
  });

  it('allows budget constraint with lower numeric value', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '50' }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(true);
  });

  it('allows time constraint with lower numeric value', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'time', value: '60' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'time', value: '30' }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(true);
  });

  it('allows risk_ceiling constraint with lower numeric value', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'risk_ceiling', value: '10' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'risk_ceiling', value: '5' }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(true);
  });

  it('rejects budget constraint with higher numeric value', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '50' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(false);
  });

  it('rejects when budget candidate is negative', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '50' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '-1' }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(false);
  });

  it('rejects privacy constraint with different value (non-numeric must match)', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'privacy', value: 'strict' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'privacy', value: 'relaxed' }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(false);
  });

  it('allows privacy constraint with same value', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'privacy', value: 'strict' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'privacy', value: 'strict' }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(true);
  });

  it('rejects constraint with invalid type', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'invalid_type', value: 'x' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'invalid_type', value: 'x' }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(false);
  });

  it('rejects constraint with non-string value', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: 100 }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: 100 }] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(false);
  });

  it('rejects when original has constraint not present in candidate', () => {
    const original = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const candidate = { goal: 'g', success_criteria: [], constraints: [] };
    const result = policy.validate({ event: 'user_prompt_submit', scope: makeScope(), original_payload: original, candidate_payload: candidate });
    expect(result.allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: max_tokens narrowing (L314-315) ----
describe('hook-port-survival-6: providerRequestNarrows max_tokens (L314-343)', () => {
  function makeReq(overrides: Record<string, unknown> = {}) {
    return {
      registry_snapshot_hash: 'h1',
      estimated_input_tokens: 100,
      required_capabilities: ['text_reasoning'],
      requires_structured_output: false,
      request: {
        messages: [],
        tools: [{ name: 'read_file' }],
        max_tokens: 1000,
      },
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
      policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [] },
      ...overrides,
    };
  }

  it('allows max_tokens reduction', () => {
    const orig = makeReq();
    const cand = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500 } });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(true);
  });

  it('rejects max_tokens increase', () => {
    const orig = makeReq();
    const cand = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 2000 } });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(false);
  });

  it('allows same max_tokens', () => {
    const orig = makeReq();
    const cand = makeReq();
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(true);
  });

  it('rejects negative max_tokens in candidate', () => {
    const orig = makeReq();
    const cand = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: -1 } });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-integer max_tokens in candidate', () => {
    const orig = makeReq();
    const cand = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500.5 } });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(false);
  });

  it('rejects when tools array has extra tool in candidate', () => {
    const orig = makeReq();
    const cand = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }, { name: 'write_file' }], max_tokens: 1000 } });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(false);
  });

  it('allows tools removal (subset)', () => {
    const orig = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }, { name: 'write_file' }], max_tokens: 1000 } });
    const cand = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 } });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(true);
  });

  it('allows requires_structured_output false->true (narrowing)', () => {
    const orig = makeReq();
    const cand = makeReq({ requires_structured_output: true });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(true);
  });

  it('rejects requires_structured_output true->false (expansion)', () => {
    const orig = makeReq({ requires_structured_output: true });
    const cand = makeReq({ requires_structured_output: false });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(false);
  });

  it('rejects when max_tokens undefined in original but present in candidate', () => {
    const orig = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }] } });
    const cand = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500 } });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(false);
  });

  it('allows when max_tokens undefined in both', () => {
    const orig = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }] } });
    const cand = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }] } });
    const result = policy.validate({ event: 'before_provider_request', scope: makeScope(), original_payload: orig, candidate_payload: cand });
    expect(result.allowed).toBe(true);
  });
});

// ---- dispatchHookBoundary: mode=decision vs observational (L467-630) ----
describe('hook-port-survival-6: dispatchHookBoundary mode handling', () => {
  it('returns continue when port is undefined', async () => {
    const result = await dispatchHookBoundary(undefined, {
      event: 'pre_turn',
      invocation_id: 'inv1',
      idempotency_key: 'idem1',
      scope: makeScope(),
      payload: { messages: [] },
    }, { mode: 'decision' });
    expect(result.action).toBe('continue');
    expect(result.event).toBe('pre_turn');
    expect(result.payload).toEqual({ messages: [] });
    expect(result.follow_ups).toEqual([]);
    expect(result.replayed).toBe(false);
  });

  it('throws when timeout_ms is not a positive integer (port defined)', async () => {
    await expect(dispatchHookBoundary({ dispatch: vi.fn() } as any, {
      event: 'pre_turn',
      invocation_id: 'inv2',
      idempotency_key: 'idem2',
      scope: makeScope(),
      payload: {},
    }, { mode: 'decision', timeout_ms: 0 })).rejects.toThrow(TypeError);
  });

  it('throws when timeout_ms is negative (port defined)', async () => {
    await expect(dispatchHookBoundary({ dispatch: vi.fn() } as any, {
      event: 'pre_turn',
      invocation_id: 'inv3',
      idempotency_key: 'idem3',
      scope: makeScope(),
      payload: {},
    }, { mode: 'decision', timeout_ms: -1 })).rejects.toThrow(TypeError);
  });

  it('throws when timeout_ms is not an integer (port defined)', async () => {
    await expect(dispatchHookBoundary({ dispatch: vi.fn() } as any, {
      event: 'pre_turn',
      invocation_id: 'inv4',
      idempotency_key: 'idem4',
      scope: makeScope(),
      payload: {},
    }, { mode: 'decision', timeout_ms: 5000.5 })).rejects.toThrow(TypeError);
  });

  it('returns deny when signal is aborted in decision mode', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(),
    } as any, {
      event: 'pre_tool_use',
      invocation_id: 'inv5',
      idempotency_key: 'idem5',
      scope: makeScope(),
      payload: { tool_name: 'read_file' },
      signal: controller.signal,
    }, { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_cancelled');
  });

  it('returns continue when signal is aborted in observational mode', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(),
    } as any, {
      event: 'post_turn',
      invocation_id: 'inv6',
      idempotency_key: 'idem6',
      scope: makeScope(),
      payload: { iteration: 1 },
      signal: controller.signal,
    }, { mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_cancelled');
  });

  it('returns deny with invalid_hook_boundary_result when port returns invalid result in decision mode', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => ({ invalid: true })),
    } as any, {
      event: 'pre_tool_use',
      invocation_id: 'inv7',
      idempotency_key: 'idem7',
      scope: makeScope(),
      payload: { tool_name: 'read_file' },
    }, { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns continue with invalid_hook_observation when port returns invalid result in observational mode', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => ({ invalid: true })),
    } as any, {
      event: 'post_turn',
      invocation_id: 'inv8',
      idempotency_key: 'idem8',
      scope: makeScope(),
      payload: { iteration: 1 },
    }, { mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('invalid_hook_observation');
  });

  it('returns continue in observational mode when port returns valid result with modified payload', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => ({
        event: 'post_turn',
        action: 'continue',
        payload: { modified: true },
        follow_ups: [],
        replayed: false,
      })),
    } as any, {
      event: 'post_turn',
      invocation_id: 'inv9',
      idempotency_key: 'idem9',
      scope: makeScope(),
      payload: { iteration: 1 },
    }, { mode: 'observational' });
    expect(result.action).toBe('continue');
    // Observational mode ignores payload modifications and returns original
    expect(result.payload).toEqual({ iteration: 1 });
  });

  it('returns deny when decision mode port modifies payload that fails attenuation', async () => {
    const origPayload = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '50' }] };
    const modifiedPayload = { goal: 'g', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: modifiedPayload,
        follow_ups: [],
        replayed: false,
      })),
    } as any, {
      event: 'user_prompt_submit',
      invocation_id: 'inv10',
      idempotency_key: 'idem10',
      scope: makeScope(),
      payload: origPayload,
    }, { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
  });

  it('returns deny when port throws error in decision mode', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => { throw new Error('port error'); }),
    } as any, {
      event: 'pre_tool_use',
      invocation_id: 'inv11',
      idempotency_key: 'idem11',
      scope: makeScope(),
      payload: { tool_name: 'read_file' },
    }, { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_failed');
  });

  it('returns continue when port throws error in observational mode', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => { throw new Error('port error'); }),
    } as any, {
      event: 'post_turn',
      invocation_id: 'inv12',
      idempotency_key: 'idem12',
      scope: makeScope(),
      payload: { iteration: 1 },
    }, { mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_failed');
  });

  it('returns deny when port times out in decision mode', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async (req: { signal: AbortSignal }) => {
        return new Promise(() => { /* never resolves */ });
      }),
    } as any, {
      event: 'pre_tool_use',
      invocation_id: 'inv13',
      idempotency_key: 'idem13',
      scope: makeScope(),
      payload: { tool_name: 'read_file' },
    }, { mode: 'decision', timeout_ms: 50 });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_timeout');
  });

  it('returns continue when port times out in observational mode', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => new Promise(() => { /* never resolves */ })),
    } as any, {
      event: 'post_turn',
      invocation_id: 'inv14',
      idempotency_key: 'idem14',
      scope: makeScope(),
      payload: { iteration: 1 },
    }, { mode: 'observational', timeout_ms: 50 });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_timeout');
  });

  it('returns deny when port returns deny action with reason_code in decision mode', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => ({
        event: 'pre_tool_use',
        action: 'deny',
        payload: { tool_name: 'read_file' },
        reason_code: 'tool_blocked',
        follow_ups: [],
        replayed: false,
      })),
    } as any, {
      event: 'pre_tool_use',
      invocation_id: 'inv15',
      idempotency_key: 'idem15',
      scope: makeScope(),
      payload: { tool_name: 'read_file' },
    }, { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('tool_blocked');
  });

  it('returns force_prompt when port returns force_prompt action', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'force_prompt',
        payload: { goal: 'g', success_criteria: [], constraints: [] },
        reason_code: 'needs_approval',
        follow_ups: [],
        replayed: false,
      })),
    } as any, {
      event: 'user_prompt_submit',
      invocation_id: 'inv16',
      idempotency_key: 'idem16',
      scope: makeScope(),
      payload: { goal: 'g', success_criteria: [], constraints: [] },
    }, { mode: 'decision' });
    expect(result.action).toBe('force_prompt');
    expect(result.reason_code).toBe('needs_approval');
  });

  it('returns skip when port returns skip action', async () => {
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => ({
        event: 'pre_tool_use',
        action: 'skip',
        payload: { tool_name: 'read_file' },
        reason_code: 'skip_tool',
        follow_ups: [],
        replayed: false,
      })),
    } as any, {
      event: 'pre_tool_use',
      invocation_id: 'inv17',
      idempotency_key: 'idem17',
      scope: makeScope(),
      payload: { tool_name: 'read_file' },
    }, { mode: 'decision' });
    expect(result.action).toBe('skip');
    expect(result.reason_code).toBe('skip_tool');
  });

  it('returns continue with original payload when port returns same payload in decision mode', async () => {
    const origPayload = { tool_name: 'read_file', args: { path: '/workspace/test.txt' } };
    const result = await dispatchHookBoundary({
      dispatch: vi.fn(async () => ({
        event: 'pre_tool_use',
        action: 'continue',
        payload: origPayload,
        follow_ups: [],
        replayed: false,
      })),
    } as any, {
      event: 'pre_tool_use',
      invocation_id: 'inv18',
      idempotency_key: 'idem18',
      scope: makeScope(),
      payload: origPayload,
    }, { mode: 'decision' });
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual(origPayload);
  });

  it('freezes the returned outcome object', async () => {
    const result = await dispatchHookBoundary(undefined, {
      event: 'pre_turn',
      invocation_id: 'inv19',
      idempotency_key: 'idem19',
      scope: makeScope(),
      payload: { messages: [] },
    }, { mode: 'decision' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload)).toBe(true);
  });
});

// ---- pre_turn and session_before_compact: sameJson check (L451-456) ----
describe('hook-port-survival-6: sameJson events', () => {
  it('allows pre_turn with same payload', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { messages: [{ role: 'user', content: 'hi' }] },
      candidate_payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects pre_turn with different payload', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { messages: [{ role: 'user', content: 'hi' }] },
      candidate_payload: { messages: [{ role: 'user', content: 'modified' }] },
    });
    expect(result.allowed).toBe(false);
  });

  it('allows session_before_compact with same payload', () => {
    const payload = { context_size: 50000 };
    const result = policy.validate({
      event: 'session_before_compact',
      scope: makeScope(),
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects session_before_compact with different payload', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope: makeScope(),
      original_payload: { context_size: 50000 },
      candidate_payload: { context_size: 100000 },
    });
    expect(result.allowed).toBe(false);
  });
});

// ---- pre_tool_use always allowed (L447) ----
describe('hook-port-survival-6: pre_tool_use always allowed', () => {
  it('allows pre_tool_use with any payload modification', () => {
    const result = policy.validate({
      event: 'pre_tool_use',
      scope: makeScope(),
      original_payload: { tool_name: 'read_file' },
      candidate_payload: { tool_name: 'write_file', args: { path: '/workspace/hack.txt' } },
    });
    expect(result.allowed).toBe(true);
  });
});

// ---- unknown events return false (L457) ----
describe('hook-port-survival-6: unknown event types', () => {
  it('rejects unknown event type', () => {
    const result = policy.validate({
      event: 'unknown_event' as any,
      scope: makeScope(),
      original_payload: {},
      candidate_payload: {},
    });
    expect(result.allowed).toBe(false);
    expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
  });
});
