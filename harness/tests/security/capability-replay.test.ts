import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityService, type CapabilityIssueRequest, type CapabilityContext } from '../../security/capability.js';

function ctx(now = new Date('2026-01-01T00:00:00Z')): CapabilityContext {
  return {
    run_id: 'run-001',
    step_id: 'step-001',
    attempt_id: 'attempt-001',
    tenant_id: 'tenant-001',
    subject: 'agent-001',
    execution_epoch: 'epoch-001',
    policy_version: 'v1',
    now,
  };
}

function issueReq(overrides: Partial<CapabilityIssueRequest> = {}): CapabilityIssueRequest {
  return {
    operation_id: 'op-001',
    manifest_hash: 'a'.repeat(64),
    policy_decision_hash: 'b'.repeat(64),
    tool_effect_contract_hash: 'c'.repeat(64),
    tool_grant_hash: 'd'.repeat(64),
    resource_grant_hash: 'e'.repeat(64),
    budget_ceiling_hash: 'f'.repeat(64),
    confirmation_key_thumbprint: 'thumbprint-001',
    audience: 'tool:read_file',
    ttl_seconds: 60,
    ...overrides,
  };
}

describe('AH-CAPABILITY-001: replay prevention', () => {
  let svc: CapabilityService;

  beforeEach(() => {
    svc = new CapabilityService();
  });

  it('capability replay count starts at 0', () => {
    expect(svc.replayAttempts).toBe(0);
  });

  it('consuming the same token twice increments replay counter', () => {
    const token = svc.issue(issueReq(), ctx());
    svc.consume(token, ctx());
    svc.consume(token, ctx());
    expect(svc.replayAttempts).toBe(1);
  });

  it('multiple replays are all counted', () => {
    const token = svc.issue(issueReq(), ctx());
    svc.consume(token, ctx());
    svc.consume(token, ctx());
    svc.consume(token, ctx());
    svc.consume(token, ctx());
    expect(svc.replayAttempts).toBe(3);
  });

  it('different tokens do not count as replays', () => {
    const t1 = svc.issue(issueReq(), ctx());
    const t2 = svc.issue(issueReq(), ctx());
    svc.consume(t1, ctx());
    svc.consume(t2, ctx());
    expect(svc.replayAttempts).toBe(0);
  });

  it('expired token consume does not count as replay', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const token = svc.issue(issueReq({ ttl_seconds: 1 }), ctx(now));
    const later = new Date('2026-01-01T00:05:00Z');
    svc.consume(token, { ...ctx(), now: later });
    expect(svc.replayAttempts).toBe(0);
  });

  it('revoked token consume does not count as replay', () => {
    const token = svc.issue(issueReq(), ctx());
    svc.revoke(token.token_id);
    svc.consume(token, ctx());
    expect(svc.replayAttempts).toBe(0);
  });

  it('context-mismatched token consume does not count as replay', () => {
    const token = svc.issue(issueReq(), ctx());
    const wrongCtx = { ...ctx(), run_id: 'wrong' };
    svc.consume(token, wrongCtx);
    expect(svc.replayAttempts).toBe(0);
  });
});
