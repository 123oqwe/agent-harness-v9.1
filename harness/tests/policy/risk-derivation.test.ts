import { describe, it, expect } from 'vitest';
import {
  deriveRiskTier,
  resolveEgress,
  isHostAllowed,
  hostMatches,
  type EffectRisk,
  type EgressPolicy,
  type PolicyContext,
  type Policy,
} from '../../security/policy-engine.js';

function ctx(): PolicyContext {
  return { tenant_id: 't1', user_id: 'u1', run_phase: 'setup', now: new Date('2026-01-01T00:00:00Z') };
}
const emptyPolicy: Policy = { rules: [], default_decision: 'deny' };

function baseRisk(overrides: Partial<EffectRisk> = {}): EffectRisk {
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
    ...overrides,
  };
}

describe('AH-POLICY-ENGINE-001: risk tier derivation', () => {
  it('safe read = tier 0', () => {
    expect(deriveRiskTier(baseRisk(), emptyPolicy, ctx())).toBe(0);
  });

  it('local write = tier 2', () => {
    expect(deriveRiskTier(baseRisk({ operation: 'write' }), emptyPolicy, ctx())).toBe(2);
  });

  it('irreversible delete = high tier', () => {
    const r = baseRisk({
      operation: 'delete',
      reversibility: 'none',
      blast_radius: 'global',
    });
    expect(deriveRiskTier(r, emptyPolicy, ctx())).toBeGreaterThanOrEqual(4);
  });

  it('external publish with sensitive egress = high tier', () => {
    const r = baseRisk({
      locality: 'external',
      operation: 'publish',
      reversibility: 'none',
      data_egress: 'sensitive',
      human_impact: 'public',
    });
    expect(deriveRiskTier(r, emptyPolicy, ctx())).toBe(5);
  });

  it('tier is capped at 5', () => {
    const r = baseRisk({
      locality: 'external',
      operation: 'purchase',
      reversibility: 'none',
      data_egress: 'sensitive',
      credential_access: true,
      blast_radius: 'global',
      financial_impact_usd_micros: 10_000_000,
      human_impact: 'public',
      external_visibility: 'notifiable',
      regulatory_sensitivity: 'children',
    });
    expect(deriveRiskTier(r, emptyPolicy, ctx())).toBe(5);
  });

  it('financial impact thresholds: $0.01 = +1, $1+ = +3', () => {
    const penny = baseRisk({ financial_impact_usd_micros: 10_000 });
    const dollar = baseRisk({ financial_impact_usd_micros: 1_000_000 });
    expect(deriveRiskTier(penny, emptyPolicy, ctx())).toBe(1);
    expect(deriveRiskTier(dollar, emptyPolicy, ctx())).toBe(3);
  });

  it('regulatory: children > health > pii/financial > none', () => {
    expect(deriveRiskTier(baseRisk({ regulatory_sensitivity: 'children' }), emptyPolicy, ctx())).toBe(3);
    expect(deriveRiskTier(baseRisk({ regulatory_sensitivity: 'health' }), emptyPolicy, ctx())).toBe(2);
    expect(deriveRiskTier(baseRisk({ regulatory_sensitivity: 'pii' }), emptyPolicy, ctx())).toBe(1);
  });
});

describe('AH-POLICY-ENGINE-001: egress resolution', () => {
  it('returns undefined when neither side defines egress', () => {
    expect(resolveEgress(undefined, undefined)).toBeUndefined();
  });

  it('returns risk egress when rule has none', () => {
    const e: EgressPolicy = { mode: 'allowlist', domain_rules: [{ action: 'allow', host: 'api.example.com' }] };
    expect(resolveEgress(e, undefined)).toEqual(e);
  });

  it('stricter mode wins: disabled > allowlist', () => {
    const result = resolveEgress(
      { mode: 'disabled' },
      { mode: 'allowlist', domain_rules: [{ action: 'allow', host: 'x.com' }] },
    );
    expect(result?.mode).toBe('disabled');
  });

  it('deny rules from both sides are unioned', () => {
    const result = resolveEgress(
      { mode: 'open', domain_rules: [{ action: 'deny', host: 'evil.com' }] },
      { mode: 'open', domain_rules: [{ action: 'deny', host: 'bad.com' }] },
    );
    const denyHosts = result?.domain_rules?.filter((r) => r.action === 'deny').map((r) => r.host);
    expect(denyHosts).toContain('evil.com');
    expect(denyHosts).toContain('bad.com');
  });
});

describe('AH-POLICY-ENGINE-001: host matching', () => {
  it('exact match', () => {
    expect(hostMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(hostMatches('other.com', 'api.example.com')).toBe(false);
  });

  it('global wildcard *', () => {
    expect(hostMatches('anything.com', '*')).toBe(true);
  });

  it('scoped wildcard *.example.com', () => {
    expect(hostMatches('sub.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('deep.sub.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(true);
    expect(hostMatches('other.com', '*.example.com')).toBe(false);
  });
});

describe('AH-POLICY-ENGINE-001: isHostAllowed', () => {
  it('disabled mode blocks everything', () => {
    expect(isHostAllowed('any.com', { mode: 'disabled' })).toBe(false);
  });

  it('open mode allows everything not explicitly denied', () => {
    expect(isHostAllowed('any.com', { mode: 'open' })).toBe(true);
    expect(isHostAllowed('evil.com', { mode: 'open', domain_rules: [{ action: 'deny', host: 'evil.com' }] })).toBe(false);
  });

  it('allowlist mode requires explicit allow', () => {
    const e: EgressPolicy = {
      mode: 'allowlist',
      domain_rules: [
        { action: 'allow', host: '*.api.com' },
        { action: 'deny', host: 'bad.api.com' },
      ],
    };
    expect(isHostAllowed('good.api.com', e)).toBe(true);
    expect(isHostAllowed('bad.api.com', e)).toBe(false); // deny wins
    expect(isHostAllowed('other.com', e)).toBe(false); // not in allowlist
  });

  it('denylist mode allows unless explicitly denied', () => {
    const e: EgressPolicy = {
      mode: 'denylist',
      domain_rules: [{ action: 'deny', host: 'evil.com' }],
    };
    expect(isHostAllowed('evil.com', e)).toBe(false);
    expect(isHostAllowed('good.com', e)).toBe(true);
  });
});
