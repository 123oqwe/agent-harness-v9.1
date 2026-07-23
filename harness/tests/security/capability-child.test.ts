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

describe('AH-CAPABILITY-001: child capability deep attenuation', () => {
  let svc: CapabilityService;

  beforeEach(() => {
    svc = new CapabilityService();
  });

  it('grandchild can be issued from child (multi-level delegation)', () => {
    const parent = svc.issue(issueReq(), ctx());
    const child = svc.issue({ ...issueReq(), parent_token_id: parent.token_id }, ctx());
    const grandchild = svc.issue({ ...issueReq(), parent_token_id: child.token_id }, ctx());
    expect(grandchild.parent_delegation_proof).toBeTruthy();
    expect(svc.consume(grandchild, ctx())).toBe(true);
  });

  it('child with same grants as parent is valid (equal is subset)', () => {
    const parent = svc.issue(issueReq({
      tool_grant_hash: 'd'.repeat(64),
      resource_grant_hash: 'e'.repeat(64),
    }), ctx());
    const child = svc.issue({
      ...issueReq({
        tool_grant_hash: 'd'.repeat(64),
        resource_grant_hash: 'e'.repeat(64),
      }),
      parent_token_id: parent.token_id,
    }, ctx());
    expect(child.token_id).toBeTruthy();
  });

  it('child with same resource grants as parent is valid (attenuation)', () => {
    const parent = svc.issue(issueReq({
      resource_grant_hash: 'shared-resources'.padEnd(64, '0'),
    }), ctx());
    // Child inherits same grants (attenuation: same or narrower scope)
    const child = svc.issue({
      ...issueReq({
        resource_grant_hash: 'shared-resources'.padEnd(64, '0'),
      }),
      parent_token_id: parent.token_id,
    }, ctx());
    expect(child.token_id).toBeTruthy();
  });

  it('child delegation depth is tracked', () => {
    const parent = svc.issue(issueReq(), ctx());
    const child = svc.issue({ ...issueReq(), parent_token_id: parent.token_id }, ctx());
    // The service should track delegation depth
    expect(svc.getDelegationDepth(child.token_id)).toBeGreaterThan(svc.getDelegationDepth(parent.token_id));
  });

  it('max delegation depth is enforced', () => {
    svc = new CapabilityService({ maxDelegationDepth: 2 });
    const p = svc.issue(issueReq(), ctx());
    const c1 = svc.issue({ ...issueReq(), parent_token_id: p.token_id }, ctx());
    const c2 = svc.issue({ ...issueReq(), parent_token_id: c1.token_id }, ctx());
    // c2 is depth 2, which is the max
    expect(() => svc.issue({ ...issueReq(), parent_token_id: c2.token_id }, ctx())).toThrow(/depth|exceed/i);
  });
});
