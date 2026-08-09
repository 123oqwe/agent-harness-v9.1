import { describe, expect, it } from 'vitest';
import {
  HookRestrictionError,
  createHarnessHookAttenuationPolicy,
  dispatchHookBoundary,
  type HookRuntimePort,
  type RuntimeHookRequest,
  type RuntimeHookOutcome,
  type RuntimeHookScope,
} from '../../runtime/hook-port.js';

const scope: RuntimeHookScope = {
  tenant_id: 'test-tenant',
  run_id: 'test-run',
  session_id: 'test-session',
};

function makeRequest(
  event: RuntimeHookRequest['event'],
  payload: unknown,
  signal?: AbortSignal,
): RuntimeHookRequest {
  return {
    event,
    invocation_id: 'inv-1',
    idempotency_key: 'idem-1',
    scope,
    payload,
    ...(signal ? { signal } : {}),
  };
}

// --- Attenuation policy: taskContractNarrows ---

describe('Hook attenuation policy: user_prompt_submit', () => {
  const policy = createHarnessHookAttenuationPolicy();
  const baseTask = {
    goal: 'test goal',
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints: [
      { type: 'budget', value: '1000' },
      { type: 'time', value: '5000' },
      { type: 'risk_ceiling', value: '3' },
      { type: 'privacy', value: 'high' },
      { type: 'tool_restriction', value: 'no_exec' },
      { type: 'model_restriction', value: 'glm_only' },
    ],
  };

  it('allows identical payload', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: baseTask,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed budget constraint (lower value)', () => {
    const narrowed = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '500' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '3' },
        { type: 'privacy', value: 'high' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded budget constraint (higher value)', () => {
    const expanded = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '2000' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '3' },
        { type: 'privacy', value: 'high' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed time constraint', () => {
    const narrowed = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '1000' },
        { type: 'time', value: '3000' },
        { type: 'risk_ceiling', value: '3' },
        { type: 'privacy', value: 'high' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed risk_ceiling constraint', () => {
    const narrowed = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '1000' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '2' },
        { type: 'privacy', value: 'high' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded risk_ceiling constraint', () => {
    const expanded = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '1000' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '4' },
        { type: 'privacy', value: 'high' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects different goal', () => {
    const modified = { ...baseTask, goal: 'different goal' };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects different success_criteria', () => {
    const modified = {
      ...baseTask,
      success_criteria: [{ criterion: 'different', verification_method: 'test' }],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects different keys', () => {
    const modified = { ...baseTask, extra_field: 'bad' };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-record original', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: null,
      candidate_payload: baseTask,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-record candidate', () => {
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: null,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects candidate with missing constraint', () => {
    const narrowed = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '1000' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '3' },
        // missing privacy, tool_restriction, model_restriction
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-array constraints', () => {
    const modified = { ...baseTask, constraints: 'not-array' };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects constraint with invalid type', () => {
    const modified = {
      ...baseTask,
      constraints: [
        { type: 'invalid_type', value: '1000' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects constraint with non-string value', () => {
    const modified = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: 1000 },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows privacy constraint with same value', () => {
    const narrowed = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '1000' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '3' },
        { type: 'privacy', value: 'high' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects privacy constraint with different value', () => {
    const modified = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '1000' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '3' },
        { type: 'privacy', value: 'low' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows zero budget', () => {
    const narrowed = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '0' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '3' },
        { type: 'privacy', value: 'high' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects negative budget', () => {
    const modified = {
      ...baseTask,
      constraints: [
        { type: 'budget', value: '-100' },
        { type: 'time', value: '5000' },
        { type: 'risk_ceiling', value: '3' },
        { type: 'privacy', value: 'high' },
        { type: 'tool_restriction', value: 'no_exec' },
        { type: 'model_restriction', value: 'glm_only' },
      ],
    };
    const result = policy.validate({
      event: 'user_prompt_submit',
      scope,
      original_payload: baseTask,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });
});

// --- Attenuation policy: before_provider_request ---

describe('Hook attenuation policy: before_provider_request', () => {
  const policy = createHarnessHookAttenuationPolicy();
  const baseRequest = {
    registry_snapshot_hash: 'hash-1',
    request: {
      messages: [],
      tools: [{ name: 'read_file' }],
      max_tokens: 4096,
    },
    estimated_input_tokens: 100,
    required_capabilities: ['text_reasoning', 'tool_calling'],
    requires_structured_output: false,
    data_policy: {
      local_only: true,
      allowed_regions: ['local', 'us'],
      max_retention_days: 30,
      training_allowed: false,
    },
    policy: {
      allowed_provider_ids: undefined,
      denied_provider_ids: [],
    },
    run_plan: {
      allowed_provider_ids: undefined,
      required_capabilities: ['text_reasoning'],
    },
  };

  it('allows identical payload', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: baseRequest,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows narrowed max_tokens (lower)', () => {
    const narrowed = {
      ...baseRequest,
      request: { ...baseRequest.request, max_tokens: 2048 },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded max_tokens (higher)', () => {
    const expanded = {
      ...baseRequest,
      request: { ...baseRequest.request, max_tokens: 8192 },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows superset of required_capabilities', () => {
    const expanded = {
      ...baseRequest,
      required_capabilities: ['text_reasoning', 'tool_calling', 'structured_output'],
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects subset of required_capabilities', () => {
    const narrowed = {
      ...baseRequest,
      required_capabilities: ['text_reasoning'],
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed local_only (true stays true)', () => {
    const narrowed = {
      ...baseRequest,
      data_policy: { ...baseRequest.data_policy, local_only: true },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanding local_only (false when original is true)', () => {
    const expanded = {
      ...baseRequest,
      data_policy: { ...baseRequest.data_policy, local_only: false },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed allowed_regions (subset)', () => {
    const narrowed = {
      ...baseRequest,
      data_policy: { ...baseRequest.data_policy, allowed_regions: ['local'] },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded allowed_regions (superset)', () => {
    const expanded = {
      ...baseRequest,
      data_policy: { ...baseRequest.data_policy, allowed_regions: ['local', 'us', 'eu'] },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows narrowed max_retention_days (lower)', () => {
    const narrowed = {
      ...baseRequest,
      data_policy: { ...baseRequest.data_policy, max_retention_days: 15 },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects expanded max_retention_days (higher)', () => {
    const expanded = {
      ...baseRequest,
      data_policy: { ...baseRequest.data_policy, max_retention_days: 60 },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects training_allowed=true when original is false', () => {
    const expanded = {
      ...baseRequest,
      data_policy: { ...baseRequest.data_policy, training_allowed: true },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows fewer tools (subset)', () => {
    const narrowed = {
      ...baseRequest,
      request: { ...baseRequest.request, tools: [] },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects different registry_snapshot_hash', () => {
    const modified = {
      ...baseRequest,
      registry_snapshot_hash: 'different-hash',
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-record original', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: null,
      candidate_payload: baseRequest,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects non-record candidate', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: null,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows requires_structured_output=true when original is false', () => {
    const expanded = {
      ...baseRequest,
      requires_structured_output: true,
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: expanded,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects requires_structured_output=false when original is true', () => {
    const baseWithStructured = { ...baseRequest, requires_structured_output: true };
    const narrowed = {
      ...baseRequest,
      requires_structured_output: false,
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseWithStructured,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows zero max_tokens', () => {
    const narrowed = {
      ...baseRequest,
      request: { ...baseRequest.request, max_tokens: 0 },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects zero max_retention_days when original is non-zero', () => {
    const narrowed = {
      ...baseRequest,
      data_policy: { ...baseRequest.data_policy, max_retention_days: 0 },
    };
    const result = policy.validate({
      event: 'before_provider_request',
      scope,
      original_payload: baseRequest,
      candidate_payload: narrowed,
    });
    expect(result.allowed).toBe(true);
  });
});

// --- Attenuation policy: pre_turn / session_before_compact ---

describe('Hook attenuation policy: pre_turn / session_before_compact', () => {
  const policy = createHarnessHookAttenuationPolicy();
  const payload = { messages: [{ role: 'user', content: 'test' }] };

  it('allows identical payload for pre_turn', () => {
    const result = policy.validate({
      event: 'pre_turn',
      scope,
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects modified payload for pre_turn', () => {
    const modified = { messages: [{ role: 'user', content: 'different' }] };
    const result = policy.validate({
      event: 'pre_turn',
      scope,
      original_payload: payload,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows identical payload for session_before_compact', () => {
    const result = policy.validate({
      event: 'session_before_compact',
      scope,
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects modified payload for session_before_compact', () => {
    const modified = { messages: [] };
    const result = policy.validate({
      event: 'session_before_compact',
      scope,
      original_payload: payload,
      candidate_payload: modified,
    });
    expect(result.allowed).toBe(false);
  });
});

// --- Attenuation policy: pre_tool_use (always allows) ---

describe('Hook attenuation policy: pre_tool_use', () => {
  const policy = createHarnessHookAttenuationPolicy();

  it('always allows pre_tool_use', () => {
    const result = policy.validate({
      event: 'pre_tool_use',
      scope,
      original_payload: { path: '/test' },
      candidate_payload: { path: '/different' },
    });
    expect(result.allowed).toBe(true);
  });
});

// --- Attenuation policy: other events (always denies) ---

describe('Hook attenuation policy: other events', () => {
  const policy = createHarnessHookAttenuationPolicy();

  it('denies unknown event', () => {
    const result = policy.validate({
      event: 'post_tool_use' as any,
      scope,
      original_payload: {},
      candidate_payload: {},
    });
    expect(result.allowed).toBe(false);
  });

  it('denies after_response', () => {
    const result = policy.validate({
      event: 'after_response' as any,
      scope,
      original_payload: {},
      candidate_payload: {},
    });
    expect(result.allowed).toBe(false);
  });
});

// --- HookRestrictionError ---

describe('HookRestrictionError', () => {
  it('creates with correct properties', () => {
    const error = new HookRestrictionError(
      'pre_tool_use',
      'deny',
      'tool_not_allowed',
    );
    expect(error.event).toBe('pre_tool_use');
    expect(error.action).toBe('deny');
    expect(error.reason_code).toBe('tool_not_allowed');
    expect(error.message).toBe('hook pre_tool_use deny: tool_not_allowed');
    expect(error.name).toBe('HookRestrictionError');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof HookRestrictionError).toBe(true);
  });

  it('is instanceof Error after rethrow', () => {
    const error = new HookRestrictionError('stop', 'skip', 'test');
    try {
      throw error;
    } catch (e) {
      expect(e instanceof HookRestrictionError).toBe(true);
      expect(e instanceof Error).toBe(true);
    }
  });
});

// --- dispatchHookBoundary with no port ---

describe('dispatchHookBoundary with no port', () => {
  it('returns continue with original payload when port is undefined', async () => {
    const request = makeRequest('user_prompt_submit', { goal: 'test' });
    const port: HookRuntimePort = { dispatch: vi.fn(async (req) => ({ event: req.event, action: "continue" as const, payload: req.payload, follow_ups: [], replayed: false })) };
    const result = await dispatchHookBoundary(port, request, {
      mode: 'decision',
    });
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ goal: 'test' });
  });

  it('returns continue for observational mode with no port', async () => {
    const request = makeRequest('post_turn', { data: 'test' });
    const port: HookRuntimePort = { dispatch: vi.fn(async (req) => ({ event: req.event, action: "continue" as const, payload: req.payload, follow_ups: [], replayed: false })) };
    const result = await dispatchHookBoundary(port, request, {
      mode: 'observational',
    });
    expect(result.action).toBe('continue');
  });
});

// --- dispatchHookBoundary with port returning continue ---

describe('dispatchHookBoundary with port returning continue', () => {
  it('returns continue when port returns continue with same payload', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async (req) => ({
        event: req.event,
        action: 'continue' as const,
        payload: req.payload,
        follow_ups: [],
        replayed: false,
      })),
    };
    const request = makeRequest('user_prompt_submit', { goal: 'test' });
    const result = await dispatchHookBoundary(port, request, {
      mode: 'decision',
    });
    expect(result.action).toBe('continue');
  });

  it('returns deny when port returns continue with different payload (attenuation fails)', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async (req) => ({
        event: req.event,
        action: 'continue' as const,
        payload: { goal: 'different' },
        follow_ups: [],
        replayed: false,
      })),
    };
    const request = makeRequest('user_prompt_submit', { goal: 'test' });
    const result = await dispatchHookBoundary(port, request, {
      mode: 'decision',
    });
    expect(result.action).toBe('deny');
  });

  it('returns deny when port returns deny', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async (req) => ({
        event: req.event,
        action: 'deny' as const,
        payload: req.payload,
        reason_code: 'test_deny',
        follow_ups: [],
        replayed: false,
      })),
    };
    const request = makeRequest('user_prompt_submit', { goal: 'test' });
    const result = await dispatchHookBoundary(port, request, {
      mode: 'decision',
    });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('test_deny');
  });
});

// --- dispatchHookBoundary with observational mode ---

describe('dispatchHookBoundary observational mode', () => {
  it('always returns continue for observational mode', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async (req) => ({
        event: req.event,
        action: 'deny' as const,
        payload: req.payload,
        reason_code: 'test',
        follow_ups: [],
        replayed: false,
      })),
    };
    const request = makeRequest('post_turn', { data: 'test' });
    const result = await dispatchHookBoundary(port, request, {
      mode: 'observational',
    });
    expect(result.action).toBe('continue');
  });
});

// --- dispatchHookBoundary with invalid port result ---

describe('dispatchHookBoundary invalid port result', () => {
  it('returns deny when port returns invalid result (missing fields)', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({ event: 'bad' }) as any),
    };
    const request = makeRequest('user_prompt_submit', { goal: 'test' });
    const result = await dispatchHookBoundary(port, request, {
      mode: 'decision',
    });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('invalid_hook_boundary_result');
  });

  it('returns continue for observational when port returns invalid result', async () => {
    const port: HookRuntimePort = {
      dispatch: vi.fn(async () => ({ event: 'bad' }) as any),
    };
    const request = makeRequest('post_turn', { data: 'test' });
    const result = await dispatchHookBoundary(port, request, {
      mode: 'observational',
    });
    expect(result.action).toBe('continue');
  });
});

// --- dispatchHookBoundary with aborted signal ---

describe('dispatchHookBoundary with aborted signal', () => {
  it('returns deny for decision mode when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = makeRequest('user_prompt_submit', { goal: 'test' }, controller.signal);
    const port: HookRuntimePort = { dispatch: vi.fn(async (req) => ({ event: req.event, action: "continue" as const, payload: req.payload, follow_ups: [], replayed: false })) };
    const result = await dispatchHookBoundary(port, request, {
      mode: 'decision',
    });
    expect(result.action).toBe('deny');
    expect(result.reason_code).toBe('hook_cancelled');
  });

  it('returns continue for observational mode when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = makeRequest('post_turn', { data: 'test' }, controller.signal);
    const port: HookRuntimePort = { dispatch: vi.fn(async (req) => ({ event: req.event, action: "continue" as const, payload: req.payload, follow_ups: [], replayed: false })) };
    const result = await dispatchHookBoundary(port, request, {
      mode: 'observational',
    });
    expect(result.action).toBe('continue');
  });
});

// Import vi for mocks
import { vi } from 'vitest';
