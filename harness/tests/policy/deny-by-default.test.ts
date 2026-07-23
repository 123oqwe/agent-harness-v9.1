import { describe, it, expect } from 'vitest';
import {
  PolicyEngine,
  type Policy,
  type EffectRisk,
  type PolicyContext,
} from '../../security/policy-engine.js';

function ctx(now = new Date('2026-01-01T00:00:00Z')): PolicyContext {
  return { tenant_id: 't1', user_id: 'u1', run_phase: 'setup', now };
}

function readRisk(): EffectRisk {
  return {
    locality: 'local',
    operation: 'read',
    reversibility: 'guaranteed',
    data_egress: 'none',
    network_access: false,
    credential_access: false,
    blast_radius: 'self',
    financial_impact_usd_micros: 0,
    human_impact: 'none',
    external_visibility: 'none',
    regulatory_sensitivity: 'none',
  };
}

describe('AH-POLICY-ENGINE-001: deny-by-default', () => {
  it('denies when no rule matches (default deny)', () => {
    const policy: Policy = { rules: [], default_decision: 'deny' };
    const engine = new PolicyEngine(policy);
    const d = engine.evaluate('read_file', readRisk(), ctx());
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toContain('deny by default');
  });

  it('denies when rule has allow: false', () => {
    const policy: Policy = {
      rules: [{ tool: 'delete_file', allow: false }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    const d = engine.evaluate('delete_file', readRisk(), ctx());
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toContain('explicitly denies');
  });

  it('allows when explicit allow rule matches', () => {
    const policy: Policy = {
      rules: [{ tool: 'read_file', allow: true }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    const d = engine.evaluate('read_file', readRisk(), ctx());
    expect(d.allowed).toBe(true);
  });

  it('wildcard rule matches any tool', () => {
    const policy: Policy = {
      rules: [{ tool: '*', allow: true }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    expect(engine.evaluate('anything', readRisk(), ctx()).allowed).toBe(true);
  });

  it('first matching rule wins (specific before wildcard)', () => {
    const policy: Policy = {
      rules: [
        { tool: 'delete_file', allow: false },
        { tool: '*', allow: true },
      ],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    expect(engine.evaluate('delete_file', readRisk(), ctx()).allowed).toBe(false);
    expect(engine.evaluate('read_file', readRisk(), ctx()).allowed).toBe(true);
  });

  it('rejects policy with default_decision: allow at construction', () => {
    const badPolicy: Policy = { rules: [], default_decision: 'allow' };
    expect(() => new PolicyEngine(badPolicy)).toThrow(/deny-by-default/);
  });

  it('denies when derived risk tier exceeds rule max_tier', () => {
    const policy: Policy = {
      rules: [{ tool: 'exec', allow: true, max_tier: 1 }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    const highRisk: EffectRisk = {
      ...readRisk(),
      operation: 'execute',
      reversibility: 'none',
      blast_radius: 'global',
    };
    const d = engine.evaluate('exec', highRisk, ctx());
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toContain('exceeds max_tier');
  });

  it('allows when derived risk tier is within rule max_tier', () => {
    const policy: Policy = {
      rules: [{ tool: 'read_file', allow: true, max_tier: 3 }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    const d = engine.evaluate('read_file', readRisk(), ctx());
    expect(d.allowed).toBe(true);
    expect(d.derived_risk_tier).toBeLessThanOrEqual(3);
  });

  it('policy rules are immutable (cannot mutate after construction)', () => {
    const policy: Policy = {
      rules: [{ tool: 'read_file', allow: true }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    // Try to mutate the original rules array
    policy.rules.push({ tool: 'evil', allow: true });
    // Engine should still only have the original rule
    expect(engine.rules.length).toBe(1);
    expect(engine.evaluate('evil', readRisk(), ctx()).allowed).toBe(false);
  });
});
