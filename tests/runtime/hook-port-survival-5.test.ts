import { describe, it, expect } from 'vitest';
import { createHarnessHookAttenuationPolicy } from '../../runtime/hook-port.js';

const policy = createHarnessHookAttenuationPolicy();

function makeScope() {
  return { tenant_id: 't1', run_id: 'r1', session_id: 's1', operation_id: 'o1', attempt_id: 'a1' };
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

// L248-290: providerRequestNarrows - capability validation paths
describe('hook-port-survival-5: provider request capability validation (L248-290)', () => {
  it('rejects when original is not a record', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: null,
      candidate_payload: makeProviderPayload(),
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate is not a record', () => {
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: makeProviderPayload(),
      candidate_payload: 'not-object',
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when keys differ between original and candidate', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({ extra_field: true });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when registry_snapshot_hash differs', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({ registry_snapshot_hash: 'hash2' });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when estimated_input_tokens differs', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({ estimated_input_tokens: 200 });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate capabilities are not a superset of original', () => {
    const original = makeProviderPayload({ required_capabilities: ['text_reasoning', 'vision'] });
    const candidate = makeProviderPayload({ required_capabilities: ['text_reasoning'] });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows when candidate capabilities are a superset of original', () => {
    const original = makeProviderPayload({ required_capabilities: ['text_reasoning'] });
    const candidate = makeProviderPayload({ required_capabilities: ['text_reasoning', 'vision'] });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when original requires_structured_output is true but candidate is false', () => {
    const original = makeProviderPayload({ requires_structured_output: true });
    const candidate = makeProviderPayload({ requires_structured_output: false });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows when both requires_structured_output are true', () => {
    const original = makeProviderPayload({ requires_structured_output: true });
    const candidate = makeProviderPayload({ requires_structured_output: true });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when original requires_structured_output is not boolean', () => {
    const original = makeProviderPayload({ requires_structured_output: 'yes' });
    const candidate = makeProviderPayload();
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });
});

// L290-367: provider request - data policy and tool validation
describe('hook-port-survival-5: provider request data policy and tools (L290-367)', () => {
  it('rejects when candidate max_tokens exceeds original', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 2000 },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows when candidate max_tokens is less than original', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 500 },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when candidate adds tools not in original', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }, { name: 'write_file' }], max_tokens: 1000 },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate local_only is false but original is true', () => {
    const original = makeProviderPayload({
      data_policy: { local_only: true, allowed_regions: [], max_retention_days: 30, training_allowed: false },
    });
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: [], max_retention_days: 30, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate training_allowed is true but original is false', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: true },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate max_retention_days exceeds original', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 60, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate allowed_regions are not a subset of original', () => {
    const original = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
    });
    const candidate = makeProviderPayload({
      data_policy: { local_only: false, allowed_regions: ['us', 'eu'], max_retention_days: 30, training_allowed: false },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when policy keys differ', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [], extra_key: true },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when run_plan keys differ', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [], extra: true },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows identical provider payloads', () => {
    const payload = makeProviderPayload();
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: payload,
      candidate_payload: payload,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows when candidate removes tools (subset)', () => {
    const original = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }, { name: 'write_file' }], max_tokens: 1000 },
    });
    const candidate = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1000 },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(true);
  });

  it('rejects when original data_policy is not a record', () => {
    const original = makeProviderPayload({ data_policy: 'invalid' });
    const candidate = makeProviderPayload();
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when original policy is not a record', () => {
    const original = makeProviderPayload({ policy: null });
    const candidate = makeProviderPayload();
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when original run_plan is not a record', () => {
    const original = makeProviderPayload({ run_plan: 42 });
    const candidate = makeProviderPayload();
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when original request is not a record', () => {
    const original = makeProviderPayload({ request: 'invalid' });
    const candidate = makeProviderPayload();
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when original max_tokens is not a safe integer', () => {
    const original = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: 1.5 },
    });
    const candidate = makeProviderPayload();
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });

  it('rejects when candidate max_tokens is negative', () => {
    const original = makeProviderPayload();
    const candidate = makeProviderPayload({
      request: { messages: [], tools: [{ name: 'read_file' }], max_tokens: -1 },
    });
    const result = policy.validate({
      event: 'before_provider_request',
      scope: makeScope(),
      original_payload: original,
      candidate_payload: candidate,
    });
    expect(result.allowed).toBe(false);
  });
});
