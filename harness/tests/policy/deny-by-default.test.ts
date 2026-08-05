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

describe('AH-POLICY-ENGINE-001: audit logging (P1-14)', () => {
  it('records every policy evaluation in the audit log', () => {
    const policy: Policy = {
      rules: [{ tool: 'read_file', allow: true }, { tool: 'delete_file', allow: false }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);

    engine.evaluate('read_file', readRisk(), ctx());
    engine.evaluate('delete_file', { ...readRisk(), operation: 'delete' }, ctx());
    engine.evaluate('unknown_tool', readRisk(), ctx());

    const log = engine.getAuditLog();
    expect(log.length).toBe(3);
    expect(log[0].tool_name).toBe('read_file');
    expect(log[0].verdict).toBe('allow');
    expect(log[1].tool_name).toBe('delete_file');
    expect(log[1].verdict).toBe('deny');
    expect(log[2].tool_name).toBe('unknown_tool');
    expect(log[2].verdict).toBe('deny');
  });

  it('audit entries contain timestamp, tool_name, verdict, tier, tenant, user', () => {
    const policy: Policy = {
      rules: [{ tool: 'read_file', allow: true }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    engine.evaluate('read_file', readRisk(), ctx());

    const entry = engine.getAuditLog()[0];
    expect(entry.timestamp).toBeDefined();
    expect(entry.tool_name).toBe('read_file');
    expect(entry.action_type).toBe('read');
    expect(entry.verdict).toBe('allow');
    expect(entry.derived_risk_tier).toBe(0);
    expect(entry.tenant_id).toBe('t1');
    expect(entry.user_id).toBe('u1');
    expect(entry.reasons.length).toBeGreaterThan(0);
  });

  it('audit log is immutable (returns a copy)', () => {
    const policy: Policy = {
      rules: [{ tool: 'read_file', allow: true }],
      default_decision: 'deny',
    };
    const engine = new PolicyEngine(policy);
    engine.evaluate('read_file', readRisk(), ctx());

    const log1 = engine.getAuditLog();
    const log2 = engine.getAuditLog();
    expect(log1).not.toBe(log2); // different array references
    expect(log1.length).toBe(log2.length);
  });
});
