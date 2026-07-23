import { describe, it, expect, beforeEach } from 'vitest';
import {
  CapabilityService,
  type CapabilityIssueRequest,
  type CapabilityContext,
} from '../../security/capability.js';

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

describe('AH-CAPABILITY-001: capability issue', () => {
  let svc: CapabilityService;

  beforeEach(() => {
    svc = new CapabilityService();
  });

  it('issues a valid single-use capability token', () => {
    const token = svc.issue(issueReq(), ctx());
    expect(token.token_id).toBeTruthy();
    expect(token.use_limit).toBe(1);
    expect(token.operation_id).toBe('op-001');
    expect(token.manifest_hash).toBe('a'.repeat(64));
    expect(token.expires_at).toBeTruthy();
    expect(token.issued_at).toBeTruthy();
  });

  it('token_id is a unique UUID per issue', () => {
    const t1 = svc.issue(issueReq(), ctx());
    const t2 = svc.issue(issueReq(), ctx());
    expect(t1.token_id).not.toBe(t2.token_id);
  });

  it('not_before is set to issued_at by default', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const token = svc.issue(issueReq(), ctx(now));
    expect(token.not_before).toBe(token.issued_at);
  });

  it('expires_at is issued_at + ttl_seconds', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const token = svc.issue(issueReq({ ttl_seconds: 120 }), ctx(now));
    const expected = new Date(now.getTime() + 120_000).toISOString();
    expect(token.expires_at).toBe(expected);
  });

  it('binds token to run_id, step_id, attempt_id from context', () => {
    const token = svc.issue(issueReq(), ctx());
    // The token should be bound to the context - verify via verify()
    expect(svc.verify(token, ctx())).toBe(true);
  });

  it('rejects verification when run_id mismatches', () => {
    const token = svc.issue(issueReq(), ctx());
    const wrongCtx = { ...ctx(), run_id: 'wrong-run' };
    expect(svc.verify(token, wrongCtx)).toBe(false);
  });

  it('rejects verification when step_id mismatches', () => {
    const token = svc.issue(issueReq(), ctx());
    const wrongCtx = { ...ctx(), step_id: 'wrong-step' };
    expect(svc.verify(token, wrongCtx)).toBe(false);
  });

  it('rejects verification when attempt_id mismatches', () => {
    const token = svc.issue(issueReq(), ctx());
    const wrongCtx = { ...ctx(), attempt_id: 'wrong-attempt' };
    expect(svc.verify(token, wrongCtx)).toBe(false);
  });

  it('rejects verification when tenant_id mismatches', () => {
    const token = svc.issue(issueReq(), ctx());
    const wrongCtx = { ...ctx(), tenant_id: 'wrong-tenant' };
    expect(svc.verify(token, wrongCtx)).toBe(false);
  });
});

describe('AH-CAPABILITY-001: single-use enforcement', () => {
  let svc: CapabilityService;

  beforeEach(() => {
    svc = new CapabilityService();
  });

  it('first consume succeeds', () => {
    const token = svc.issue(issueReq(), ctx());
    expect(svc.consume(token, ctx())).toBe(true);
  });

  it('second consume of same token fails (replay prevention)', () => {
    const token = svc.issue(issueReq(), ctx());
    expect(svc.consume(token, ctx())).toBe(true);
    expect(svc.consume(token, ctx())).toBe(false);
  });

  it('isUsed returns true after consume', () => {
    const token = svc.issue(issueReq(), ctx());
    expect(svc.isUsed(token.token_id)).toBe(false);
    svc.consume(token, ctx());
    expect(svc.isUsed(token.token_id)).toBe(true);
  });

  it('verify still returns true after consume (verify is read-only)', () => {
    const token = svc.issue(issueReq(), ctx());
    svc.consume(token, ctx());
    // verify doesn't consume, but the token is marked used
    expect(svc.verify(token, ctx())).toBe(true);
  });

  it('consume fails for expired token', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const token = svc.issue(issueReq({ ttl_seconds: 1 }), ctx(now));
    const later = new Date('2026-01-01T00:05:00Z');
    expect(svc.consume(token, { ...ctx(), now: later })).toBe(false);
  });

  it('consume fails for not-yet-valid token', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const token = svc.issue(issueReq({ ttl_seconds: 60 }), ctx(now));
    const earlier = new Date('2025-12-31T23:00:00Z');
    // The token was issued at now, but we check at an earlier time
    // not_before is set to issued_at, so earlier time should fail
    expect(svc.consume(token, { ...ctx(), now: earlier })).toBe(false);
  });
});

describe('AH-CAPABILITY-001: revocation', () => {
  let svc: CapabilityService;

  beforeEach(() => {
    svc = new CapabilityService();
  });

  it('revoked token cannot be consumed', () => {
    const token = svc.issue(issueReq(), ctx());
    svc.revoke(token.token_id);
    expect(svc.consume(token, ctx())).toBe(false);
  });

  it('isRevoked returns true after revocation', () => {
    const token = svc.issue(issueReq(), ctx());
    svc.revoke(token.token_id);
    expect(svc.isRevoked(token.token_id)).toBe(true);
  });

  it('revoking a non-existent token is a no-op', () => {
    expect(() => svc.revoke('nonexistent-id')).not.toThrow();
  });
});

describe('AH-CAPABILITY-001: child capability attenuation', () => {
  let svc: CapabilityService;

  beforeEach(() => {
    svc = new CapabilityService();
  });

  it('child token has subset scope of parent', () => {
    const parent = svc.issue(issueReq({
      tool_grant_hash: 'shared-tool-hash'.padEnd(64, '0'),
    }), ctx());

    const childReq: CapabilityIssueRequest = {
      ...issueReq(),
      tool_grant_hash: 'shared-tool-hash'.padEnd(64, '0'),
      parent_token_id: parent.token_id,
    };
    const child = svc.issue(childReq, ctx());
    expect(child.parent_delegation_proof).toBeTruthy();
  });

  it('child cannot expand tool grants beyond parent', () => {
    const parent = svc.issue(issueReq({
      tool_grant_hash: 'a'.repeat(64),
    }), ctx());

    // Child tries to use a different tool grant hash (expansion attempt)
    const childReq: CapabilityIssueRequest = {
      ...issueReq(),
      tool_grant_hash: 'b'.repeat(64), // different from parent
      parent_token_id: parent.token_id,
    };
    // This should be rejected - child must have subset of parent's grants
    expect(() => svc.issue(childReq, ctx())).toThrow(/attenuation|subset|exceed/i);
  });

  it('child cannot extend lifetime beyond parent', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const parent = svc.issue(issueReq({ ttl_seconds: 60 }), ctx(now));

    const childReq: CapabilityIssueRequest = {
      ...issueReq(),
      ttl_seconds: 120, // longer than parent's 60
      parent_token_id: parent.token_id,
    };
    expect(() => svc.issue(childReq, ctx(now))).toThrow(/lifetime|exceed/i);
  });

  it('child of a used parent cannot be issued', () => {
    const parent = svc.issue(issueReq(), ctx());
    svc.consume(parent, ctx());

    const childReq: CapabilityIssueRequest = {
      ...issueReq(),
      parent_token_id: parent.token_id,
    };
    expect(() => svc.issue(childReq, ctx())).toThrow(/used|consumed|invalid/i);
  });

  it('child of a revoked parent cannot be issued', () => {
    const parent = svc.issue(issueReq(), ctx());
    svc.revoke(parent.token_id);

    const childReq: CapabilityIssueRequest = {
      ...issueReq(),
      parent_token_id: parent.token_id,
    };
    expect(() => svc.issue(childReq, ctx())).toThrow(/revoked/i);
  });
});

describe('AH-CAPABILITY-001: malformed token rejection', () => {
  let svc: CapabilityService;

  beforeEach(() => {
    svc = new CapabilityService();
  });

  it('rejects token with use_limit != 1', () => {
    const token = svc.issue(issueReq(), ctx());
    const tampered = { ...token, use_limit: 5 as 1 };
    expect(svc.verify(tampered, ctx())).toBe(false);
  });

  it('rejects token with missing required field', () => {
    const token = svc.issue(issueReq(), ctx());
    const tampered = { ...token } as Partial<typeof token>;
    delete (tampered as Record<string, unknown>).manifest_hash;
    expect(svc.verify(tampered as typeof token, ctx())).toBe(false);
  });

  it('rejects token with tampered manifest_hash', () => {
    const token = svc.issue(issueReq(), ctx());
    const tampered = { ...token, manifest_hash: 'z'.repeat(64) };
    // The token's internal hash should not match the tampered hash
    expect(svc.verify(tampered, ctx())).toBe(false);
  });
});
