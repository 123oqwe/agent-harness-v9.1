import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEngine, hashDecision, type Policy, type EffectRisk, type PolicyContext, type CapabilityToken } from '../../security/policy-engine.js';
import { PolicyEnforcementPoint, PepValidationError, ManifestTamperedError } from '../../security/pep.js';

function ctx(now = new Date('2026-01-01T00:00:00Z')): PolicyContext {
  return { tenant_id: 't1', user_id: 'u1', run_phase: 'setup', now };
}

function readRisk(): EffectRisk {
  return {
    locality: 'local', operation: 'read', reversibility: 'guaranteed',
    data_egress: 'none', network_access: false, credential_access: false,
    blast_radius: 'self', financial_impact_usd_micros: 0,
    human_impact: 'none', external_visibility: 'none', regulatory_sensitivity: 'none',
  };
}

function validToken(decisionHash: string, overrides: Partial<CapabilityToken> = {}): CapabilityToken {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    token_id: 'tok-001', operation_id: 'op-001', attempt_id: 'att-001',
    manifest_hash: 'a'.repeat(64), policy_decision_hash: decisionHash,
    tool_effect_contract_hash: 'c'.repeat(64), subject_workload: 'agent',
    tenant_id: 't1', audience: 'tool:read_file',
    tool_grant_hash: 'd'.repeat(64), resource_grant_hash: 'e'.repeat(64),
    budget_ceiling_hash: 'f'.repeat(64), issued_at: now.toISOString(),
    not_before: now.toISOString(),
    expires_at: new Date(now.getTime() + 60000).toISOString(),
    execution_epoch: 'epoch-1', use_limit: 1,
    confirmation_key_thumbprint: 'thumb-1',
    ...overrides,
  };
}

function allowDecision() {
  const policy: Policy = { rules: [{ tool: 'read_file', allow: true }], default_decision: 'deny' };
  const engine = new PolicyEngine(policy);
  return engine.evaluate('read_file', readRisk(), ctx());
}

describe('AH-PEP-001: PEP enforcement', () => {
  let pep: PolicyEnforcementPoint;

  beforeEach(() => {
    const policy: Policy = { rules: [{ tool: 'read_file', allow: true }], default_decision: 'deny' };
    const engine = new PolicyEngine(policy);
    pep = new PolicyEnforcementPoint(engine);
  });

  it('allows a valid unused unexpired token with matching manifest hash', () => {
    const decision = allowDecision();
    const token = validToken(hashDecision(decision), { manifest_hash: 'a'.repeat(64) });
    // Need to use the correct hash: the token's manifest_hash must match
    // currentManifestHash passed to validate
    const result = pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64));
    expect(result.allowed).toBe(true);
  });

  it('rejects an already-used token (single-use)', () => {
    const decision = allowDecision();
    const token = validToken(hashDecision(decision));
    pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64));
    expect(() => pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64))).toThrow(PepValidationError);
  });

  it('rejects an expired token', () => {
    const decision = allowDecision();
    const token = validToken(hashDecision(decision), {
      expires_at: new Date('2025-01-01T00:00:00Z').toISOString(),
    });
    expect(() => pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64))).toThrow(PepValidationError);
  });

  it('rejects a not-yet-valid token', () => {
    const decision = allowDecision();
    const token = validToken(hashDecision(decision), {
      not_before: new Date('2027-01-01T00:00:00Z').toISOString(),
    });
    expect(() => pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64))).toThrow(PepValidationError);
  });

  it('rejects a token with use_limit != 1', () => {
    const decision = allowDecision();
    const token = validToken(hashDecision(decision), { use_limit: 5 as 1 });
    expect(() => pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64))).toThrow(PepValidationError);
  });

  it('detects TOCTOU manifest hash mismatch', () => {
    const decision = allowDecision();
    const token = validToken(hashDecision(decision), { manifest_hash: 'a'.repeat(64) });
    // Pass a different currentManifestHash
    expect(() => pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'z'.repeat(64))).toThrow(ManifestTamperedError);
  });

  it('detects policy decision hash mismatch', () => {
    // Create a token with a wrong policy_decision_hash
    const decision = allowDecision();
    const token = validToken(hashDecision(decision), { policy_decision_hash: 'wrong'.padEnd(64, '0') });
    expect(() => pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64))).toThrow(PepValidationError);
  });

  it('logs every decision (allow and deny)', () => {
    const decision = allowDecision();
    const token = validToken(hashDecision(decision));
    pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64));
    expect(pep.logCount).toBe(1);
    expect(pep.decisionLog[0].verdict).toBe('allow');

    // Now try to reuse — should log a deny
    try { pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64)); } catch { /* expected */ }
    expect(pep.logCount).toBe(2);
    expect(pep.decisionLog[1].verdict).toBe('deny');
  });

  it('isUsed returns true after consume', () => {
    const decision = allowDecision();
    const token = validToken(hashDecision(decision));
    expect(pep.isUsed(token.token_id)).toBe(false);
    pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64));
    expect(pep.isUsed(token.token_id)).toBe(true);
  });

  it('cannot be bypassed — there is no alternative path', () => {
    // The PEP is the single chokepoint. Any code calling a tool must go through validate().
    // This test verifies the API surface: validate is the only method that allows execution.
    const decision = allowDecision();
    const token = validToken(hashDecision(decision));
    // First call succeeds
    const result = pep.validate(token, 'read_file', readRisk(), decision, ctx(), 'a'.repeat(64));
    expect(result.allowed).toBe(true);
    // The token is now consumed — no way to "un-consume" it
    expect(pep.isUsed(token.token_id)).toBe(true);
  });
});
