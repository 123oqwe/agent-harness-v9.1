import { describe, it, expect, vi } from 'vitest';
import {
  dispatchHookBoundary,
  HookRestrictionError,
  type HookRuntimePort,
  type RuntimeHookRequest,
  type RuntimeHookOutcome,
  type HookBoundaryOptions,
} from '../../runtime/hook-port.js';

function makeRequest(overrides: Partial<RuntimeHookRequest> = {}): RuntimeHookRequest {
  return {
    event: 'user_prompt_submit',
    invocation_id: 'inv-1',
    idempotency_key: 'idem-1',
    scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
    payload: { goal: 'test goal', success_criteria: [], constraints: [] },
    ...overrides,
  };
}

function makeOutcome(action: string = 'continue', payload?: unknown): RuntimeHookOutcome {
  return {
    event: 'user_prompt_submit',
    action: action as RuntimeHookOutcome['action'],
    payload: payload ?? { goal: 'test goal', success_criteria: [], constraints: [] },
    ...(action !== 'continue' ? { reason_code: 'test_reason' } : {}),
    follow_ups: [],
    replayed: false,
  } as RuntimeHookOutcome;
}

// ============================================================
// dispatchHookBoundary: no port (undefined)
// ============================================================

describe('dispatchHookBoundary - no port', () => {
  it('returns continue when port is undefined', async () => {
    const result = await dispatchHookBoundary(undefined, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('continue');
  });

  it('returns continue in observational mode when port is undefined', async () => {
    const result = await dispatchHookBoundary(undefined, makeRequest(), { mode: 'observational' });
    expect(result.action).toBe('continue');
  });
});

// ============================================================
// dispatchHookBoundary: timeout
// ============================================================

describe('dispatchHookBoundary - timeout', () => {
  it('returns deny on timeout in decision mode', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 200));
        return makeOutcome();
      }),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 50 });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_timeout');
  });

  it('returns continue on timeout in observational mode', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 200));
        return makeOutcome();
      }),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational', timeout_ms: 50 });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_timeout');
  });

  it('uses default timeout of 5000ms when timeout_ms is undefined', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome()),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('continue');
  });
});

// ============================================================
// dispatchHookBoundary: signal cancellation
// ============================================================

describe('dispatchHookBoundary - signal cancellation', () => {
  it('returns deny when signal is already aborted in decision mode', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = { dispatch: vi.fn(async () => makeOutcome()) };
    const result = await dispatchHookBoundary(port, makeRequest({ signal: controller.signal }), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_cancelled');
  });

  it('returns continue when signal is already aborted in observational mode', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = { dispatch: vi.fn(async () => makeOutcome()) };
    const result = await dispatchHookBoundary(port, makeRequest({ signal: controller.signal }), { mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_cancelled');
  });

  it('returns deny when signal aborts during dispatch in decision mode', async () => {
    const controller = new AbortController();
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => {
        setTimeout(() => controller.abort(), 10);
        await new Promise(r => setTimeout(r, 200));
        return makeOutcome();
      }),
    };
    const result = await dispatchHookBoundary(port, makeRequest({ signal: controller.signal }), { mode: 'decision', timeout_ms: 5000 });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_cancelled');
  });
});

// ============================================================
// dispatchHookBoundary: port throws error
// ============================================================

describe('dispatchHookBoundary - port error', () => {
  it('returns deny when port throws in decision mode', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => { throw new Error('port crashed'); }),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_failed');
  });

  it('returns continue when port throws in observational mode', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => { throw new Error('port crashed'); }),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_failed');
  });
});

// ============================================================
// dispatchHookBoundary: invalid port result
// ============================================================

describe('dispatchHookBoundary - invalid port result', () => {
  it('returns deny when port returns null in decision mode', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => null as any) };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns continue when port returns null in observational mode', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => null as any) };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('invalid_hook_observation');
  });

  it('returns deny when port returns missing fields', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => ({ action: 'continue' } as any)) };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('returns deny when port returns wrong event', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'stop',
        action: 'continue',
        payload: {},
        follow_ups: [],
        replayed: false,
      }) as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('returns deny when action is continue but reason_code is set', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: {},
        reason_code: 'should_not_be_here',
        follow_ups: [],
        replayed: false,
      }) as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('returns deny when action is deny but reason_code is missing', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'deny',
        payload: {},
        follow_ups: [],
        replayed: false,
      }) as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('returns deny when extra keys are present in result', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: {},
        follow_ups: [],
        replayed: false,
        extra_key: 'not allowed',
      }) as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('returns deny when replayed is not boolean', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: {},
        follow_ups: [],
        replayed: 'yes',
      }) as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('returns deny when follow_ups is not an array', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({
        event: 'user_prompt_submit',
        action: 'continue',
        payload: {},
        follow_ups: 'not array',
        replayed: false,
      }) as any),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
  });
});

// ============================================================
// dispatchHookBoundary: attenuation (payload modification)
// ============================================================

describe('dispatchHookBoundary - attenuation', () => {
  it('allows identical payload in decision mode', async () => {
    const originalPayload = { goal: 'test', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('continue', originalPayload)),
    };
    const result = await dispatchHookBoundary(port, makeRequest({ payload: originalPayload }), { mode: 'decision' });
    expect(result.action).toBe('continue');
  });

  it('allows narrowed budget constraint in decision mode', async () => {
    const originalPayload = { goal: 'test', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const narrowedPayload = { goal: 'test', success_criteria: [], constraints: [{ type: 'budget', value: '50' }] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('continue', narrowedPayload)),
    };
    const result = await dispatchHookBoundary(port, makeRequest({ payload: originalPayload }), { mode: 'decision' });
    expect(result.action).toBe('continue');
  });

  it('denies expanded budget constraint in decision mode', async () => {
    const originalPayload = { goal: 'test', success_criteria: [], constraints: [{ type: 'budget', value: '50' }] };
    const expandedPayload = { goal: 'test', success_criteria: [], constraints: [{ type: 'budget', value: '100' }] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('continue', expandedPayload)),
    };
    const result = await dispatchHookBoundary(port, makeRequest({ payload: originalPayload }), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
  });

  it('denies different goal in decision mode', async () => {
    const originalPayload = { goal: 'original', success_criteria: [], constraints: [] };
    const modifiedPayload = { goal: 'modified', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('continue', modifiedPayload)),
    };
    const result = await dispatchHookBoundary(port, makeRequest({ payload: originalPayload }), { mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('allows payload modification in observational mode (no attenuation check)', async () => {
    const originalPayload = { goal: 'original', success_criteria: [], constraints: [] };
    const modifiedPayload = { goal: 'modified', success_criteria: [], constraints: [] };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => makeOutcome('continue', modifiedPayload)),
    };
    const result = await dispatchHookBoundary(port, makeRequest({ payload: originalPayload }), { mode: 'observational' });
    expect(result.action).toBe('continue');
  });
});

// ============================================================
// dispatchHookBoundary: timeout_ms validation
// ============================================================

describe('dispatchHookBoundary - timeout_ms validation', () => {
  it('throws when timeout_ms is not a safe integer', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => makeOutcome()) };
    await expect(dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1.5 } as any))
      .rejects.toThrow(TypeError);
  });

  it('throws when timeout_ms is zero', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => makeOutcome()) };
    await expect(dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 0 }))
      .rejects.toThrow(TypeError);
  });

  it('throws when timeout_ms is negative', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => makeOutcome()) };
    await expect(dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: -1 }))
      .rejects.toThrow(TypeError);
  });
});

// ============================================================
// dispatchHookBoundary: outcome freezing
// ============================================================

describe('dispatchHookBoundary - outcome freezing', () => {
  it('freezes the returned outcome', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => makeOutcome()) };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload)).toBe(true);
  });

  it('freezes the original payload in no-port case', async () => {
    const result = await dispatchHookBoundary(undefined, makeRequest(), { mode: 'decision' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload)).toBe(true);
  });
});

// ============================================================
// HookRestrictionError
// ============================================================

describe('HookRestrictionError', () => {
  it('creates error with correct properties', () => {
    const error = new HookRestrictionError('user_prompt_submit', 'deny', 'policy_violation');
    expect(error.event).toBe('user_prompt_submit');
    expect(error.action).toBe('deny');
    expect(error.reason_code).toBe('policy_violation');
    expect(error.message).toContain('user_prompt_submit');
    expect(error.message).toContain('deny');
    expect(error.message).toContain('policy_violation');
    expect(error.name).toBe('HookRestrictionError');
  });

  it('is an instance of Error', () => {
    const error = new HookRestrictionError('stop', 'skip', 'blocked');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HookRestrictionError);
  });

  it('preserves prototype chain after construction', () => {
    const error = new HookRestrictionError('pre_turn', 'force_prompt', 'needs_human');
    expect(error instanceof HookRestrictionError).toBe(true);
  });
});
