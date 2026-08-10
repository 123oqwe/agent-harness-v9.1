import { describe, expect, it } from 'vitest';
import { createHarnessHookAttenuationPolicy } from '../../runtime/hook-port.js';

const policy = createHarnessHookAttenuationPolicy();

const scope = { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' };

describe('hook attenuation policy: pre_tool_use', () => {
  it('allows any payload change for pre_tool_use', () => {
    const result = policy.validate({
      event: 'pre_tool_use',
      scope,
      original_payload: { tool: 'read_file' },
      candidate_payload: { tool: 'write_file' },
    });
    expect(result.allowed).toBe(true);
  });

  it('allows identical payload for pre_tool_use', () => {
    const result = policy.validate({
      event: 'pre_tool_use',
      scope,
      original_payload: { tool: 'read_file' },
      candidate_payload: { tool: 'read_file' },
    });
    expect(result.allowed).toBe(true);
  });
});

describe('hook attenuation policy: user_prompt_submit (taskContractNarrows)', () => {
  const baseContract = {
    goal: 'test goal',
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints: [],
  };

  it('allows identical task contract', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseContract,
      candidate_payload: baseContract,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed budget constraint (lower value)', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [{ type: 'budget', value: '100' }] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'budget', value: '50' }] },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects changed goal', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseContract,
      candidate_payload: { ...baseContract, goal: 'different goal' },
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-record original payload', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: 'string',
      candidate_payload: baseContract,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-record candidate payload', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseContract,
      candidate_payload: null,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows expanded constraints (adding more restrictions)', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: { ...baseContract, constraints: [] },
      candidate_payload: { ...baseContract, constraints: [{ type: 'budget', value: '100' }] },
    });
    expect(result.allowed).toBe(true);
  });
});

describe('hook attenuation policy: before_provider_request (providerRequestNarrows)', () => {
  function makeRequest(overrides: Record<string, unknown> = {}): any {
    return {
      registry_snapshot_hash: 'abc123',
      estimated_input_tokens: 1000,
      required_capabilities: ['text_reasoning'],
      requires_structured_output: false,
      request: {
        model: 'test-model',
        messages: [],
        tools: [],
        max_tokens: 1000,
      },
      data_policy: {
        local_only: false,
        allowed_regions: ['us'],
        max_retention_days: 30,
        training_allowed: false,
      },
      policy: { denied_provider_ids: [], allowed_provider_ids: [] },
      run_plan: { run_id: 'r1', required_capabilities: [], allowed_provider_ids: [] },
      ...overrides,
    };
  }
  const baseRequest = makeRequest();

  it('allows identical request', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest(),
      candidate_payload: makeRequest(),
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed max_tokens (lower)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest(),
      candidate_payload: makeRequest({ request: { model: 'test-model', messages: [], tools: [], max_tokens: 500 } }),
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded max_tokens (higher)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest(),
      candidate_payload: makeRequest({ request: { model: 'test-model', messages: [], tools: [], max_tokens: 2000 } }),
    });
    expect(result.allowed).toBe(false);
  });

  it('allows fewer tools', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest(),
      candidate_payload: makeRequest({ request: { model: 'test-model', messages: [], tools: [], max_tokens: 1000 } }),
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed local_only (true when false)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest(),
      candidate_payload: makeRequest({ data_policy: { local_only: true, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } }),
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded local_only (false when true)', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest({ data_policy: { local_only: true, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } }),
      candidate_payload: makeRequest({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false } }),
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed retention days', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest(),
      candidate_payload: makeRequest({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 15, training_allowed: false } }),
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded retention days', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest(),
      candidate_payload: makeRequest({ data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 60, training_allowed: false } }),
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-record original', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: null,
      candidate_payload: makeRequest(),
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-record candidate', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: makeRequest(),
      candidate_payload: 'string',
    });
    expect(result.allowed).toBe(false);
  });
});

describe('hook attenuation policy: pre_turn and session_before_compact', () => {
  it('allows identical payload for pre_turn', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope,
      original_payload: { messages: [] },
      candidate_payload: { messages: [] },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects different payload for pre_turn', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope,
      original_payload: { messages: [] },
      candidate_payload: { messages: [{ role: 'user' }] },
    });
    expect(result.allowed).toBe(false);
  });

  it('allows identical payload for session_before_compact', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope,
      original_payload: { data: 'test' },
      candidate_payload: { data: 'test' },
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects different payload for session_before_compact', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope,
      original_payload: { data: 'test' },
      candidate_payload: { data: 'different' },
    });
    expect(result.allowed).toBe(false);
  });
});

describe('hook attenuation policy: unknown events', () => {
  it('rejects unknown event type', () => {
    const result = policy.validate({
      event: 'unknown_event' as any,
      scope,
      original_payload: {},
      candidate_payload: {},
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
    }
  });

  it('returns exact reason_code string when rejected', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope,
      original_payload: { a: 1 },
      candidate_payload: { a: 2 },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
    }
  });
});
