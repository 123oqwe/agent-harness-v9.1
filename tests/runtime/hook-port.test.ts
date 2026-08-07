import { describe, it, expect } from 'vitest';
import {
  createHarnessHookAttenuationPolicy,
  dispatchHookBoundary,
  RUNTIME_HOOK_EVENTS,
  type RuntimeHookRequest,
  type HookRuntimePort,
  type RuntimeHookOutcome,
} from '../../runtime/hook-port.js';

function makeRequest(overrides: Partial<RuntimeHookRequest> = {}): RuntimeHookRequest {
  return {
    event: 'pre_tool_use',
    invocation_id: 'inv-1',
    idempotency_key: 'idem-1',
    scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
    payload: { tool: 'read_file', args: {} },
    ...overrides,
  };
}

const fullProviderRequest = {
  registry_snapshot_hash: 'abc',
  estimated_input_tokens: 1000,
  required_capabilities: ['chat'],
  requires_structured_output: false,
  request: { model: 'gpt-4', messages: [], max_tokens: 2000, tools: [{ name: 'read_file' }] },
  data_policy: {
    local_only: false,
    allowed_regions: ['us'],
    max_retention_days: 30,
    training_allowed: false,
  },
  policy: {
    allowed_provider_ids: ['p1'],
    denied_provider_ids: [],
    extra: 'same',
  },
  run_plan: {
    allowed_provider_ids: ['p1'],
    required_capabilities: ['chat'],
    extra: 'same',
  },
};

describe('createHarnessHookAttenuationPolicy', () => {
  const policy = createHarnessHookAttenuationPolicy();

  it('allows pre_tool_use events unconditionally', () => {
    const result = policy.validate({
      event: 'pre_tool_use',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: { a: 1 },
      candidate_payload: { a: 2 },
    });
    expect(result.allowed).toBe(true);
  });

  it('allows user_prompt_submit when task contract narrows', () => {
    const original = { task_id: 't1', goal: 'do thing', constraints: [{ type: 'budget', value: '100' }] };
    const candidate = { task_id: 't1', goal: 'do thing', constraints: [{ type: 'budget', value: '50' }] };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies user_prompt_submit when task contract expands budget', () => {
    const original = { task_id: 't1', goal: 'do thing', constraints: [{ type: 'budget', value: '50' }] };
    const candidate = { task_id: 't1', goal: 'do thing', constraints: [{ type: 'budget', value: '100' }] };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
  });

  it('denies user_prompt_submit when task_id changes', () => {
    const original = { task_id: 't1', goal: 'g', constraints: [] };
    const candidate = { task_id: 't2', goal: 'g', constraints: [] };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows pre_turn when payload is identical', () => {
    const payload = { context: 'some context' };
    const result = policy.validate({
      event: 'pre_turn',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies pre_turn when payload differs', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: { context: 'a' },
      candidate_payload: { context: 'b' },
    });
    expect(result.allowed).toBe(false);
  });

  it('allows session_before_compact when payload is identical', () => {
    const payload = { messages: [] };
    const result = policy.validate({
      event: 'session_before_compact',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: payload,
      candidate_payload: { messages: [] },
    });
    expect(result.allowed).toBe(true);
  });

  it('denies session_before_compact when payload differs', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: { messages: [1] },
      candidate_payload: { messages: [1, 2] },
    });
    expect(result.allowed).toBe(false);
  });

  it('denies before_provider_request when max_tokens increases', () => {
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.request.max_tokens = 3000;
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: fullProviderRequest,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows before_provider_request when max_tokens decreases', () => {
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.request.max_tokens = 1000;
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: fullProviderRequest,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows before_provider_request when required_capabilities expand (superset)', () => {
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.required_capabilities = ['chat', 'vision'];
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: fullProviderRequest,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies before_provider_request when data_policy allows more regions', () => {
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.data_policy.allowed_regions = ['us', 'eu'];
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: fullProviderRequest,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('denies before_provider_request when local_only is removed', () => {
    const original = JSON.parse(JSON.stringify(fullProviderRequest));
    original.data_policy.local_only = true;
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.data_policy.local_only = false;
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('denies before_provider_request when training_allowed goes from false to true', () => {
    const original = JSON.parse(JSON.stringify(fullProviderRequest));
    original.data_policy.training_allowed = false;
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.data_policy.training_allowed = true;
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows before_provider_request when denied_provider_ids grows', () => {
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.policy.denied_provider_ids = ['bad-provider'];
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: fullProviderRequest,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies before_provider_request when allowed_provider_ids grows', () => {
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.policy.allowed_provider_ids = ['p1', 'p2'];
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: fullProviderRequest,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('denies before_provider_request when max_retention_days increases', () => {
    const candidate = JSON.parse(JSON.stringify(fullProviderRequest));
    candidate.data_policy.max_retention_days = 60;
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: fullProviderRequest,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('denies unknown events', () => {
    const result = policy.validate({
      event: 'post_turn' as any,
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: {},
      candidate_payload: {},
    });
    expect(result.allowed).toBe(false);
  });
});

describe('dispatchHookBoundary', () => {
  it('returns continue when no port is provided', async () => {
    const request = makeRequest();
    const result = await dispatchHookBoundary(undefined, request, { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('continue');
    expect(result.replayed).toBe(false);
  });

  it('returns port result when port returns valid continue', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'pre_tool_use', action: 'continue', payload: { tool: 'read_file' }, follow_ups: [], replayed: false } as RuntimeHookOutcome;
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('continue');
  });

  it('returns deny in decision mode when port times out', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        await new Promise((r) => setTimeout(r, 200));
        return { event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false };
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 50 });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_timeout');
  });

  it('returns continue in observational mode when port times out', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        await new Promise((r) => setTimeout(r, 200));
        return { event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false };
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational', timeout_ms: 50 });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_timeout');
  });

  it('returns deny when port throws', async () => {
    const port: HookRuntimePort = { async dispatch() { throw new Error('port error'); } };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_failed');
  });

  it('returns continue when port throws in observational mode', async () => {
    const port: HookRuntimePort = { async dispatch() { throw new Error('port error'); } };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational', timeout_ms: 1000 });
    expect(result.action).toBe('continue');
  });

  it('returns deny when port returns invalid result shape', async () => {
    const port: HookRuntimePort = { async dispatch() { return { wrong: 'shape' } as any; } };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns continue when port returns invalid result in observational mode', async () => {
    const port: HookRuntimePort = { async dispatch() { return { wrong: 'shape' } as any; } };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational', timeout_ms: 1000 });
    expect(result.action).toBe('continue');
  });

  it('returns deny when port returns continue with reason_code (invalid)', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'pre_tool_use', action: 'continue', payload: {}, reason_code: 'bad', follow_ups: [], replayed: false } as any;
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('deny');
  });

  it('returns deny when port returns deny without reason_code (invalid)', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'pre_tool_use', action: 'deny', payload: {}, follow_ups: [], replayed: false } as any;
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('throws on invalid timeout_ms', async () => {
    const port: HookRuntimePort = { async dispatch() { return { event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false }; } };
    await expect(dispatchHookBoundary(port, makeRequest(), { mode: 'decision' as const, timeout_ms: 0 })).rejects.toThrow(TypeError);
    await expect(dispatchHookBoundary(port, makeRequest(), { mode: 'decision' as const, timeout_ms: -1 })).rejects.toThrow(TypeError);
  });

  it('returns continue when signal already aborted in observational mode', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = makeRequest({ signal: controller.signal });
    const result = await dispatchHookBoundary(undefined, request, { mode: 'observational', timeout_ms: 1000 });
    expect(result.action).toBe('continue');
  });

  it('returns continue in observational mode even if port returns deny', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'pre_tool_use', action: 'deny', payload: {}, reason_code: 'blocked', follow_ups: [], replayed: false };
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational', timeout_ms: 1000 });
    expect(result.action).toBe('continue');
  });

  it('allows payload change for pre_tool_use (always allowed)', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'pre_tool_use', action: 'continue', payload: { tool: 'write_file' }, follow_ups: [], replayed: false };
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ tool: 'write_file' });
  });

  it('denies when port changes payload for user_prompt_submit and task contract expands', async () => {
    const original = { task_id: 't1', goal: 'g', constraints: [{ type: 'budget', value: '50' }] };
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'user_prompt_submit', action: 'continue', payload: { task_id: 't1', goal: 'g', constraints: [{ type: 'budget', value: '200' }] }, follow_ups: [], replayed: false };
      },
    };
    const request = makeRequest({ event: 'user_prompt_submit', payload: original });
    const result = await dispatchHookBoundary(port, request, { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
  });

  it('allows when port narrows payload for user_prompt_submit', async () => {
    const original = { task_id: 't1', goal: 'g', constraints: [{ type: 'budget', value: '200' }] };
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'user_prompt_submit', action: 'continue', payload: { task_id: 't1', goal: 'g', constraints: [{ type: 'budget', value: '50' }] }, follow_ups: [], replayed: false };
      },
    };
    const request = makeRequest({ event: 'user_prompt_submit', payload: original });
    const result = await dispatchHookBoundary(port, request, { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('continue');
  });

  it('returns skip action when port returns skip', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'pre_tool_use', action: 'skip', payload: {}, reason_code: 'skip_tool', follow_ups: [], replayed: false };
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('skip');
  });

  it('returns force_prompt action when port returns force_prompt', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'pre_tool_use', action: 'force_prompt', payload: {}, reason_code: 'force', follow_ups: [], replayed: false };
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('force_prompt');
  });

  it('returns deny when port returns invalid action', async () => {
    const port: HookRuntimePort = {
      async dispatch() {
        return { event: 'pre_tool_use', action: 'invalid_action', payload: {}, reason_code: 'bad', follow_ups: [], replayed: false } as any;
      },
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1000 });
    expect(result.action).toBe('deny');
  });
});

describe('RUNTIME_HOOK_EVENTS', () => {
  it('contains all expected hook events', () => {
    expect(RUNTIME_HOOK_EVENTS).toContain('user_prompt_submit');
    expect(RUNTIME_HOOK_EVENTS).toContain('session_start');
    expect(RUNTIME_HOOK_EVENTS).toContain('before_provider_request');
    expect(RUNTIME_HOOK_EVENTS).toContain('pre_turn');
    expect(RUNTIME_HOOK_EVENTS).toContain('pre_tool_use');
    expect(RUNTIME_HOOK_EVENTS).toContain('post_tool_use');
    expect(RUNTIME_HOOK_EVENTS).toContain('after_response');
    expect(RUNTIME_HOOK_EVENTS).toContain('post_turn');
    expect(RUNTIME_HOOK_EVENTS).toContain('session_before_compact');
    expect(RUNTIME_HOOK_EVENTS).toContain('stop');
    expect(RUNTIME_HOOK_EVENTS).toContain('session_end');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RUNTIME_HOOK_EVENTS)).toBe(true);
  });
});
