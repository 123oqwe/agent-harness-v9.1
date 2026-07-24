import { describe, expect, it } from 'vitest';

import type { EffectRisk } from '../../contracts/index.js';
import {
  PolicyConfigurationError,
  PolicyEngine,
  PolicyInputError,
  type Policy,
  type PolicyContext,
} from '../../security/policy-engine.js';

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    run_phase: 'agent',
    trust_level: 'trusted',
    now: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function safeReadRisk(overrides: Partial<EffectRisk> = {}): EffectRisk {
  return {
    locality: 'local',
    operation: 'read',
    reversibility: 'guaranteed',
    data_egress: 'none',
    network_access: false,
    credential_access: false,
    blast_radius: 'single_resource',
    financial_impact_usd_micros: '0',
    human_impact: 'none',
    external_visibility: 'private',
    regulatory_sensitivity: [],
    ...overrides,
  };
}

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 'policy-v1',
    default_decision: 'deny',
    allowed_tools: ['read_file'],
    allowed_resource_prefixes: ['workspace://project/'],
    rules: [],
    ...overrides,
  };
}

describe('AH-POLICY-ENGINE-001: deny by default and immutable policy', () => {
  it('denies an action when no explicit rule matches', () => {
    const engine = new PolicyEngine(policy());

    const decision = engine.evaluate({
      tool_name: 'read_file',
      resource_ids: ['workspace://project/readme.md'],
      risk: safeReadRisk(),
      context: context(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('default_deny');
  });

  it('requires the policy default to be deny', () => {
    expect(
      () =>
        new PolicyEngine({
          ...policy(),
          default_decision: 'allow' as 'deny',
        }),
    ).toThrow(PolicyConfigurationError);
  });

  it('allows only when a matching rule and both tool allowlists permit the action', () => {
    const engine = new PolicyEngine(
      policy({
        rules: [
          {
            id: 'allow-project-read',
            priority: 10,
            effect: 'allow',
            tools: ['read_file'],
            resource_prefixes: ['workspace://project/'],
            maximum_risk_tier: 1,
          },
        ],
      }),
    );

    expect(
      engine.evaluate({
        tool_name: 'read_file',
        resource_ids: ['workspace://project/src/index.ts'],
        risk: safeReadRisk(),
        context: context(),
      }).allowed,
    ).toBe(true);
  });

  it('uses the intersection of the policy and rule tool allowlists', () => {
    const engine = new PolicyEngine(
      policy({
        allowed_tools: ['read_file'],
        rules: [
          {
            id: 'rule-allows-write',
            priority: 10,
            effect: 'allow',
            tools: ['write_file'],
            resource_prefixes: ['workspace://project/'],
            maximum_risk_tier: 3,
          },
        ],
      }),
    );

    const decision = engine.evaluate({
      tool_name: 'write_file',
      resource_ids: ['workspace://project/file.ts'],
      risk: safeReadRisk({ operation: 'write' }),
      context: context(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('tool_not_allowed');
  });

  it('uses the intersection of policy and rule resource prefixes', () => {
    const engine = new PolicyEngine(
      policy({
        rules: [
          {
            id: 'rule-broader-than-policy',
            priority: 10,
            effect: 'allow',
            tools: ['read_file'],
            resource_prefixes: ['workspace://'],
            maximum_risk_tier: 1,
          },
        ],
      }),
    );

    const decision = engine.evaluate({
      tool_name: 'read_file',
      resource_ids: ['workspace://another-project/secret.txt'],
      risk: safeReadRisk(),
      context: context(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('resource_not_allowed');
  });

  it('gives an explicit deny precedence over any allow independent of input order', () => {
    const allow = {
      id: 'allow-read',
      priority: 100,
      effect: 'allow' as const,
      tools: ['read_file'],
      resource_prefixes: ['workspace://project/'],
      maximum_risk_tier: 1 as const,
    };
    const deny = {
      id: 'deny-read',
      priority: 1,
      effect: 'deny' as const,
      tools: ['read_file'],
      resource_prefixes: ['workspace://project/'],
    };
    const request = {
      tool_name: 'read_file',
      resource_ids: ['workspace://project/readme.md'],
      risk: safeReadRisk(),
      context: context(),
    };

    const first = new PolicyEngine(policy({ rules: [allow, deny] })).evaluate(request);
    const second = new PolicyEngine(policy({ rules: [deny, allow] })).evaluate(request);

    expect(first).toEqual(second);
    expect(first.allowed).toBe(false);
    expect(first.reason_code).toBe('explicit_deny');
  });

  it('denies when the derived tier exceeds the matching rule ceiling', () => {
    const engine = new PolicyEngine(
      policy({
        rules: [
          {
            id: 'low-risk-only',
            priority: 1,
            effect: 'allow',
            tools: ['read_file'],
            resource_prefixes: ['workspace://project/'],
            maximum_risk_tier: 0,
          },
        ],
      }),
    );

    const decision = engine.evaluate({
      tool_name: 'read_file',
      resource_ids: ['workspace://project/readme.md'],
      risk: safeReadRisk({ data_egress: 'metadata' }),
      context: context(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('risk_tier_exceeded');
  });

  it('denies network access when EffectRisk has no authoritative egress policy', () => {
    const engine = new PolicyEngine(
      policy({
        rules: [
          {
            id: 'network-rule',
            priority: 1,
            effect: 'allow',
            tools: ['read_file'],
            resource_prefixes: ['workspace://project/'],
            maximum_risk_tier: 5,
          },
        ],
      }),
    );

    const decision = engine.evaluate({
      tool_name: 'read_file',
      resource_ids: ['workspace://project/readme.md'],
      risk: safeReadRisk({ network_access: true, locality: 'remote' }),
      context: context(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('missing_egress_policy');
  });

  it('deep-copies and deeply freezes the policy snapshot with a stable version and hash', () => {
    const original = policy({
      rules: [
        {
          id: 'allow-read',
          priority: 1,
          effect: 'allow',
          tools: ['read_file'],
          resource_prefixes: ['workspace://project/'],
          maximum_risk_tier: 1,
        },
      ],
    });
    const engine = new PolicyEngine(original);
    original.allowed_tools.push('write_file');
    original.rules[0]!.tools.push('write_file');

    expect(engine.version).toBe('policy-v1');
    expect(engine.policy_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(engine.snapshot)).toBe(true);
    expect(Object.isFrozen(engine.snapshot.rules)).toBe(true);
    expect(Object.isFrozen(engine.snapshot.rules[0]!.tools)).toBe(true);
    expect(engine.snapshot.allowed_tools).toEqual(['read_file']);
    expect(engine.snapshot.rules[0]!.tools).toEqual(['read_file']);
  });

  it('rejects duplicate rule identifiers and malformed policy values fail closed', () => {
    const duplicate = {
      id: 'same',
      priority: 1,
      effect: 'deny' as const,
      tools: ['*'],
      resource_prefixes: ['workspace://'],
    };

    expect(() => new PolicyEngine(policy({ rules: [duplicate, duplicate] }))).toThrow(
      PolicyConfigurationError,
    );
    expect(() => new PolicyEngine({ ...policy(), version: '' })).toThrow(PolicyConfigurationError);
    expect(() => new PolicyEngine({ ...policy(), allowed_tools: [] })).toThrow(
      PolicyConfigurationError,
    );
  });

  it('rejects malformed rule, allowlist and risk-floor values fail closed', () => {
    const validRule = {
      id: 'rule-1',
      priority: 1,
      effect: 'allow' as const,
      tools: ['read_file'],
      resource_prefixes: ['workspace://project/'],
      maximum_risk_tier: 1 as const,
    };
    const invalidPolicies = [
      { ...policy(), allowed_tools: ['read_file', 'read_file'] },
      { ...policy(), allowed_resource_prefixes: [''] },
      { ...policy(), rules: 'not-an-array' },
      { ...policy(), minimum_risk_tier: 6 },
      { ...policy(), rules: [null] },
      { ...policy(), rules: [{ ...validRule, id: '' }] },
      { ...policy(), rules: [{ ...validRule, priority: 1.5 }] },
      { ...policy(), rules: [{ ...validRule, effect: 'permit' }] },
      { ...policy(), rules: [{ ...validRule, tools: [] }] },
      { ...policy(), rules: [{ ...validRule, resource_prefixes: [] }] },
      { ...policy(), rules: [{ ...validRule, maximum_risk_tier: -1 }] },
    ];

    for (const invalid of invalidPolicies) {
      expect(() => new PolicyEngine(invalid as unknown as Policy)).toThrow(PolicyConfigurationError);
    }
  });

  it('ignores unrelated allow rules and returns a complete immutable decision', () => {
    const engine = new PolicyEngine(
      policy({
        allowed_tools: ['read_file', 'write_file'],
        rules: [
          {
            id: 'allow-write-only',
            priority: 100,
            effect: 'allow',
            tools: ['write_file'],
            resource_prefixes: ['workspace://project/'],
          },
          {
            id: 'allow-read',
            priority: 1,
            effect: 'allow',
            tools: ['read_file'],
            resource_prefixes: ['workspace://project/'],
          },
        ],
      }),
    );

    const decision = engine.evaluate({
      tool_name: 'read_file',
      resource_ids: ['workspace://project/readme.md'],
      risk: safeReadRisk(),
      context: context(),
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason_code: 'allowed',
      matched_rule_id: 'allow-read',
      policy_version: 'policy-v1',
      policy_hash: engine.policy_hash,
      decided_at: '2026-01-01T00:00:00.000Z',
    });
    expect(decision.decision_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(decision).not.toHaveProperty('egress_policy');
  });

  it('denies when the effective policy explicitly disables required network access', () => {
    const engine = new PolicyEngine(
      policy({
        egress_policy: { mode: 'disabled' },
        rules: [
          {
            id: 'network',
            priority: 1,
            effect: 'allow',
            tools: ['read_file'],
            resource_prefixes: ['workspace://project/'],
            maximum_risk_tier: 5,
          },
        ],
      }),
    );
    const decision = engine.evaluate({
      tool_name: 'read_file',
      resource_ids: ['workspace://project/readme.md'],
      risk: safeReadRisk({
        locality: 'remote',
        network_access: true,
        egress_policy: { mode: 'open' },
      }),
      context: context(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('egress_disabled');
  });

  it('rejects malformed policy evaluation request fields', () => {
    const engine = new PolicyEngine(policy());

    expect(() => engine.evaluate(null as unknown as Parameters<typeof engine.evaluate>[0])).toThrow(
      PolicyInputError,
    );
    expect(() =>
      engine.evaluate({
        tool_name: '',
        resource_ids: ['workspace://project/readme.md'],
        risk: safeReadRisk(),
        context: context(),
      }),
    ).toThrow(PolicyInputError);
    expect(() =>
      engine.evaluate({
        tool_name: 'read_file',
        resource_ids: ['workspace://project/readme.md', 42] as unknown as string[],
        risk: safeReadRisk(),
        context: context(),
      }),
    ).toThrow(PolicyInputError);
  });
});
