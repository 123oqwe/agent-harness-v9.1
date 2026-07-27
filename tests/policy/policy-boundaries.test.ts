import { describe, expect, it } from 'vitest';

import type { EffectRisk } from '../../contracts/index.js';
import {
  PolicyConfigurationError,
  PolicyEngine,
  PolicyInputError,
  deriveRiskTier,
  hostMatches,
  isHostAllowed,
  isStrictDateTime,
  resolveEgress,
  validateEgressTarget,
  type EgressPolicy,
  type Policy,
  type PolicyContext,
} from '../../security/policy-engine.js';

const NOW = '2026-01-01T00:00:00.000Z';

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    run_phase: 'agent',
    trust_level: 'trusted',
    now: NOW,
    ...overrides,
  };
}

function risk(overrides: Partial<EffectRisk> = {}): EffectRisk {
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

function allowRule(overrides: Partial<Policy['rules'][number]> = {}): Policy['rules'][number] {
  return {
    id: 'allow-read',
    priority: 1,
    effect: 'allow',
    tools: ['read_file'],
    resource_prefixes: ['workspace://project/'],
    maximum_risk_tier: 5,
    ...overrides,
  };
}

function expectConfigurationError(operation: () => unknown, message: string): void {
  expect(operation).toThrow(new PolicyConfigurationError(message));
}

function expectInputError(operation: () => unknown, message: string): void {
  expect(operation).toThrow(new PolicyInputError(message));
}

describe('PolicyEngine exact configuration and input contracts', () => {
  it('reports every top-level policy violation exactly', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'policy must be an object'],
      [{ ...policy(), version: '' }, 'policy.version must be a non-empty string'],
      [{ ...policy(), default_decision: 'allow' }, 'policy must enforce deny-by-default'],
      [{ ...policy(), allowed_tools: [] }, 'policy.allowed_tools must be a non-empty array'],
      [{ ...policy(), allowed_tools: [' '] }, 'policy.allowed_tools entry must be a non-empty string'],
      [{ ...policy(), allowed_tools: ['read_file', 'read_file'] }, 'policy.allowed_tools must not contain duplicates'],
      [
        { ...policy(), allowed_resource_prefixes: [] },
        'policy.allowed_resource_prefixes must be a non-empty array',
      ],
      [
        { ...policy(), allowed_resource_prefixes: [' '] },
        'policy.allowed_resource_prefixes entry must be a non-empty string',
      ],
      [
        { ...policy(), allowed_resource_prefixes: ['workspace://', 'workspace://'] },
        'policy.allowed_resource_prefixes must not contain duplicates',
      ],
      [{ ...policy(), rules: 'rules' }, 'policy.rules must be an array'],
      [{ ...policy(), minimum_risk_tier: 6 }, 'policy.minimum_risk_tier must be between 0 and 5'],
      [{ ...policy(), minimum_risk_tier: -1 }, 'policy.minimum_risk_tier must be between 0 and 5'],
    ];
    for (const [value, message] of cases) {
      expectConfigurationError(() => new PolicyEngine(value as Policy), message);
    }
  });

  it('reports every rule violation exactly', () => {
    const base = allowRule();
    const cases: Array<[unknown, string]> = [
      [null, 'policy rule must be an object'],
      [{ ...base, id: '' }, 'policy rule id must be a non-empty string'],
      [{ ...base, priority: 1.5 }, 'policy rule priority must be a safe integer'],
      [{ ...base, priority: Number.MAX_SAFE_INTEGER + 1 }, 'policy rule priority must be a safe integer'],
      [{ ...base, effect: 'permit' }, 'policy rule effect must be allow or deny'],
      [{ ...base, tools: [] }, 'policy rule tools must be a non-empty array'],
      [{ ...base, tools: [' '] }, 'policy rule tools entry must be a non-empty string'],
      [{ ...base, tools: ['read_file', 'read_file'] }, 'policy rule tools must not contain duplicates'],
      [{ ...base, resource_prefixes: [] }, 'policy rule resource_prefixes must be a non-empty array'],
      [
        { ...base, resource_prefixes: [' '] },
        'policy rule resource_prefixes entry must be a non-empty string',
      ],
      [
        { ...base, resource_prefixes: ['workspace://', 'workspace://'] },
        'policy rule resource_prefixes must not contain duplicates',
      ],
      [{ ...base, maximum_risk_tier: 6 }, 'policy rule maximum_risk_tier must be between 0 and 5'],
    ];
    for (const [rule, message] of cases) {
      expectConfigurationError(() => new PolicyEngine(policy({ rules: [rule as never] })), message);
    }
    expectConfigurationError(
      () => new PolicyEngine(policy({ rules: [base, { ...base }] })),
      'policy rule ids must be unique',
    );
  });

  it('reports every context violation and date-time anchor exactly', () => {
    expectInputError(
      () => deriveRiskTier(risk(), policy(), null as unknown as PolicyContext),
      'context must be an object',
    );
    for (const [value, message] of [
      [context({ run_phase: 'other' as 'agent' }), 'invalid run phase'],
      [context({ trust_level: 'other' as 'trusted' }), 'invalid trust level'],
      [context({ now: 'bad' }), 'context.now must be an ISO date-time'],
      [context({ tenant_id: '' }), 'context identity is required'],
      [context({ user_id: '' }), 'context identity is required'],
    ] as const) {
      expectInputError(() => deriveRiskTier(risk(), policy(), value), message);
    }

    expect(isStrictDateTime(NOW)).toBe(true);
    expect(isStrictDateTime('2026-01-01T00:00:00Z')).toBe(true);
    for (const value of [
      null,
      `x${NOW}`,
      `${NOW}x`,
      '2026-02-30T00:00:00.000Z',
      '2026-01-01T00:00:00.00Z',
    ]) {
      expect(isStrictDateTime(value)).toBe(false);
    }
  });

  it('reports every EffectRisk primitive violation exactly', () => {
    expectInputError(
      () => deriveRiskTier(null as unknown as EffectRisk, policy(), context()),
      'EffectRisk must be an object',
    );
    const cases: Array<[EffectRisk, string]> = [
      [{ ...risk(), unexpected: true } as unknown as EffectRisk, 'EffectRisk contains an unknown field'],
      [{ ...risk(), locality: 'invalid' } as unknown as EffectRisk, 'EffectRisk.locality is invalid'],
      [{ ...risk(), operation: 'invalid' } as unknown as EffectRisk, 'EffectRisk.operation is invalid'],
      [{ ...risk(), reversibility: 'invalid' } as unknown as EffectRisk, 'EffectRisk.reversibility is invalid'],
      [{ ...risk(), data_egress: 'invalid' } as unknown as EffectRisk, 'EffectRisk.data_egress is invalid'],
      [{ ...risk(), blast_radius: 'invalid' } as unknown as EffectRisk, 'EffectRisk.blast_radius is invalid'],
      [{ ...risk(), human_impact: 'invalid' } as unknown as EffectRisk, 'EffectRisk.human_impact is invalid'],
      [{ ...risk(), external_visibility: 'invalid' } as unknown as EffectRisk, 'EffectRisk.external_visibility is invalid'],
      [{ ...risk(), network_access: 'yes' } as unknown as EffectRisk, 'EffectRisk access flags must be boolean'],
      [{ ...risk(), credential_access: 1 } as unknown as EffectRisk, 'EffectRisk access flags must be boolean'],
      [
        { ...risk(), regulatory_sensitivity: 'pii' } as unknown as EffectRisk,
        'EffectRisk.regulatory_sensitivity must be a string array',
      ],
      [
        { ...risk(), regulatory_sensitivity: [1] } as unknown as EffectRisk,
        'EffectRisk.regulatory_sensitivity must be a string array',
      ],
      [
        { ...risk(), financial_impact_usd_micros: '-1' },
        'financial impact must be a non-negative decimal integer string',
      ],
      [
        { ...risk(), financial_impact_usd_micros: '01' },
        'financial impact must be a non-negative decimal integer string',
      ],
    ];
    for (const [value, message] of cases) {
      expectInputError(() => deriveRiskTier(value, policy(), context()), message);
    }
  });

  it('reports every structured screen-access violation exactly', () => {
    const cases: Array<[EffectRisk, string]> = [
      [{ ...risk(), screen_access: 'desktop' } as unknown as EffectRisk, 'EffectRisk.screen_access must be an object'],
      [
        { ...risk(), screen_access: { unexpected: true } } as unknown as EffectRisk,
        'EffectRisk.screen_access contains an unknown field',
      ],
      [
        { ...risk(), screen_access: { surface: 'invalid' } } as unknown as EffectRisk,
        'EffectRisk.screen_access.surface is invalid',
      ],
      [
        { ...risk(), screen_access: { input_modes: 'click' } } as unknown as EffectRisk,
        'EffectRisk.screen_access.input_modes is invalid',
      ],
      [
        { ...risk(), screen_access: { input_modes: ['invalid'] } } as unknown as EffectRisk,
        'EffectRisk.screen_access.input_modes is invalid',
      ],
      [
        { ...risk(), screen_access: { app_scope: 'invalid' } } as unknown as EffectRisk,
        'EffectRisk.screen_access.app_scope is invalid',
      ],
    ];
    for (const [value, message] of cases) {
      expectInputError(() => deriveRiskTier(value, policy(), context()), message);
    }
  });
});

describe('PolicyEngine independent screen-risk scoring', () => {
  it.each([
    ['browser', { surface: 'browser' }, 1],
    ['native app', { surface: 'native_app' }, 2],
    ['desktop', { surface: 'desktop' }, 3],
    ['fullscreen', { surface: 'fullscreen' }, 3],
    ['screenshot only', { input_modes: ['screenshot'] }, 0],
    ['click', { input_modes: ['click'] }, 1],
    ['type', { input_modes: ['type'] }, 1],
    ['key', { input_modes: ['key'] }, 1],
    ['clipboard', { input_modes: ['clipboard'] }, 1],
    ['workspace scope', { app_scope: 'workspace' }, 1],
    ['system scope', { app_scope: 'system' }, 2],
  ] as const)('scores %s independently', (_name, screenAccess, expected) => {
    expect(
      deriveRiskTier(
        risk({ screen_access: screenAccess as NonNullable<EffectRisk['screen_access']> }),
        policy(),
        context(),
      ),
    ).toBe(expected);
  });
});

describe('PolicyEngine exact egress normalization and intersection', () => {
  it('reports every malformed egress field exactly', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'egress policy must be an object'],
      [{ mode: 'open', extra: true }, 'egress policy contains an unknown field'],
      [{ mode: 'invalid' }, 'invalid egress mode'],
      [{ mode: 'open', domain_rules: 'rules' }, 'egress domain_rules must be an array'],
      [{ mode: 'open', unix_sockets: 'allow' }, 'invalid egress unix_sockets setting'],
      [{ mode: 'open', allow_local_binding: 'false' }, 'invalid egress allow_local_binding setting'],
      [{ mode: 'open', socks5: 'false' }, 'invalid egress socks5 setting'],
      [{ mode: 'open', domain_rules: [null] }, 'invalid egress domain rule'],
      [
        { mode: 'open', domain_rules: [{ action: 'allow', host: 'api.example', extra: true }] },
        'invalid egress domain rule',
      ],
      [{ mode: 'open', domain_rules: [{ action: 'invalid', host: 'api.example' }] }, 'invalid egress domain rule'],
      [{ mode: 'open', domain_rules: [{ action: 'allow', host: 1 }] }, 'invalid egress domain rule'],
    ];
    for (const [value, message] of cases) {
      expectConfigurationError(() => resolveEgress(value as EgressPolicy), message);
    }
    expectConfigurationError(
      () =>
        resolveEgress({
          mode: 'allowlist',
          domain_rules: [{ action: 'allow', host: '*bad' }],
        }),
      'invalid egress host: invalid wildcard host pattern',
    );
  });

  it('normalizes defaults, sorts rules, removes exact duplicates, and deeply freezes output', () => {
    const normalized = resolveEgress({
      mode: 'allowlist',
      domain_rules: [
        { action: 'deny', host: 'B.example.' },
        { action: 'allow', host: 'A.example' },
        { action: 'allow', host: 'a.example' },
      ],
    })!;
    expect(normalized).toEqual({
      mode: 'allowlist',
      domain_rules: [
        { action: 'allow', host: 'a.example' },
        { action: 'deny', host: 'b.example' },
      ],
      unix_sockets: 'denied',
      allow_local_binding: false,
      socks5: false,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.domain_rules)).toBe(true);
  });

  it('preserves the one defined authority regardless of argument position', () => {
    const value: EgressPolicy = {
      mode: 'open',
      domain_rules: [{ action: 'deny', host: 'blocked.example' }],
    };
    expect(resolveEgress(undefined, value)).toEqual(resolveEgress(value, undefined));
    expect(resolveEgress(undefined, undefined)).toBeUndefined();
  });

  it.each([
    ['open/open', { mode: 'open' }, { mode: 'open' }, 'open'],
    ['deny/open', { mode: 'denylist' }, { mode: 'open' }, 'denylist'],
    ['open/deny', { mode: 'open' }, { mode: 'denylist' }, 'denylist'],
    ['deny/deny', { mode: 'denylist' }, { mode: 'denylist' }, 'denylist'],
    ['allow/open', { mode: 'allowlist' }, { mode: 'open' }, 'allowlist'],
    ['open/allow', { mode: 'open' }, { mode: 'allowlist' }, 'allowlist'],
  ] as const)('selects the exact %s mode', (_name, first, second, expected) => {
    expect(resolveEgress(first, second)?.mode).toBe(expected);
  });

  it('intersects wildcard scopes in both directions and excludes unrelated scopes', () => {
    const broad: EgressPolicy = {
      mode: 'allowlist',
      domain_rules: [{ action: 'allow', host: '*.example.com' }],
    };
    const narrow: EgressPolicy = {
      mode: 'allowlist',
      domain_rules: [{ action: 'allow', host: '*.sub.example.com' }],
    };
    for (const effective of [resolveEgress(broad, narrow)!, resolveEgress(narrow, broad)!]) {
      expect(isHostAllowed('x.sub.example.com', effective)).toBe(true);
      expect(isHostAllowed('x.example.com', effective)).toBe(false);
    }
    const disjoint = resolveEgress(broad, {
      mode: 'allowlist',
      domain_rules: [{ action: 'allow', host: '*.other.test' }],
    })!;
    expect(disjoint.domain_rules).toEqual([]);
  });

  it('intersects exact hosts with wildcards in both directions', () => {
    const wildcard: EgressPolicy = {
      mode: 'allowlist',
      domain_rules: [{ action: 'allow', host: '*.example.com' }],
    };
    const exact: EgressPolicy = {
      mode: 'allowlist',
      domain_rules: [{ action: 'allow', host: 'api.example.com' }],
    };
    expect(resolveEgress(wildcard, exact)?.domain_rules).toContainEqual({
      action: 'allow',
      host: 'api.example.com',
    });
    expect(resolveEgress(exact, wildcard)?.domain_rules).toContainEqual({
      action: 'allow',
      host: 'api.example.com',
    });
  });
});

describe('PolicyEngine host and destination security boundaries', () => {
  const open: EgressPolicy = {
    mode: 'open',
    allow_local_binding: false,
    socks5: true,
  };

  async function destination(address: string) {
    return validateEgressTarget({
      destination: 'https://api.example.com/data',
      policy: open,
      resolve_host: async () => [address],
    });
  }

  it('normalizes IPv6 brackets and rejects destination wildcards and invalid hosts', () => {
    expect(hostMatches('[2001:db8::1]', '2001:db8::1')).toBe(true);
    expect(() => hostMatches('*.example.com', '*.example.com')).toThrow(
      new PolicyInputError('wildcard is not a destination'),
    );
    expect(() => hostMatches('bad host', '*')).toThrow(new PolicyInputError('invalid host'));
    expect(() => hostMatches(1 as unknown as string, '*')).toThrow(
      new PolicyInputError('host must be a string'),
    );
  });

  it('enforces IPv4 private-range lower and upper boundaries', async () => {
    const cases: Array<[string, boolean]> = [
      ['0.0.0.1', false],
      ['10.0.0.1', false],
      ['127.0.0.1', false],
      ['100.63.255.255', true],
      ['100.64.0.0', false],
      ['100.127.255.255', false],
      ['100.128.0.0', true],
      ['169.253.255.255', true],
      ['169.254.0.1', false],
      ['169.255.0.1', true],
      ['172.15.255.255', true],
      ['172.16.0.0', false],
      ['172.31.255.255', false],
      ['172.32.0.0', true],
      ['192.167.255.255', true],
      ['192.168.0.1', false],
      ['192.169.0.1', true],
    ];
    for (const [address, allowed] of cases) {
      const decision = await destination(address);
      expect(decision.allowed, address).toBe(allowed);
      expect(decision.reason_code, address).toBe(
        allowed ? 'egress_allowed' : 'private_or_local_address',
      );
    }
  });

  it('rejects malformed protocols, credentials, empty DNS, non-IP DNS, and bad pins exactly', async () => {
    const base = {
      policy: open,
      resolve_host: async () => ['203.0.113.10'],
    };
    for (const destinationValue of [
      'ftp://api.example.com/file',
      'https://user@api.example.com/file',
      'https://user:pass@api.example.com/file',
      'not a url',
    ]) {
      await expect(
        validateEgressTarget({ ...base, destination: destinationValue }),
      ).resolves.toEqual({ allowed: false, reason_code: 'invalid_destination' });
    }
    await expect(
      validateEgressTarget({
        ...base,
        destination: 'https://api.example.com/file',
        resolve_host: async () => [],
      }),
    ).resolves.toEqual({ allowed: false, reason_code: 'dns_resolution_failed' });
    await expect(
      validateEgressTarget({
        ...base,
        destination: 'https://api.example.com/file',
        resolve_host: async () => ['not-an-ip'],
      }),
    ).resolves.toEqual({ allowed: false, reason_code: 'dns_resolution_failed' });
    await expect(
      validateEgressTarget({
        ...base,
        destination: 'https://api.example.com/file',
        pinned_addresses: ['not-an-ip'],
      }),
    ).resolves.toEqual({ allowed: false, reason_code: 'dns_rebinding' });
  });

  it('deduplicates and sorts DNS and pinned sets before equality', async () => {
    const decision = await validateEgressTarget({
      destination: 'https://api.example.com/data',
      policy: open,
      resolve_host: async () => ['203.0.113.20', '203.0.113.10', '203.0.113.10'],
      pinned_addresses: ['203.0.113.10', '203.0.113.20', '203.0.113.20'],
    });
    expect(decision).toEqual({
      allowed: true,
      reason_code: 'egress_allowed',
      canonical_host: 'api.example.com',
      resolved_addresses: ['203.0.113.10', '203.0.113.20'],
    });
  });

  it('distinguishes disabled, deny, allowlist, and open host decisions', () => {
    expect(isHostAllowed('api.example', { mode: 'disabled' })).toBe(false);
    expect(
      isHostAllowed('blocked.example', {
        mode: 'open',
        domain_rules: [{ action: 'deny', host: 'blocked.example' }],
      }),
    ).toBe(false);
    expect(isHostAllowed('api.example', { mode: 'open' })).toBe(true);
    expect(isHostAllowed('api.example', { mode: 'denylist' })).toBe(true);
    expect(
      isHostAllowed('api.example', {
        mode: 'allowlist',
        domain_rules: [{ action: 'allow', host: 'api.example' }],
      }),
    ).toBe(true);
    expect(isHostAllowed('other.example', { mode: 'allowlist' })).toBe(false);
  });
});

describe('PolicyEngine evaluation ordering and resource boundaries', () => {
  it('requires at least one resource and every resource to match an allowed prefix', () => {
    const engine = new PolicyEngine(policy({ rules: [allowRule()] }));
    const evaluate = (resource_ids: string[]) =>
      engine.evaluate({
        tool_name: 'read_file',
        resource_ids,
        risk: risk(),
        context: context(),
      });

    expect(evaluate([]).reason_code).toBe('resource_not_allowed');
    expect(evaluate(['workspace://project/a']).reason_code).toBe('allowed');
    expect(evaluate(['workspace://project/a', 'workspace://other/b']).reason_code).toBe(
      'resource_not_allowed',
    );
  });

  it('does not allow a sibling resource that only shares a lexical prefix', () => {
    const engine = new PolicyEngine(
      policy({
        allowed_resource_prefixes: ['/workspace'],
        rules: [allowRule({ resource_prefixes: ['/workspace'] })],
      }),
    );
    const evaluate = (resource_id: string) =>
      engine.evaluate({
        tool_name: 'read_file',
        resource_ids: [resource_id],
        risk: risk(),
        context: context(),
      });

    expect(evaluate('/workspace').reason_code).toBe('allowed');
    expect(evaluate('/workspace/file.txt').reason_code).toBe('allowed');
    expect(evaluate('/workspace-evil/secret.txt').reason_code).toBe('resource_not_allowed');
  });

  it('allows a resource that matches any one of multiple segment-bounded prefixes', () => {
    const prefixes = ['/workspace', '/archive'];
    const engine = new PolicyEngine(
      policy({
        allowed_resource_prefixes: prefixes,
        rules: [allowRule({ resource_prefixes: prefixes })],
      }),
    );
    const evaluate = (resource_id: string) =>
      engine.evaluate({
        tool_name: 'read_file',
        resource_ids: [resource_id],
        risk: risk(),
        context: context(),
      });

    expect(evaluate('/workspace/file.txt').reason_code).toBe('allowed');
    expect(evaluate('/archive/file.txt').reason_code).toBe('allowed');
  });

  it('treats a URI scheme root as an explicit resource prefix', () => {
    const engine = new PolicyEngine(
      policy({
        allowed_resource_prefixes: ['workspace://'],
        rules: [allowRule({ resource_prefixes: ['workspace://'] })],
      }),
    );

    expect(
      engine.evaluate({
        tool_name: 'read_file',
        resource_ids: ['workspace://project/file.txt'],
        risk: risk(),
        context: context(),
      }).reason_code,
    ).toBe('allowed');
  });

  it('selects the highest-priority matching allow rule and alphabetic ID on ties', () => {
    const high = new PolicyEngine(
      policy({
        rules: [
          allowRule({ id: 'low', priority: 1 }),
          allowRule({ id: 'high', priority: 10 }),
        ],
      }),
    );
    const request = {
      tool_name: 'read_file',
      resource_ids: ['workspace://project/a'],
      risk: risk(),
      context: context(),
    };
    expect(high.evaluate(request).matched_rule_id).toBe('high');

    const tied = new PolicyEngine(
      policy({
        rules: [
          allowRule({ id: 'z-rule', priority: 1 }),
          allowRule({ id: 'a-rule', priority: 1 }),
        ],
      }),
    );
    expect(tied.evaluate(request).matched_rule_id).toBe('a-rule');
  });

  it('reports malformed evaluation fields exactly', () => {
    const engine = new PolicyEngine(policy());
    expectInputError(
      () => engine.evaluate(null as unknown as Parameters<typeof engine.evaluate>[0]),
      'invalid policy evaluation request',
    );
    expectInputError(
      () =>
        engine.evaluate({
          tool_name: '',
          resource_ids: [],
          risk: risk(),
          context: context(),
        }),
      'invalid policy evaluation request',
    );
    expectInputError(
      () =>
        engine.evaluate({
          tool_name: 'read_file',
          resource_ids: [1] as unknown as string[],
          risk: risk(),
          context: context(),
        }),
      'invalid resource ids',
    );
  });
});
