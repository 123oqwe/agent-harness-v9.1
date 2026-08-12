import { describe, it, expect } from 'vitest';
import {
  buildToolRejectionReceipt,
  buildToolCallIdentity,
  buildToolCallExecutionContext,
  buildFallbackOperationId,
  buildSkillActivationEvent,
  buildSkillActivationFailure,
} from '../../runtime/harness-support.js';

describe('harness-support-survival-4: buildToolRejectionReceipt', () => {
  it('returns frozen receipt with correct field names', () => {
    const receipt = buildToolRejectionReceipt(
      'read_file',
      { action: 'deny', reason_code: 'policy_violation' },
      '2024-01-01T00:00:00Z',
      'abc123',
    );
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt.tool_name).toBe('read_file');
    expect(receipt.timestamp).toBe('2024-01-01T00:00:00Z');
    expect(receipt.success).toBe(false);
    expect(receipt.error).toBe('hook_deny:policy_violation');
    expect(receipt.duration_ms).toBe(0);
    expect(receipt.input_hash).toBe('abc123');
  });

  it('builds error string from action and reason_code', () => {
    const r1 = buildToolRejectionReceipt('t', { action: 'skip', reason_code: 'timeout' }, 'ts', 'h');
    expect(r1.error).toBe('hook_skip:timeout');
    const r2 = buildToolRejectionReceipt('t', { action: 'force_prompt', reason_code: 'needs_approval' }, 'ts', 'h');
    expect(r2.error).toBe('hook_force_prompt:needs_approval');
  });

  it('has exactly 6 keys', () => {
    const receipt = buildToolRejectionReceipt('t', { action: 'deny', reason_code: 'r' }, 'ts', 'h');
    expect(Object.keys(receipt).sort()).toEqual(['duration_ms', 'error', 'input_hash', 'success', 'timestamp', 'tool_name']);
  });
});

describe('harness-support-survival-4: buildToolCallIdentity', () => {
  it('returns a 24-char hash', () => {
    const identity = buildToolCallIdentity('run1', 'step1', 'call1', 'read_file');
    expect(identity).toHaveLength(24);
  });

  it('returns different hashes for different inputs', () => {
    const a = buildToolCallIdentity('run1', 'step1', 'call1', 'read_file');
    const b = buildToolCallIdentity('run2', 'step1', 'call1', 'read_file');
    expect(a).not.toBe(b);
  });

  it('returns same hash for same inputs', () => {
    const a = buildToolCallIdentity('run1', 'step1', 'call1', 'read_file');
    const b = buildToolCallIdentity('run1', 'step1', 'call1', 'read_file');
    expect(a).toBe(b);
  });

  it('uses all 4 input fields in hash', () => {
    const base = buildToolCallIdentity('run1', 'step1', 'call1', 'read_file');
    const noRun = buildToolCallIdentity('different', 'step1', 'call1', 'read_file');
    const noStep = buildToolCallIdentity('run1', 'different', 'call1', 'read_file');
    const noCall = buildToolCallIdentity('run1', 'step1', 'different', 'read_file');
    const noTool = buildToolCallIdentity('run1', 'step1', 'call1', 'different');
    expect(base).not.toBe(noRun);
    expect(base).not.toBe(noStep);
    expect(base).not.toBe(noCall);
    expect(base).not.toBe(noTool);
  });
});

describe('harness-support-survival-4: buildToolCallExecutionContext', () => {
  const baseExecCtx = {
    tenant_id: 't1',
    user_id: 'u1',
    run_id: 'r1',
    plan_id: 'p1',
    confirmation_key_thumbprint: 'thumb1',
    budget: { token_limit: 1000, usd_micros: 5000 },
  };

  it('returns context with correct field values', () => {
    const ctx = buildToolCallExecutionContext(baseExecCtx, 'step1', 'ident123', 'input456', 0);
    expect(ctx.tenant_id).toBe('t1');
    expect(ctx.user_id).toBe('u1');
    expect(ctx.run_id).toBe('r1');
    expect(ctx.plan_id).toBe('p1');
    expect(ctx.step_id).toBe('step1');
    expect(ctx.attempt_id).toBe('attempt-ident123-0');
    expect(ctx.operation_id).toBe('operation-ident123');
    expect(ctx.idempotency_key).toBe('idempotency-ident123-input456');
    expect(ctx.confirmation_key_thumbprint).toBe('thumb1');
    expect(ctx.run_phase).toBe('agent');
    expect(ctx.budget.token_limit).toBe(1000);
    expect(ctx.budget.usd_micros).toBe(5000);
  });

  it('builds attempt_id with identity and attempt index', () => {
    const ctx = buildToolCallExecutionContext(baseExecCtx, 's', 'id', 'ih', 3);
    expect(ctx.attempt_id).toBe('attempt-id-3');
  });

  it('builds operation_id with identity only', () => {
    const ctx = buildToolCallExecutionContext(baseExecCtx, 's', 'myid', 'ih', 0);
    expect(ctx.operation_id).toBe('operation-myid');
  });

  it('builds idempotency_key with identity and input identity', () => {
    const ctx = buildToolCallExecutionContext(baseExecCtx, 's', 'myid', 'myinput', 0);
    expect(ctx.idempotency_key).toBe('idempotency-myid-myinput');
  });

  it('run_phase is always agent', () => {
    const ctx = buildToolCallExecutionContext(baseExecCtx, 's', 'id', 'ih', 0);
    expect(ctx.run_phase).toBe('agent');
  });

  it('has exactly 11 keys', () => {
    const ctx = buildToolCallExecutionContext(baseExecCtx, 's', 'id', 'ih', 0);
    expect(Object.keys(ctx).sort()).toEqual([
      'attempt_id', 'budget', 'confirmation_key_thumbprint', 'idempotency_key',
      'operation_id', 'plan_id', 'run_id', 'run_phase', 'step_id', 'tenant_id', 'user_id',
    ]);
  });
});

describe('harness-support-survival-4: buildFallbackOperationId', () => {
  it('builds fallback operation ID with attempt index', () => {
    expect(buildFallbackOperationId('op1', 0)).toBe('op1-fb0');
    expect(buildFallbackOperationId('op1', 1)).toBe('op1-fb1');
    expect(buildFallbackOperationId('op1', 4)).toBe('op1-fb4');
  });
});

describe('harness-support-survival-4: buildSkillActivationEvent', () => {
  it('returns event with correct fields', () => {
    const event = buildSkillActivationEvent('my_skill', '1.0.0');
    expect(event.event).toBe('skill_activated');
    expect(event.skill).toBe('my_skill');
    expect(event.version).toBe('1.0.0');
  });

  it('has exactly 3 keys', () => {
    const event = buildSkillActivationEvent('s', 'v');
    expect(Object.keys(event).sort()).toEqual(['event', 'skill', 'version']);
  });
});

describe('harness-support-survival-4: buildSkillActivationFailure', () => {
  it('returns failure record with correct fields', () => {
    const failure = buildSkillActivationFailure('my_skill', new Error('activation failed'));
    expect(failure.reason).toBe('skill_activation_failed');
    expect(failure.skill).toBe('my_skill');
    expect(failure.error).toBe('activation failed');
  });

  it('has exactly 3 keys', () => {
    const failure = buildSkillActivationFailure('s', 'e');
    expect(Object.keys(failure).sort()).toEqual(['error', 'reason', 'skill']);
  });
});
