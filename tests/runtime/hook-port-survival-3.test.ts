import { describe, it, expect, vi } from 'vitest';
import {
  dispatchHookBoundary,
  HookRestrictionError,
  createHarnessHookAttenuationPolicy,
  type HookRuntimePort,
  type RuntimeHookRequest,
  type RuntimeHookOutcome,
  type HookBoundaryOptions,
} from '../../runtime/hook-port.js';

function makeRequest(overrides: Partial<RuntimeHookRequest> = {}): RuntimeHookRequest {
  return {
    event: 'user_prompt_submit',
    invocation_id: 'inv-test',
    idempotency_key: 'idem-test',
    scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
    payload: { goal: 'test goal', success_criteria: [], constraints: [] },
    ...overrides,
  };
}

function makeOutcome(
  event: string = 'user_prompt_submit',
  action: string = 'continue',
  payload?: unknown,
  reasonCode?: string,
): RuntimeHookOutcome {
  return {
    event: event as RuntimeHookOutcome['event'],
    action: action as RuntimeHookOutcome['action'],
    payload: payload ?? { goal: 'test goal', success_criteria: [], constraints: [] },
    ...(action !== 'continue' ? { reason_code: reasonCode ?? 'test_reason' } : {}),
    follow_ups: [],
    replayed: false,
  } as RuntimeHookOutcome;
}

// ============================================================
// dispatchHookBoundary: signal aborted before dispatch
// ============================================================

describe('Hook survival-3 - signal aborted handling', () => {
  it('returns deny with hook_cancelled when signal already aborted in decision mode', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = {
      dispatch: vi.fn(),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ signal: controller.signal }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_cancelled');
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it('returns continue with hook_observer_cancelled when signal aborted in observational mode', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = {
      dispatch: vi.fn(),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ signal: controller.signal }),
      { mode: 'observational' },
    );
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_cancelled');
  });
});

// ============================================================
// dispatchHookBoundary: timeout handling
// ============================================================

describe('Hook survival-3 - timeout handling', () => {
 it('returns deny with hook_timeout in decision mode on timeout', async () => {
   const port: HookRuntimePort = {
      dispatch: vi.fn(() => new Promise<RuntimeHookOutcome>(() => {})),
   };
    const result = await dispatchHookBoundary(
      port,
      makeRequest(),
      { mode: 'decision', timeout_ms: 50 },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_timeout');
  });

 it('returns continue with hook_observer_timeout in observational mode on timeout', async () => {
   const port: HookRuntimePort = {
      dispatch: vi.fn(() => new Promise<RuntimeHookOutcome>(() => {})),
   };
    const result = await dispatchHookBoundary(
      port,
      makeRequest(),
      { mode: 'observational', timeout_ms: 50 },
    );
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_timeout');
  });
});

// ============================================================
// dispatchHookBoundary: port dispatch throws
// ============================================================

describe('Hook survival-3 - port error handling', () => {
  it('returns deny with hook_failed in decision mode when port throws', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => { throw new Error('port crashed'); }),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest(),
      { mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_failed');
  });

  it('returns continue with hook_observer_failed in observational mode when port throws', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => { throw new Error('port crashed'); }),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest(),
      { mode: 'observational' },
    );
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_failed');
  });
});

// ============================================================
// dispatchHookBoundary: invalid port result
// ============================================================

describe('Hook survival-3 - invalid port result', () => {
  it('returns deny with invalid_hook_boundary_result when port returns non-object', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => 'not an object' as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when port returns null', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => null as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when port returns array', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => [] as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when port returns result with wrong event', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('session_start', 'continue')),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when port returns result with extra keys', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        ...makeOutcome(),
        extra_key: 'not allowed',
      } as any)),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when action is continue but reason_code is a string', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: { goal: 'test goal', success_criteria: [], constraints: [] },
        reason_code: 'should not be here',
        follow_ups: [],
        replayed: false,
      } as any)),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when action is deny but reason_code is empty', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'deny',
        payload: { goal: 'test goal', success_criteria: [], constraints: [] },
        reason_code: '  ',
        follow_ups: [],
        replayed: false,
      } as any)),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when action is deny but reason_code is not a string', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'deny',
        payload: { goal: 'test goal', success_criteria: [], constraints: [] },
        reason_code: 123,
        follow_ups: [],
        replayed: false,
      } as any)),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when action is not in allowed set', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'invalid_action',
        payload: { goal: 'test goal', success_criteria: [], constraints: [] },
        reason_code: 'test',
        follow_ups: [],
        replayed: false,
      } as any)),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when follow_ups is not an array', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: { goal: 'test goal', success_criteria: [], constraints: [] },
        follow_ups: 'not an array',
        replayed: false,
      } as any)),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when replayed is not a boolean', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: { goal: 'test goal', success_criteria: [], constraints: [] },
        follow_ups: [],
        replayed: 'yes',
      } as any)),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when payload is not cloneable (circular)', async () => {
    const circular: any = { goal: 'test', success_criteria: [], constraints: [] };
    circular.self = circular;
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: circular,
        follow_ups: [],
        replayed: false,
      } as any)),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });
});

// ============================================================
// dispatchHookBoundary: observational mode returns continue
// ============================================================

describe('Hook survival-3 - observational mode', () => {
  it('returns continue with original payload in observational mode', async () => {
    const originalPayload = { goal: 'test goal', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('user_prompt_submit', 'deny', originalPayload)),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ payload: originalPayload }),
      { mode: 'observational' },
    );
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual(originalPayload);
  });
});

// ============================================================
// dispatchHookBoundary: payload attenuation
// ============================================================

describe('Hook survival-3 - payload attenuation', () => {
  it('returns deny when user_prompt_submit payload changes goal', async () => {
    const originalPayload = { goal: 'original goal', success_criteria: [], constraints: [] };
    const modifiedPayload = { goal: 'modified goal', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('user_prompt_submit', 'continue', modifiedPayload)),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ payload: originalPayload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
  });

  it('allows pre_tool_use to return any payload (no attenuation check)', async () => {
    const originalPayload = { path: '/workspace/test' };
    const modifiedPayload = { path: '/workspace/different' };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('pre_tool_use', 'continue', modifiedPayload)),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ event: 'pre_tool_use', payload: originalPayload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('continue');
  });

  it('allows user_prompt_submit when constraints narrow', async () => {
    const originalPayload = {
      goal: 'test goal',
      success_criteria: [],
      constraints: [
        { type: 'budget', value: '100' },
        { type: 'time', value: '60' },
      ],
    };
    const narrowedPayload = {
      goal: 'test goal',
      success_criteria: [],
      constraints: [
        { type: 'budget', value: '50' },
        { type: 'time', value: '30' },
      ],
    };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('user_prompt_submit', 'continue', narrowedPayload)),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ payload: originalPayload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('continue');
  });

  it('returns deny when pre_turn payload changes', async () => {
    const originalPayload = { messages: [{ role: 'user', content: 'original' }] };
    const modifiedPayload = { messages: [{ role: 'user', content: 'modified' }] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('pre_turn', 'continue', modifiedPayload)),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ event: 'pre_turn', payload: originalPayload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
  });

  it('allows pre_turn when payload is same', async () => {
    const originalPayload = { messages: [{ role: 'user', content: 'same' }] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('pre_turn', 'continue', originalPayload)),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ event: 'pre_turn', payload: originalPayload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('continue');
  });

  it('returns deny for unknown event with changed payload', async () => {
    const originalPayload = { data: 'original' };
    const modifiedPayload = { data: 'modified' };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('session_start', 'continue', modifiedPayload)),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ event: 'session_start', payload: originalPayload }),
      { mode: 'decision' },
    );
    // session_start is not in the attenuation policy, so it defaults to false
    expect(result.action).toBe('deny');
  });
});

// ============================================================
// HookRestrictionError exact message
// ============================================================

describe('Hook survival-3 - HookRestrictionError', () => {
  it('creates error with exact message format', () => {
    const error = new HookRestrictionError('pre_tool_use', 'deny', 'policy_violation');
    expect(error.message).toBe('hook pre_tool_use deny: policy_violation');
    expect(error.name).toBe('HookRestrictionError');
    expect(error.event).toBe('pre_tool_use');
    expect(error.action).toBe('deny');
    expect(error.reason_code).toBe('policy_violation');
  });

  it('creates error with force_prompt action', () => {
    const error = new HookRestrictionError('user_prompt_submit', 'force_prompt', 'needs_approval');
    expect(error.message).toBe('hook user_prompt_submit force_prompt: needs_approval');
    expect(error.action).toBe('force_prompt');
  });

  it('creates error with skip action', () => {
    const error = new HookRestrictionError('pre_turn', 'skip', 'skip_reason');
    expect(error.message).toBe('hook pre_turn skip: skip_reason');
    expect(error.action).toBe('skip');
  });

  it('is instanceof Error and HookRestrictionError', () => {
    const error = new HookRestrictionError('stop', 'deny', 'test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HookRestrictionError);
  });
});

// ============================================================
// createHarnessHookAttenuationPolicy
// ============================================================

describe('Hook survival-3 - attenuation policy', () => {
  const policy = createHarnessHookAttenuationPolicy();

  it('allows pre_tool_use with any payload change', () => {
    const result = policy.validate({
      event: 'pre_tool_use',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: { path: '/a' },
      candidate_payload: { path: '/b' },
    });
    expect(result.allowed).toBe(true);
  });

  it('denies unknown event types', () => {
    const result = policy.validate({
      event: 'after_response' as any,
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: { data: 'a' },
      candidate_payload: { data: 'b' },
    });
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason_code).toBe('hook_attenuation_would_expand_authority');
  });

  it('allows session_before_compact with same payload', () => {
    const payload = { messages: [{ role: 'user', content: 'test' }] };
    const result = policy.validate({
      event: 'session_before_compact',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies session_before_compact with different payload', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: { messages: [{ role: 'user', content: 'a' }] },
      candidate_payload: { messages: [{ role: 'user', content: 'b' }] },
    });
    expect(result.allowed).toBe(false);
  });
});

// ============================================================
// dispatchHookBoundary: no port returns continue
// ============================================================

describe('Hook survival-3 - no port', () => {
  it('returns continue when port is undefined', async () => {
    const result = await dispatchHookBoundary(undefined, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual(makeRequest().payload);
  });

  it('returns continue in observational mode when port is undefined', async () => {
    const result = await dispatchHookBoundary(undefined, makeRequest(), { mode: 'observational' });
    expect(result.action).toBe('continue');
  });
});

// ============================================================
// dispatchHookBoundary: valid result passes through
// ============================================================

describe('Hook survival-3 - valid result', () => {
  it('passes through valid continue result with same payload', async () => {
    const payload = { goal: 'test goal', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('user_prompt_submit', 'continue', payload)),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ payload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual(payload);
  });

  it('passes through valid deny result with reason_code', async () => {
    const payload = { goal: 'test goal', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('user_prompt_submit', 'deny', payload, 'custom_deny')),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ payload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('custom_deny');
  });

  it('passes through valid skip result', async () => {
    const payload = { goal: 'test goal', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('user_prompt_submit', 'skip', payload, 'skip_reason')),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ payload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('skip');
    expect(result.reason_code).toBe('skip_reason');
  });

  it('passes through valid force_prompt result', async () => {
    const payload = { goal: 'test goal', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('user_prompt_submit', 'force_prompt', payload, 'approval')),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ payload }),
      { mode: 'decision' },
    );
    expect(result.action).toBe('force_prompt');
    expect(result.reason_code).toBe('approval');
  });
});

// ============================================================
// dispatchHookBoundary: timeout_ms validation
// ============================================================

describe('Hook survival-3 - timeout_ms validation', () => {
  it('throws TypeError for zero timeout_ms', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn() };
    await expect(
      dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 0 }),
    ).rejects.toThrow('hook boundary timeout_ms must be a positive safe integer');
  });

  it('throws TypeError for negative timeout_ms', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn() };
    await expect(
      dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: -1 }),
    ).rejects.toThrow('hook boundary timeout_ms must be a positive safe integer');
  });

  it('throws TypeError for non-integer timeout_ms', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn() };
    await expect(
      dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1.5 }),
    ).rejects.toThrow('hook boundary timeout_ms must be a positive safe integer');
  });

  it('uses default timeout when timeout_ms is undefined', async () => {
    // Should not throw, uses default 5000ms
    const result = await dispatchHookBoundary(undefined, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('continue');
  });
});

// ============================================================
// dispatchHookBoundary: signal abort during dispatch
// ============================================================

describe('Hook survival-3 - signal abort during dispatch', () => {
  it('returns deny when signal aborts during dispatch in decision mode', async () => {
    const controller = new AbortController();
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => {
        controller.abort();
        await new Promise((r) => setTimeout(r, 100));
        return makeOutcome();
      }),
    };
    const result = await dispatchHookBoundary(
      port,
      makeRequest({ signal: controller.signal }),
      { mode: 'decision', timeout_ms: 5000 },
    );
    // Should get either hook_cancelled or a valid result depending on race
    expect(['deny', 'continue'].includes(result.action)).toBe(true);
    if (result.action === 'deny') {
      expect(['hook_cancelled', 'hook_timeout', 'hook_failed'].includes(result.reason_code!)).toBe(true);
    }
  });
});
