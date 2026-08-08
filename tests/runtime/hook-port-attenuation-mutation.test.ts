import { describe, it, expect, vi } from 'vitest';
import {
  createHarnessHookAttenuationPolicy,
  dispatchHookBoundary,
  type RuntimeHookRequest,
  type HookRuntimePort,
  type RuntimeHookOutcome,
} from '../../runtime/hook-port.js';

function makeProviderRequest(overrides: Record<string, unknown> = {}) {
  return {
    registry_snapshot_hash: 'abc',
    estimated_input_tokens: 1000,
    required_capabilities: ['chat'],
    requires_structured_output: false,
    request: {
      model: 'gpt-4',
      messages: [],
      max_tokens: 2000,
      tools: [{ name: 'read_file' }],
    },
    data_policy: {
      local_only: false,
      allowed_regions: ['us', 'cn'],
      max_retention_days: 30,
      training_allowed: false,
    },
    policy: {
      allowed_provider_ids: ['p1'],
      denied_provider_ids: [],
    },
    run_plan: {
      allowed_provider_ids: ['p1'],
      required_capabilities: ['chat'],
    },
    ...overrides,
  };
}

describe('attenuation policy: provider request validation', () => {
  const policy = createHarnessHookAttenuationPolicy();

  it('allows narrowing required_capabilities (subset of original)', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({
      required_capabilities: ['chat'],
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows expanding required_capabilities (superset of original)', () => {
    const original = makeProviderRequest({ required_capabilities: ['chat'] });
    const candidate = makeProviderRequest({ required_capabilities: ['chat', 'vision'] });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies changing registry_snapshot_hash', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({ registry_snapshot_hash: 'xyz' });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('denies changing estimated_input_tokens', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({ estimated_input_tokens: 999 });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows reducing max_tokens', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({
      request: { model: 'gpt-4', messages: [], max_tokens: 1000, tools: [{ name: 'read_file' }] },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies increasing max_tokens', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({
      request: { model: 'gpt-4', messages: [], max_tokens: 3000, tools: [{ name: 'read_file' }] },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows removing tools (subset)', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({
      request: { model: 'gpt-4', messages: [], max_tokens: 2000, tools: [] },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies adding new tools', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({
      request: { model: 'gpt-4', messages: [], max_tokens: 2000, tools: [{ name: 'read_file' }, { name: 'write_file' }] },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows enabling requires_structured_output when originally false', () => {
    const original = makeProviderRequest({ requires_structured_output: false });
    const candidate = makeProviderRequest({ requires_structured_output: true });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies disabling requires_structured_output when originally true', () => {
    const original = makeProviderRequest({ requires_structured_output: true });
    const candidate = makeProviderRequest({ requires_structured_output: false });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });
});

describe('attenuation policy: data policy validation', () => {
  const policy = createHarnessHookAttenuationPolicy();

  it('allows narrowing allowed_regions (subset)', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies expanding allowed_regions', () => {
    const original = makeProviderRequest({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } });
    const candidate = makeProviderRequest({ data_policy: { local_only: false, allowed_regions: ['us', 'cn'], max_retention_days: 30, training_allowed: false } });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows reducing max_retention_days', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({
      data_policy: { local_only: false, allowed_regions: ['us', 'cn'], max_retention_days: 15, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies increasing max_retention_days', () => {
    const original = makeProviderRequest();
    const candidate = makeProviderRequest({
      data_policy: { local_only: false, allowed_regions: ['us', 'cn'], max_retention_days: 60, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows enabling local_only', () => {
    const original = makeProviderRequest({ data_policy: { local_only: false, allowed_regions: ['us', 'cn'], max_retention_days: 30, training_allowed: false } });
    const candidate = makeProviderRequest({ data_policy: { local_only: true, allowed_regions: ['us', 'cn'], max_retention_days: 30, training_allowed: false } });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('denies disabling local_only', () => {
    const original = makeProviderRequest({ data_policy: { local_only: true, allowed_regions: ['us', 'cn'], max_retention_days: 30, training_allowed: false } });
    const candidate = makeProviderRequest({ data_policy: { local_only: false, allowed_regions: ['us', 'cn'], max_retention_days: 30, training_allowed: false } });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('denies enabling training_allowed', () => {
    const original = makeProviderRequest({ data_policy: { local_only: false, allowed_regions: ['us', 'cn'], max_retention_days: 30, training_allowed: false } });
    const candidate = makeProviderRequest({ data_policy: { local_only: false, allowed_regions: ['us', 'cn'], max_retention_days: 30, training_allowed: true } });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });
});

describe('dispatchHookBoundary: error handling', () => {
  function makeRequest(): RuntimeHookRequest {
    return {
      event: 'pre_tool_use',
      invocation_id: 'inv-1',
      idempotency_key: 'idem-1',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      payload: { tool: 'read_file' },
    };
  }

  it('returns continue when port is undefined', async () => {
    const result = await dispatchHookBoundary(undefined, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('continue');
  });

  it('returns deny when port throws (decision mode)', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => { throw new Error('port error'); }),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toContain('failed');
  });

  it('returns continue when port throws (observational mode)', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => { throw new Error('port error'); }),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational' });
    expect(result.action).toBe('continue');
  });

  it('throws TypeError for invalid timeout_ms', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false }) as RuntimeHookOutcome) };
    await expect(dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: -1 }))
      .rejects.toThrow(TypeError);
  });

  it('throws TypeError for non-integer timeout_ms', async () => {
    const port: HookRuntimePort = { dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false }) as RuntimeHookOutcome) };
    await expect(dispatchHookBoundary(port, makeRequest(), { mode: 'decision', timeout_ms: 1.5 }))
      .rejects.toThrow(TypeError);
  });

  it('returns deny when signal is already aborted (decision mode)', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = { dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false }) as RuntimeHookOutcome) };
    const req = { ...makeRequest(), signal: controller.signal };
    const result = await dispatchHookBoundary(port, req, { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_cancelled');
  });

  it('returns continue when signal is already aborted (observational mode)', async () => {
    const controller = new AbortController();
    controller.abort();
    const port: HookRuntimePort = { dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'continue', payload: {}, follow_ups: [], replayed: false }) as RuntimeHookOutcome) };
    const req = { ...makeRequest(), signal: controller.signal };
    const result = await dispatchHookBoundary(port, req, { mode: 'observational' });
    expect(result.action).toBe('continue');
    expect(result.reason_code).toBe('hook_observer_cancelled');
  });

  it('returns deny when port returns invalid result (decision mode)', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'continue', reason_code: 'should_not_have_reason', payload: {}, follow_ups: [], replayed: false }) as RuntimeHookOutcome),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns continue when port returns invalid result (observational mode)', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'continue', reason_code: 'should_not_have_reason', payload: {}, follow_ups: [], replayed: false }) as RuntimeHookOutcome),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational' });
    expect(result.action).toBe('continue');
  });

  it('returns deny when port returns deny without reason_code', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'deny', payload: {}, follow_ups: [], replayed: false }) as RuntimeHookOutcome),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns deny when port returns deny with empty reason_code', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'deny', reason_code: '  ', payload: {}, follow_ups: [], replayed: false }) as RuntimeHookOutcome),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns continue for valid result with same payload (observational)', async () => {
    const payload = { tool: 'read_file' };
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'continue', payload, follow_ups: [], replayed: false }) as RuntimeHookOutcome),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'observational' });
    expect(result.action).toBe('continue');
  });

  it('uses default timeout_ms of 5000 when not specified', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({ event: 'pre_tool_use', action: 'continue', payload: { tool: 'read_file' }, follow_ups: [], replayed: false }) as RuntimeHookOutcome),
    };
    const result = await dispatchHookBoundary(port, makeRequest(), { mode: 'decision' });
    expect(result.action).toBe('continue');
  });
});
