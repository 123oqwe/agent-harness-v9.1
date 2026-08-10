import { describe, expect, it } from 'vitest';

// These tests target the internal helper functions in hook-port.ts
// by exercising them through the exported createHarnessHookAttenuationPolicy
// and dispatchHookBoundary functions, which call these helpers internally.

import { createHarnessHookAttenuationPolicy, dispatchHookBoundary, type HookRuntimePort } from '../../runtime/hook-port.js';

const policy = createHarnessHookAttenuationPolicy();
const scope = { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' };

describe('hook-port helpers: isRecord and cloneJson via attenuation', () => {
  it('rejects array payload for user_prompt_submit (isRecord check)', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: [1, 2],
      candidate_payload: [1, 2],
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects null payload for user_prompt_submit (isRecord check)', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: null,
      candidate_payload: null,
    });
    expect(result.allowed).toBe(false);
  });
});

describe('hook-port helpers: stringArray via attenuation', () => {
  const baseReq = {
    registry_snapshot_hash: 'abc',
    estimated_input_tokens: 100,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    request: { model: 'm', messages: [], tools: [], max_tokens: 100 },
    data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
    policy: { denied_provider_ids: [], allowed_provider_ids: [] },
    run_plan: { run_id: 'r1', required_capabilities: [], allowed_provider_ids: [] },
  };

  it('rejects when required_capabilities contains non-string entries', () => {
    const badReq = { ...baseReq, required_capabilities: ['text_reasoning', 123] };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseReq,
      candidate_payload: { ...baseReq, required_capabilities: ['text_reasoning', 123] },
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when required_capabilities is not an array', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseReq,
      candidate_payload: { ...baseReq, required_capabilities: 'text_reasoning' },
    });
    expect(result.allowed).toBe(false);
  });

  it('allows when candidate has more required_capabilities (superset)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseReq,
      candidate_payload: { ...baseReq, required_capabilities: ['text_reasoning', 'tool_calling'] },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when candidate has fewer required_capabilities (not superset)', () => {
    const narrowerReq = { ...baseReq, required_capabilities: ['text_reasoning', 'tool_calling'] };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: narrowerReq,
      candidate_payload: baseReq,
    });
    expect(result.allowed).toBe(false);
  });
});

describe('hook-port helpers: subset and superset via data_policy', () => {
  const baseReq = {
    registry_snapshot_hash: 'abc',
    estimated_input_tokens: 100,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    request: { model: 'm', messages: [], tools: [], max_tokens: 100 },
    data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false },
    policy: { denied_provider_ids: [], allowed_provider_ids: [] },
    run_plan: { run_id: 'r1', required_capabilities: [], allowed_provider_ids: [] },
  };

  it('allows narrowed allowed_regions (subset)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseReq,
      candidate_payload: { ...baseReq, data_policy: { ...baseReq.data_policy, allowed_regions: ['us'] } },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded allowed_regions (not subset)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: { ...baseReq, data_policy: { ...baseReq.data_policy, allowed_regions: ['us'] } },
      candidate_payload: baseReq,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when allowed_regions contains non-string entries', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseReq,
      candidate_payload: { ...baseReq, data_policy: { ...baseReq.data_policy, allowed_regions: ['us', 123] } },
    });
    expect(result.allowed).toBe(false);
  });
});

describe('hook-port helpers: constraintsNarrow edge cases', () => {
  const baseContract = {
    goal: 'test',
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints: [],
  };

  it('rejects when constraints are not arrays', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: 'not-array' },
      candidate_payload: { ...baseContract, constraints: 'not-array' },
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when constraint has invalid type', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'invalid', value: '100' }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'invalid', value: '100' }] },
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when constraint value is not a string', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'budget', value: 100 }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'budget', value: 100 }] },
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when constraint entry is not a record', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: ['not-record'] },
      candidate_payload: { ...baseContract, constraints: ['not-record'] },
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed time constraint (lower value)', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'time', value: '100' }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'time', value: '50' }] },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded time constraint (higher value)', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'time', value: '50' }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'time', value: '100' }] },
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed risk_ceiling constraint (lower value)', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'risk_ceiling', value: '10' }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'risk_ceiling', value: '5' }] },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when risk_ceiling is higher in candidate', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'risk_ceiling', value: '5' }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'risk_ceiling', value: '10' }] },
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when constraint type differs between original and candidate', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'budget', value: '100' }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'time', value: '100' }] },
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate constraint has same type but different value for privacy', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'privacy', value: 'high' }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'privacy', value: 'low' }] },
    });
    expect(result.allowed).toBe(false);
  });
});

describe('hook-port helpers: allowedSetNarrows', () => {
  const baseReq = {
    registry_snapshot_hash: 'abc',
    estimated_input_tokens: 100,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    request: { model: 'm', messages: [], tools: [], max_tokens: 100 },
    data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
    policy: { denied_provider_ids: [], allowed_provider_ids: ['p1', 'p2'] },
    run_plan: { run_id: 'r1', required_capabilities: [], allowed_provider_ids: ['p1', 'p2'] },
  };

  it('allows narrowed allowed_provider_ids (subset)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseReq,
      candidate_payload: { ...baseReq, policy: { ...baseReq.policy, allowed_provider_ids: ['p1'] }, run_plan: { ...baseReq.run_plan, allowed_provider_ids: ['p1'] } },
    });
    expect(result.allowed).toBe(true);
  });

  it('allows expanded denied_provider_ids (superset)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: { ...baseReq, policy: { ...baseReq.policy, denied_provider_ids: ['p1'] } },
      candidate_payload: { ...baseReq, policy: { ...baseReq.policy, denied_provider_ids: ['p1', 'p2'] } },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects narrowed denied_provider_ids (not superset)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: { ...baseReq, policy: { ...baseReq.policy, denied_provider_ids: ['p1', 'p2'] } },
      candidate_payload: { ...baseReq, policy: { ...baseReq.policy, denied_provider_ids: ['p1'] } },
    });
    expect(result.allowed).toBe(false);
  });
});

describe('hook-port helpers: dispatchHookBoundary edge cases', () => {
  it('returns continue when port is undefined', async () => {
    const result = await dispatchHookBoundary(
      undefined,
      { event: 'pre_turn', invocation_id: 'i1', idempotency_key: 'k1', scope, payload: { test: true } },
      { timeout_ms: 5000, mode: 'decision' },
    );
    expect(result.action).toBe('continue');
  });

  it('returns deny on timeout', async () => {
    const slowPort: HookRuntimePort = {
      dispatch: () => new Promise(() => {}), // never resolves
    };
    const result = await dispatchHookBoundary(
      slowPort,
      { event: 'pre_turn', invocation_id: 'i2', idempotency_key: 'k2', scope, payload: {} },
      { timeout_ms: 100, mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_timeout');
  });

  it('returns continue on timeout in observational mode', async () => {
    const slowPort: HookRuntimePort = {
      dispatch: () => new Promise(() => {}), // never resolves
    };
    const result = await dispatchHookBoundary(
      slowPort,
      { event: 'pre_turn', invocation_id: 'i3', idempotency_key: 'k3', scope, payload: {} },
      { timeout_ms: 100, mode: 'observational' },
    );
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_timeout');
  });

  it('returns deny when port throws', async () => {
    const errorPort: HookRuntimePort = {
      dispatch: () => Promise.reject(new Error('boom')),
    };
    const result = await dispatchHookBoundary(
      errorPort,
      { event: 'pre_turn', invocation_id: 'i4', idempotency_key: 'k4', scope, payload: {} },
      { timeout_ms: 5000, mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_failed');
  });

  it('returns continue when port throws in observational mode', async () => {
    const errorPort: HookRuntimePort = {
      dispatch: () => Promise.reject(new Error('boom')),
    };
    const result = await dispatchHookBoundary(
      errorPort,
      { event: 'pre_turn', invocation_id: 'i5', idempotency_key: 'k5', scope, payload: {} },
      { timeout_ms: 5000, mode: 'observational' },
    );
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_failed');
  });

  it('returns deny when port returns invalid result (missing fields)', async () => {
    const badPort: HookRuntimePort = {
      dispatch: () => Promise.resolve({} as any),
    };
    const result = await dispatchHookBoundary(
      badPort,
      { event: 'pre_turn', invocation_id: 'i6', idempotency_key: 'k6', scope, payload: {} },
      { timeout_ms: 5000, mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns continue when port returns valid result with action continue', async () => {
    const goodPort: HookRuntimePort = {
      dispatch: (req: any) => Promise.resolve({
        event: req.event,
        action: 'continue',
        payload: req.payload,
        reason_code: undefined as any,
        follow_ups: [],
        replayed: false,
      }),
    };
    const result = await dispatchHookBoundary(
      goodPort,
      { event: 'pre_turn', invocation_id: 'i7', idempotency_key: 'k7', scope, payload: { test: true } },
      { timeout_ms: 5000, mode: 'decision' },
    );
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ test: true });
  });

  it('returns deny when port returns action deny', async () => {
    const denyPort: HookRuntimePort = {
      dispatch: (req: any) => Promise.resolve({
        event: req.event,
        action: 'deny',
        payload: req.payload,
        reason_code: 'test_deny',
        follow_ups: [],
        replayed: false,
      }),
    };
    const result = await dispatchHookBoundary(
      denyPort,
      { event: 'pre_turn', invocation_id: 'i8', idempotency_key: 'k8', scope, payload: {} },
      { timeout_ms: 5000, mode: 'decision' },
    );
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('test_deny');
  });

  it('throws TypeError for invalid timeout_ms', async () => {
    const port: HookRuntimePort = { dispatch: () => Promise.resolve({} as any) };
    await expect(
      dispatchHookBoundary(
        port,
        { event: 'pre_turn', invocation_id: 'i9', idempotency_key: 'k9', scope, payload: {} },
        { timeout_ms: 0.5, mode: 'decision' },
      ),
    ).rejects.toThrow('hook boundary timeout_ms must be a positive safe integer');
  });

  it('throws TypeError for negative timeout_ms', async () => {
    const port: HookRuntimePort = { dispatch: () => Promise.resolve({} as any) };
    await expect(
      dispatchHookBoundary(
        port,
        { event: 'pre_turn', invocation_id: 'i10', idempotency_key: 'k10', scope, payload: {} },
        { timeout_ms: -100, mode: 'decision' },
      ),
    ).rejects.toThrow('hook boundary timeout_ms must be a positive safe integer');
  });
});
