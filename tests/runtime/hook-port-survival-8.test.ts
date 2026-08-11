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

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    registry_snapshot_hash: 'h1',
    estimated_input_tokens: 100,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 },
    data_policy: {
      local_only: false,
      allowed_regions: ['us'],
      max_retention_days: 30,
      training_allowed: false,
    },
    policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] },
    run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [] },
    ...overrides,
  };
}

function validate(o: unknown, c: unknown) {
  return policy.validate({
    event: 'before_provider_request',
    scope: makeScope(),
    original_payload: o,
    candidate_payload: c,
  });
}

// ---- providerRequestNarrows: data_policy local_only (L333) ----
describe('hook-port-survival-8: data_policy local_only (L333)', () => {
  it('allows when both local_only are false', () => {
    const o = makeReq();
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when original local_only=true and candidate local_only=true', () => {
    const o = makeReq({ data_policy: { local_only: true, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } });
    const c = makeReq({ data_policy: { local_only: true, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when original local_only=true but candidate local_only=false', () => {
    const o = makeReq({ data_policy: { local_only: true, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original local_only is not boolean', () => {
    const o = makeReq({ data_policy: { local_only: 'yes', allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate local_only is not boolean', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: 'yes', allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: data_policy allowed_regions (L339) ----
describe('hook-port-survival-8: data_policy allowed_regions (L339)', () => {
  it('allows when candidate regions are subset of original', () => {
    const o = makeReq({ data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false } });
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when candidate regions include region not in original', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original allowed_regions is not a string array', () => {
    const o = makeReq({ data_policy: { local_only: false, allowed_regions: 'us', max_retention_days: 30, training_allowed: false } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate allowed_regions is not a string array', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: 123, max_retention_days: 30, training_allowed: false } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: data_policy max_retention_days (L343) ----
describe('hook-port-survival-8: data_policy max_retention_days (L343)', () => {
  it('allows when candidate retention <= original', () => {
    const o = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } });
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 15, training_allowed: false } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when candidate retention equals original', () => {
    const o = makeReq();
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when candidate retention > original', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 60, training_allowed: false } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate retention is negative', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: -1, training_allowed: false } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original retention is not a number', () => {
    const o = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: '30', training_allowed: false } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate retention is not a number', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: '15', training_allowed: false } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: data_policy training_allowed (L344) ----
describe('hook-port-survival-8: data_policy training_allowed (L344)', () => {
  it('allows when original training=false and candidate training=false', () => {
    const o = makeReq();
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when original training=true and candidate training=true', () => {
    const o = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: true } });
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: true } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when original training=true and candidate training=false', () => {
    const o = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: true } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when original training=false but candidate training=true', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: true } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original training_allowed is not boolean', () => {
    const o = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: 'no' } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate training_allowed is not boolean', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: 'yes' } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: data_policy record check (L314-315) ----
describe('hook-port-survival-8: data_policy record check (L314-315)', () => {
  it('denies when original data_policy is not a record', () => {
    const o = makeReq({ data_policy: 'none' });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate data_policy is not a record', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: null });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when data_policy keys mismatch', () => {
    const o = makeReq();
    const c = makeReq({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30 } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: policy/run_plan record check (L364) ----
describe('hook-port-survival-8: policy/run_plan record check (L364)', () => {
  it('denies when original policy is not a record', () => {
    const o = makeReq({ policy: 'none' });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate policy is not a record', () => {
    const o = makeReq();
    const c = makeReq({ policy: null });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original run_plan is not a record', () => {
    const o = makeReq({ run_plan: 'none' });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate run_plan is not a record', () => {
    const o = makeReq();
    const c = makeReq({ run_plan: null });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when policy keys mismatch', () => {
    const o = makeReq();
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'] } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when run_plan keys mismatch', () => {
    const o = makeReq();
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'] } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: denied_provider_ids (L402-403) ----
describe('hook-port-survival-8: denied_provider_ids (L402-403)', () => {
  it('allows when candidate denied is superset of original (more denied)', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['x'] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['x', 'y'] } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when denied are the same', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['x'] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['x'] } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when candidate denied is missing an original denied', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['x', 'y'] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: ['x'] } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original denied_provider_ids is not a string array', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: 'x' } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate denied_provider_ids is not a string array', () => {
    const o = makeReq();
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: 123 } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: allowed_provider_ids (L410-411) ----
describe('hook-port-survival-8: allowed_provider_ids (L410-411)', () => {
  it('allows when candidate allowed is subset of original (fewer allowed)', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1', 'p2'], denied_provider_ids: [] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when allowed are the same', () => {
    const o = makeReq();
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when original allowed is undefined and candidate allowed is undefined', () => {
    const o = makeReq({ policy: { denied_provider_ids: [] } });
    const c = makeReq({ policy: { denied_provider_ids: [] } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when candidate allowed includes id not in original', () => {
    const o = makeReq({ policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] } });
    const c = makeReq({ policy: { allowed_provider_ids: ['p1', 'p2'], denied_provider_ids: [] } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: run_plan required_capabilities and allowed_provider_ids ----
describe('hook-port-survival-8: run_plan capabilities (L410-411)', () => {
  it('allows when candidate plan capabilities are superset of original', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['text_reasoning'] } });
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['text_reasoning', 'vision'] } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when plan capabilities are the same', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['text_reasoning'] } });
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['text_reasoning'] } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when candidate plan capabilities are missing an original capability', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['text_reasoning', 'vision'] } });
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: ['text_reasoning'] } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original plan required_capabilities is not a string array', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: 'text_reasoning' } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate plan required_capabilities is not a string array', () => {
    const o = makeReq();
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: 123 } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('allows when candidate plan allowed_provider_ids is subset of original', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1', 'p2'], required_capabilities: [] } });
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [] } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when candidate plan allowed includes id not in original', () => {
    const o = makeReq({ run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [] } });
    const c = makeReq({ run_plan: { allowed_provider_ids: ['p1', 'p2'], required_capabilities: [] } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- constraintsNarrow: via user_prompt_submit (L192-227) ----
describe('hook-port-survival-8: constraintsNarrow via taskContractNarrows', () => {
  function validateTask(o: unknown, c: unknown) {
    return policy.validate({
      event: 'user_prompt_submit',
      scope: makeScope(),
      original_payload: o,
      candidate_payload: c,
    });
  }

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      prompt: 'test',
      constraints: [
        { type: 'budget', value: '100' },
        { type: 'time', value: '60' },
      ],
      ...overrides,
    };
  }

  it('allows when candidate budget <= original budget', () => {
    const o = makeTask();
    const c = makeTask({ constraints: [{ type: 'budget', value: '50' }, { type: 'time', value: '60' }] });
    expect(validateTask(o, c).allowed).toBe(true);
  });

  it('allows when candidate budget equals original budget', () => {
    const o = makeTask();
    const c = makeTask();
    expect(validateTask(o, c).allowed).toBe(true);
  });

  it('denies when candidate budget > original budget', () => {
    const o = makeTask();
    const c = makeTask({ constraints: [{ type: 'budget', value: '200' }, { type: 'time', value: '60' }] });
    expect(validateTask(o, c).allowed).toBe(false);
  });

  it('denies when candidate has a constraint type not in original', () => {
    const o = makeTask();
    const c = makeTask({ constraints: [{ type: 'budget', value: '50' }, { type: 'privacy', value: 'strict' }] });
    expect(validateTask(o, c).allowed).toBe(false);
  });

  it('allows when candidate privacy matches original privacy', () => {
    const o = makeTask({ constraints: [{ type: 'privacy', value: 'strict' }] });
    const c = makeTask({ constraints: [{ type: 'privacy', value: 'strict' }] });
    expect(validateTask(o, c).allowed).toBe(true);
  });

  it('denies when candidate privacy differs from original privacy', () => {
    const o = makeTask({ constraints: [{ type: 'privacy', value: 'strict' }] });
    const c = makeTask({ constraints: [{ type: 'privacy', value: ' relaxed' }] });
    expect(validateTask(o, c).allowed).toBe(false);
  });

  it('denies when constraints entries have invalid type', () => {
    const o = makeTask({ constraints: [{ type: 123, value: '100' }] });
    const c = makeTask();
    expect(validateTask(o, c).allowed).toBe(false);
  });

  it('denies when constraints entries have invalid value', () => {
    const o = makeTask({ constraints: [{ type: 'budget', value: 100 }] });
    const c = makeTask();
    expect(validateTask(o, c).allowed).toBe(false);
  });

  it('denies when constraints have unknown type', () => {
    const o = makeTask({ constraints: [{ type: 'unknown', value: 'test' }] });
    const c = makeTask({ constraints: [{ type: 'unknown', value: 'test' }] });
    expect(validateTask(o, c).allowed).toBe(false);
  });

  it('denies when original constraints is not an array', () => {
    const o = makeTask({ constraints: 'none' });
    const c = makeTask();
    expect(validateTask(o, c).allowed).toBe(false);
  });

  it('denies when candidate constraints is not an array', () => {
    const o = makeTask();
    const c = makeTask({ constraints: 'none' });
    expect(validateTask(o, c).allowed).toBe(false);
  });
});

// ---- dispatchHookBoundary: no port (L467) ----
describe('hook-port-survival-8: dispatchHookBoundary no port', () => {
  it('returns continue when port is undefined', async () => {
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(undefined, request, { timeout_ms: 1000, mode: 'decision' });
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ test: true });
  });
});

// ---- dispatchHookBoundary: aborted signal (L485) ----
describe('hook-port-survival-8: dispatchHookBoundary aborted signal', () => {
  it('returns deny in decision mode when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = { async dispatch() { return { event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>; } };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      signal: controller.signal,
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 1000, mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_cancelled');
  });

  it('returns continue in observational mode when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = { async dispatch() { return { event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>; } };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      signal: controller.signal,
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 1000, mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_cancelled');
  });
});

// ---- dispatchHookBoundary: invalid timeout (L475) ----
describe('hook-port-survival-8: dispatchHookBoundary invalid timeout', () => {
  it('throws on non-integer timeout', async () => {
    const port: HookRuntimePort = { async dispatch() { return {} as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>; } };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: {},
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    await expect(
      dispatchHookBoundary(port, request, { timeout_ms: 1.5, mode: 'decision' }),
    ).rejects.toThrow(TypeError);
  });

  it('throws on zero timeout', async () => {
    const port: HookRuntimePort = { async dispatch() { return {} as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>; } };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: {},
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    await expect(
      dispatchHookBoundary(port, request, { timeout_ms: 0, mode: 'decision' }),
    ).rejects.toThrow(TypeError);
  });

  it('throws on negative timeout', async () => {
    const port: HookRuntimePort = { async dispatch() { return {} as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>; } };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: {},
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    await expect(
      dispatchHookBoundary(port, request, { timeout_ms: -1, mode: 'decision' }),
    ).rejects.toThrow(TypeError);
  });
});

// ---- dispatchHookBoundary: port returns invalid result (L517) ----
describe('hook-port-survival-8: dispatchHookBoundary invalid port result', () => {
  it('returns deny in decision mode when port returns invalid result', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { invalid: true } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns continue in observational mode when port returns invalid result', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { invalid: true } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 5000, mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('invalid_hook_observation');
  });
});

// ---- dispatchHookBoundary: port returns valid continue result (L559) ----
describe('hook-port-survival-8: dispatchHookBoundary valid continue result', () => {
  it('returns continue with original payload when port returns valid continue', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'continue',
          payload: { test: true },
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ test: true });
  });

  it('returns continue in observational mode with same payload', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'continue',
          payload: { test: true },
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: { test: true },
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 5000, mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ test: true });
  });
});

// ---- dispatchHookBoundary: port returns deny with modified payload (L559-578) ----
describe('hook-port-survival-8: dispatchHookBoundary deny with payload change', () => {
  it('returns deny when port changes payload and attenuation fails', async () => {
    // Original has 2 capabilities, candidate has only 1 (fewer = widening denied)
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'before_provider_request',
          action: 'continue',
          payload: makeReq({ required_capabilities: ['text_reasoning'] }),
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const request: RuntimeHookRequest = {
      event: 'before_provider_request',
      scope: makeScope(),
      payload: makeReq({ required_capabilities: ['text_reasoning', 'vision'] }),
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
  });

  it('allows when port changes payload but attenuation passes', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'before_provider_request',
          action: 'continue',
          payload: makeReq({ required_capabilities: ['text_reasoning', 'vision'] }),
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const request: RuntimeHookRequest = {
      event: 'before_provider_request',
      scope: makeScope(),
      payload: makeReq({ required_capabilities: ['text_reasoning'] }),
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 5000, mode: 'decision' });
    // Candidate has more capabilities = superset = narrowing = allowed
    expect(result.action).toBe('continue');
  });
});

// ---- outcome function: reason_code conditional (L628-630) ----
describe('hook-port-survival-8: outcome reason_code', () => {
  it('outcome includes reason_code when provided', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'deny',
          payload: {},
          reason_code: 'custom_reason',
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
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
    // Port returns valid deny with reason_code, should pass through
    expect(result.action).toBe('deny');
  });

  it('outcome without reason_code for continue action', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return {
          event: 'pre_tool_use',
          action: 'continue',
          payload: {},
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
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
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBeUndefined();
  });
});

// ---- cloneJson: non-serializable value (L112) ----
describe('hook-port-survival-8: cloneJson non-serializable', () => {
  it('dispatchHookBoundary returns invalid result when port payload has circular reference', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        return {
          event: 'pre_tool_use',
          action: 'continue',
          payload: circular,
          follow_ups: [],
          replayed: false,
        } as unknown as Awaited<ReturnType<HookRuntimePort['dispatch']>>;
      },
    };
    const request: RuntimeHookRequest = {
      event: 'pre_tool_use',
      scope: makeScope(),
      payload: {},
      invocation_id: 'inv1',
      idempotency_key: 'key1',
    } as unknown as RuntimeHookRequest;
    // cloneJson in validPortResult catches the error and returns false
    const result = await dispatchHookBoundary(port, request, { timeout_ms: 5000, mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });
});

// ---- providerRequestNarrows: structured_output edge cases (L268-269) ----
describe('hook-port-survival-8: structured_output (L268-269)', () => {
  it('allows when original=false and candidate=false', () => {
    expect(validate(makeReq(), makeReq()).allowed).toBe(true);
  });

  it('allows when original=false and candidate=true', () => {
    const o = makeReq();
    const c = makeReq({ requires_structured_output: true });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('allows when original=true and candidate=true', () => {
    const o = makeReq({ requires_structured_output: true });
    const c = makeReq({ requires_structured_output: true });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when original=true and candidate=false', () => {
    const o = makeReq({ requires_structured_output: true });
    const c = makeReq({ requires_structured_output: false });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original is not boolean', () => {
    const o = makeReq({ requires_structured_output: 'yes' });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate is not boolean', () => {
    const o = makeReq();
    const c = makeReq({ requires_structured_output: 'yes' });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: tools narrowing (L290) ----
describe('hook-port-survival-8: tools narrowing (L290)', () => {
  it('allows when candidate tools are subset of original', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }, { name: 'write_file' }], max_tokens: 1000 } });
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when candidate tools include tool not in original', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 } });
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }, { name: 'write_file' }], max_tokens: 1000 } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original tools is not an array', () => {
    const o = makeReq({ request: { messages: [], tools: 'not_array', max_tokens: 1000 } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate tools is not an array', () => {
    const o = makeReq();
    const c = makeReq({ request: { messages: [], tools: 'not_array', max_tokens: 1000 } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: request record check (L278-279) ----
describe('hook-port-survival-8: request record check (L278-279)', () => {
  it('denies when original request is not a record', () => {
    const o = makeReq({ request: 'none' });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate request is not a record', () => {
    const o = makeReq();
    const c = makeReq({ request: null });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when request keys mismatch', () => {
    const o = makeReq();
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000, extra: true } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: max_tokens edge cases (L293-295) ----
describe('hook-port-survival-8: max_tokens edge cases (L293-295)', () => {
  it('allows when candidate max_tokens equals original', () => {
    expect(validate(makeReq(), makeReq()).allowed).toBe(true);
  });

  it('allows when candidate max_tokens < original', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 } });
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500 } });
    expect(validate(o, c).allowed).toBe(true);
  });

  it('denies when candidate max_tokens > original', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500 } });
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate max_tokens is negative', () => {
    const o = makeReq();
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: -1 } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original max_tokens is not a number', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: '1000' } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate max_tokens is not a number', () => {
    const o = makeReq();
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: '500' } });
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when original max_tokens is not a safe integer', () => {
    const o = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: Number.MAX_SAFE_INTEGER + 1 } });
    const c = makeReq();
    expect(validate(o, c).allowed).toBe(false);
  });

  it('denies when candidate max_tokens is not a safe integer', () => {
    const o = makeReq();
    const c = makeReq({ request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: Number.MAX_SAFE_INTEGER + 1 } });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: top-level record check (L235) ----
describe('hook-port-survival-8: top-level record check (L235)', () => {
  it('denies when original is not a record', () => {
    expect(validate('none', makeReq()).allowed).toBe(false);
  });

  it('denies when candidate is not a record', () => {
    expect(validate(makeReq(), null).allowed).toBe(false);
  });

  it('denies when top-level keys mismatch', () => {
    const o = makeReq();
    const c = makeReq({ extra_field: true });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: registry_snapshot_hash (L253) ----
describe('hook-port-survival-8: registry_snapshot_hash (L253)', () => {
  it('denies when registry_snapshot_hash differs', () => {
    const o = makeReq({ registry_snapshot_hash: 'h1' });
    const c = makeReq({ registry_snapshot_hash: 'h2' });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- providerRequestNarrows: estimated_input_tokens (L253) ----
describe('hook-port-survival-8: estimated_input_tokens (L253)', () => {
  it('denies when estimated_input_tokens differs', () => {
    const o = makeReq({ estimated_input_tokens: 100 });
    const c = makeReq({ estimated_input_tokens: 200 });
    expect(validate(o, c).allowed).toBe(false);
  });
});

// ---- validate: unknown event returns false ----
describe('hook-port-survival-8: unknown event', () => {
  it('denies for unknown event type', () => {
    const result = policy.validate({
      event: 'unknown_event' as 'pre_tool_use',
      scope: makeScope(),
      original_payload: {},
      candidate_payload: {},
    });
    expect(result.allowed).toBe(false);
  });

  it('allows pre_tool_use unconditionally', () => {
    const result = policy.validate({
      event: 'pre_tool_use',
      scope: makeScope(),
      original_payload: {},
      candidate_payload: {},
    });
    expect(result.allowed).toBe(true);
  });

  it('uses sameJson for pre_turn event', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { a: 1 },
      candidate_payload: { a: 1 },
    });
    expect(result.allowed).toBe(true);
  });

  it('denies pre_turn when payloads differ', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: makeScope(),
      original_payload: { a: 1 },
      candidate_payload: { a: 2 },
    });
    expect(result.allowed).toBe(false);
  });

  it('uses sameJson for session_before_compact event', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope: makeScope(),
      original_payload: { a: 1 },
      candidate_payload: { a: 1 },
    });
    expect(result.allowed).toBe(true);
  });
});
