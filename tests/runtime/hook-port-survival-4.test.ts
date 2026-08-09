import { describe, it, expect } from 'vitest';
import { createHarnessHookAttenuationPolicy } from '../../runtime/hook-port.js';

const policy = createHarnessHookAttenuationPolicy();

function makeTaskPayload(overrides: Record<string, unknown> = {}) {
  return {
    goal: 'test goal',
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints: [],
    ...overrides,
  };
}

function makeProviderPayload(overrides: Record<string, unknown> = {}) {
  return {
    registry_snapshot_hash: 'hash1',
    estimated_input_tokens: 100,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    request: {
      messages: [],
      tools: [{ name: 'read_file' }],
      max_tokens: 1000,
    },
    data_policy: {
      local_only: false,
      allowed_regions: ['us', 'eu'],
      max_retention_days: 30,
      training_allowed: false,
    },
    policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] },
    run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [] },
    ...overrides,
  };
}

// L112-132: isRecord, cloneJson, deepFreeze, canonicalJson
describe('hook-port-survival-4 attenuation policy - task contract', () => {
  it('allows identical task contract', () => {
    const payload = makeTaskPayload();
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed constraints (budget decreases)', () => {
    const original = makeTaskPayload({
      constraints: [{ type: 'budget', value: '100' }],
    });
    const candidate = makeTaskPayload({
      constraints: [{ type: 'budget', value: '50' }],
    });
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded constraints (budget increases)', () => {
    const original = makeTaskPayload({
      constraints: [{ type: 'budget', value: '50' }],
    });
    const candidate = makeTaskPayload({
      constraints: [{ type: 'budget', value: '100' }],
    });
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed time constraints', () => {
    const original = makeTaskPayload({ constraints: [{ type: 'time', value: '60' }] });
    const candidate = makeTaskPayload({ constraints: [{ type: 'time', value: '30' }] });
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed risk_ceiling constraints', () => {
    const original = makeTaskPayload({ constraints: [{ type: 'risk_ceiling', value: '3' }] });
    const candidate = makeTaskPayload({ constraints: [{ type: 'risk_ceiling', value: '2' }] });
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects different constraint types that are not narrowable', () => {
    const original = makeTaskPayload({ constraints: [{ type: 'privacy', value: 'strict' }] });
    const candidate = makeTaskPayload({ constraints: [{ type: 'privacy', value: ' relaxed' }] });
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when constraint value is negative for budget', () => {
    const original = makeTaskPayload({ constraints: [{ type: 'budget', value: '100' }] });
    const candidate = makeTaskPayload({ constraints: [{ type: 'budget', value: '-50' }] });
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when goal is changed', () => {
    const original = makeTaskPayload({ goal: 'original goal' });
    const candidate = makeTaskPayload({ goal: 'changed goal' });
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when keys differ', () => {
    const original = makeTaskPayload({ extra_field: 'value' });
    const candidate = makeTaskPayload();
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when original is not a record', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: null,
      candidate_payload: makeTaskPayload(),
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate is not a record', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: makeTaskPayload(),
      candidate_payload: null,
    });
    expect(result.allowed).toBe(false);
  });
});

// L248-367: Provider request narrowing (NoCov paths)
describe('hook-port-survival-4 attenuation policy - provider request', () => {
  it('allows identical provider request', () => {
    const payload = makeProviderPayload();
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed max_tokens', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500 },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded max_tokens', () => {
    const original = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500 },
    });
    const candidate = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed allowed_regions', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded allowed_regions', () => {
    const original = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
    });
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed max_retention_days', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 15, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when training_allowed goes from false to true', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: true },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows when local_only goes from false to true', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      data_policy: { local_only: true, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when local_only goes from true to false', () => {
    const original = makeProviderPayload({
      data_policy: { local_only: true, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false },
    });
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed required_capabilities (superset)', () => {
    const original = makeProviderPayload({ required_capabilities: ['text_reasoning', 'tool_calling'] });
    const candidate = makeProviderPayload({ required_capabilities: ['text_reasoning', 'tool_calling', 'structured_output'] });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when required_capabilities is missing original capability', () => {
    const original = makeProviderPayload({ required_capabilities: ['text_reasoning', 'tool_calling'] });
    const candidate = makeProviderPayload({ required_capabilities: ['text_reasoning'] });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows requires_structured_output going from false to true', () => {
    const original = makeProviderPayload({ requires_structured_output: false });
    const candidate = makeProviderPayload({ requires_structured_output: true });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects requires_structured_output going from true to false', () => {
    const original = makeProviderPayload({ requires_structured_output: true });
    const candidate = makeProviderPayload({ requires_structured_output: false });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when original is not a record', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: 'not-a-record',
      candidate_payload: makeProviderPayload(),
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate is not a record', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: makeProviderPayload(),
      candidate_payload: 'not-a-record',
    });
    expect(result.allowed).toBe(false);
  });
});

// L402-411: pre_tool_use and pre_turn events
describe('hook-port-survival-4 attenuation policy - other events', () => {
  it('always allows pre_tool_use', () => {
    const result = policy.validate({
      event: 'pre_tool_use',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: { tool: 'read_file' },
      candidate_payload: { tool: 'write_file' },
    });
    expect(result.allowed).toBe(true);
  });

  it('allows pre_turn when payload is identical', () => {
    const payload = { messages: [{ role: 'user', content: 'hello' }] };
    const result = policy.validate({
      event: 'pre_turn',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects pre_turn when payload differs', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: { messages: [{ role: 'user', content: 'hello' }] },
      candidate_payload: { messages: [{ role: 'user', content: 'world' }] },
    });
    expect(result.allowed).toBe(false);
  });

  it('allows session_before_compact when payload is identical', () => {
    const payload = { context: 'test' };
    const result = policy.validate({
      event: 'session_before_compact',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects unknown event types', () => {
    const result = policy.validate({
      event: 'unknown_event' as any,
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: {},
      candidate_payload: {},
    });
    expect(result.allowed).toBe(false);
  });

  it('returns exact reason_code when rejected', () => {
    const result = policy.validate({
      event: 'unknown_event' as any,
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' },
      original_payload: {},
      candidate_payload: {},
    });
    if (!result.allowed) {
      expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
    }
  });
});
