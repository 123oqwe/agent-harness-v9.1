import { describe, expect, it } from 'vitest';

import type { EffectRisk } from '../../contracts/index.js';
import {
  PolicyConfigurationError,
  PolicyInputError,
  deriveRiskTier,
  hostMatches,
  isHostAllowed,
  resolveEgress,
  validateEgressTarget,
  type Policy,
  type PolicyContext,
} from '../../security/policy-engine.js';

type EgressPolicy = NonNullable<EffectRisk['egress_policy']>;

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

describe('AH-POLICY-ENGINE-001: risk is derived from EffectRisk, Policy and Context', () => {
  it('derives tier zero for a trusted local read without effects', () => {
    expect(deriveRiskTier(risk(), policy(), context())).toBe(0);
  });

  it('raises risk for writes, irreversibility, egress, credentials and blast radius', () => {
    const derived = deriveRiskTier(
      risk({
        locality: 'external',
        operation: 'publish',
        reversibility: 'none',
        data_egress: 'sensitive',
        network_access: true,
        egress_policy: { mode: 'allowlist', domain_rules: [{ action: 'allow', host: 'api.example' }] },
        credential_access: true,
        blast_radius: 'public',
        human_impact: 'public',
        external_visibility: 'public',
        regulatory_sensitivity: ['health'],
      }),
      policy(),
      context(),
    );

    expect(derived).toBe(5);
  });

  const individualRiskCases: Array<[string, Partial<EffectRisk>, number]> = [
    ['remote locality', { locality: 'remote' }, 1],
    ['external locality', { locality: 'external' }, 2],
    ['create operation', { operation: 'create' }, 1],
    ['write operation', { operation: 'write' }, 2],
    ['execute operation', { operation: 'execute' }, 2],
    ['delete operation', { operation: 'delete' }, 3],
    ['purchase operation', { operation: 'purchase' }, 3],
    ['publish operation', { operation: 'publish' }, 2],
    ['communicate operation', { operation: 'communicate' }, 2],
    ['best-effort reversal', { reversibility: 'best_effort' }, 1],
    ['irreversible effect', { reversibility: 'none' }, 2],
    ['metadata egress', { data_egress: 'metadata' }, 1],
    ['content egress', { data_egress: 'content' }, 2],
    ['sensitive egress', { data_egress: 'sensitive' }, 3],
    ['network access', { network_access: true, egress_policy: { mode: 'open' } }, 1],
    ['credential access', { credential_access: true }, 2],
    ['bounded blast radius', { blast_radius: 'bounded_set' }, 1],
    ['workspace blast radius', { blast_radius: 'workspace' }, 2],
    ['organization blast radius', { blast_radius: 'organization' }, 3],
    ['public blast radius', { blast_radius: 'public' }, 3],
    ['unbounded blast radius', { blast_radius: 'unbounded' }, 4],
    ['self human impact', { human_impact: 'self' }, 1],
    ['internal human impact', { human_impact: 'internal_people' }, 2],
    ['external human impact', { human_impact: 'external_people' }, 3],
    ['public human impact', { human_impact: 'public' }, 3],
    ['shared visibility', { external_visibility: 'shared' }, 1],
    ['public visibility', { external_visibility: 'public' }, 2],
    ['generic regulatory sensitivity', { regulatory_sensitivity: ['pii'] }, 1],
    ['health regulatory sensitivity', { regulatory_sensitivity: ['health'] }, 3],
    [
      'desktop screen typing',
      {
        screen_access: {
          surface: 'desktop',
          input_modes: ['screenshot', 'type'],
          app_scope: 'system',
        },
      },
      5,
    ],
  ];

  for (const [name, override, expected] of individualRiskCases) {
    it(`scores ${name} independently`, () => {
      expect(deriveRiskTier(risk(override), policy(), context())).toBe(expected);
    });
  }

  it('uses the policy risk floor', () => {
    expect(deriveRiskTier(risk(), policy({ minimum_risk_tier: 3 }), context())).toBe(3);
  });

  it('raises risk for untrusted and quarantined action context', () => {
    expect(deriveRiskTier(risk(), policy(), context({ trust_level: 'untrusted' }))).toBe(1);
    expect(deriveRiskTier(risk(), policy(), context({ trust_level: 'quarantined' }))).toBe(3);
  });

  it('uses decimal-string financial impact without unsafe number coercion', () => {
    expect(
      deriveRiskTier(risk({ financial_impact_usd_micros: '10000' }), policy(), context()),
    ).toBe(1);
    expect(
      deriveRiskTier(risk({ financial_impact_usd_micros: '1000000' }), policy(), context()),
    ).toBe(3);
  });

  it('rejects malformed or negative financial impact fail closed', () => {
    expect(() =>
      deriveRiskTier(risk({ financial_impact_usd_micros: '-1' }), policy(), context()),
    ).toThrow(PolicyInputError);
    expect(() =>
      deriveRiskTier(risk({ financial_impact_usd_micros: '1.5' }), policy(), context()),
    ).toThrow(PolicyInputError);
  });

  it('rejects EffectRisk values outside the generated Contract at runtime', () => {
    const invalid = { ...risk(), operation: 'download' } as unknown as EffectRisk;

    expect(() => deriveRiskTier(invalid, policy(), context())).toThrow(PolicyInputError);
  });

  it('rejects invalid context and structured EffectRisk fields fail closed', () => {
    const invalidContexts = [
      context({ run_phase: 'other' as 'agent' }),
      context({ trust_level: 'other' as 'trusted' }),
      context({ now: '2026-01-01' }),
      context({ tenant_id: '' }),
      context({ user_id: '' }),
    ];
    for (const invalidContext of invalidContexts) {
      expect(() => deriveRiskTier(risk(), policy(), invalidContext)).toThrow(PolicyInputError);
    }

    const invalidRisks = [
      { ...risk(), network_access: 'yes' },
      { ...risk(), credential_access: 1 },
      { ...risk(), regulatory_sensitivity: 'pii' },
      { ...risk(), regulatory_sensitivity: [1] },
      { ...risk(), screen_access: 'desktop' },
      { ...risk(), unexpected: true },
    ] as unknown as EffectRisk[];
    for (const invalidRisk of invalidRisks) {
      expect(() => deriveRiskTier(invalidRisk, policy(), context())).toThrow(PolicyInputError);
    }
  });
});

describe('AH-POLICY-ENGINE-001: authoritative egress policy intersection', () => {
  it('returns no egress policy only when neither authority defines one', () => {
    expect(resolveEgress(undefined, undefined)).toBeUndefined();
  });

  it('treats disabled as stricter than every other mode', () => {
    expect(resolveEgress({ mode: 'open' }, { mode: 'disabled' })).toEqual({
      mode: 'disabled',
      domain_rules: [],
      unix_sockets: 'denied',
      allow_local_binding: false,
      socks5: false,
    });
  });

  it('intersects two allowlists rather than unioning them', () => {
    const effective = resolveEgress(
      {
        mode: 'allowlist',
        domain_rules: [{ action: 'allow', host: '*.example.com' }],
      },
      {
        mode: 'allowlist',
        domain_rules: [
          { action: 'allow', host: 'api.example.com' },
          { action: 'allow', host: 'outside.test' },
        ],
      },
    );

    expect(effective).toBeDefined();
    expect(isHostAllowed('api.example.com', effective!)).toBe(true);
    expect(isHostAllowed('other.example.com', effective!)).toBe(false);
    expect(isHostAllowed('outside.test', effective!)).toBe(false);
  });

  it('unions deny rules and deny always wins', () => {
    const effective = resolveEgress(
      {
        mode: 'open',
        domain_rules: [{ action: 'deny', host: 'blocked.example' }],
      },
      {
        mode: 'open',
        domain_rules: [{ action: 'deny', host: '*.internal.example' }],
      },
    );

    expect(isHostAllowed('blocked.example', effective!)).toBe(false);
    expect(isHostAllowed('x.internal.example', effective!)).toBe(false);
    expect(isHostAllowed('public.example', effective!)).toBe(true);
  });

  it('preserves the single allowlist when intersected with open or denylist mode', () => {
    const allowlist: EgressPolicy = {
      mode: 'allowlist',
      domain_rules: [{ action: 'allow', host: 'api.example.com' }],
    };
    const withOpen = resolveEgress(allowlist, { mode: 'open' });
    const withDenylist = resolveEgress(
      { mode: 'denylist', domain_rules: [{ action: 'deny', host: 'blocked.example' }] },
      allowlist,
    );

    expect(isHostAllowed('api.example.com', withOpen!)).toBe(true);
    expect(isHostAllowed('outside.example', withOpen!)).toBe(false);
    expect(isHostAllowed('api.example.com', withDenylist!)).toBe(true);
    expect(isHostAllowed('blocked.example', withDenylist!)).toBe(false);
  });

  it('requires both authorities to opt into Unix sockets, local binding and SOCKS5', () => {
    const permissive: EgressPolicy = {
      mode: 'open',
      unix_sockets: 'allowlist',
      allow_local_binding: true,
      socks5: true,
    };
    const restrictive: EgressPolicy = { mode: 'open' };

    expect(resolveEgress(permissive, permissive)).toMatchObject({
      unix_sockets: 'allowlist',
      allow_local_binding: true,
      socks5: true,
    });
    expect(resolveEgress(permissive, restrictive)).toMatchObject({
      unix_sockets: 'denied',
      allow_local_binding: false,
      socks5: false,
    });
  });

  it('rejects malformed and unknown egress policy fields instead of coercing them', () => {
    const invalidPolicies = [
      { mode: 'permit-all' },
      { mode: 'open', domain_rules: 'not-an-array' },
      { mode: 'open', domain_rules: [{ action: 'permit', host: 'api.example.com' }] },
      { mode: 'open', domain_rules: [{ action: 'allow', host: 42 }] },
      { mode: 'open', unix_sockets: 'allowed' },
      { mode: 'open', allow_local_binding: 'false' },
      { mode: 'open', socks5: 'false' },
      { mode: 'open', unknown_control: true },
    ];

    for (const invalid of invalidPolicies) {
      expect(() => resolveEgress(invalid as unknown as EgressPolicy, undefined)).toThrow(
        PolicyConfigurationError,
      );
    }
  });
});

describe('AH-POLICY-ENGINE-001: host canonicalization and matching', () => {
  it('normalizes case and one or more trailing dots', () => {
    expect(hostMatches('API.Example.COM.', 'api.example.com')).toBe(true);
    expect(hostMatches('api.example.com...', 'API.EXAMPLE.COM.')).toBe(true);
  });

  it('matches a scoped wildcard only below its suffix', () => {
    expect(hostMatches('one.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('deep.one.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('notexample.com', '*.example.com')).toBe(false);
  });

  it('canonicalizes Unicode host names to IDNA ASCII', () => {
    expect(hostMatches('bücher.example', 'xn--bcher-kva.example')).toBe(true);
    expect(hostMatches('XN--BCHER-KVA.EXAMPLE.', 'bücher.example')).toBe(true);
  });

  it('rejects invalid wildcard and empty host patterns fail closed', () => {
    expect(() => hostMatches('api.example.com', '*example.com')).toThrow(PolicyInputError);
    expect(() => hostMatches('', 'api.example.com')).toThrow(PolicyInputError);
  });
});

describe('AH-POLICY-ENGINE-001: network destination enforcement', () => {
  const allowApi: EgressPolicy = {
    mode: 'allowlist',
    domain_rules: [{ action: 'allow', host: 'api.example.com' }],
    unix_sockets: 'denied',
    allow_local_binding: false,
    socks5: false,
  };

  it('rejects IPv4 and IPv6 loopback, private and link-local destinations', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      'fc00::1',
      'fe80::1',
    ]) {
      const decision = await validateEgressTarget({
        destination: 'https://api.example.com/data',
        policy: allowApi,
        resolve_host: async () => [address],
      });
      expect(decision.allowed, address).toBe(false);
      expect(decision.reason_code, address).toBe('private_or_local_address');
    }
  });

  it('rejects private IP literals even when a broad host rule allows them', async () => {
    const decision = await validateEgressTarget({
      destination: 'https://127.0.0.1/resource',
      policy: { ...allowApi, domain_rules: [{ action: 'allow', host: '*' }] },
      resolve_host: async () => {
        throw new Error('literal addresses must not be resolved');
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('private_or_local_address');
  });

  it('permits an explicitly allowed public destination and pins sorted DNS addresses', async () => {
    const decision = await validateEgressTarget({
      destination: 'https://API.Example.COM./data',
      policy: allowApi,
      resolve_host: async () => ['203.0.113.20', '203.0.113.10'],
    });

    expect(decision).toEqual({
      allowed: true,
      reason_code: 'egress_allowed',
      canonical_host: 'api.example.com',
      resolved_addresses: ['203.0.113.10', '203.0.113.20'],
    });
  });

  it('rejects a redirect that escapes the original allowlist', async () => {
    const decision = await validateEgressTarget({
      destination: 'https://evil.example.net/redirected',
      policy: allowApi,
      redirect_from: 'https://api.example.com/start',
      resolve_host: async () => ['203.0.113.10'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('host_not_allowed');
  });

  it('rejects DNS rebinding when the pinned address set changes', async () => {
    const decision = await validateEgressTarget({
      destination: 'https://api.example.com/data',
      policy: allowApi,
      pinned_addresses: ['203.0.113.10'],
      resolve_host: async () => ['203.0.113.11'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe('dns_rebinding');
  });

  it('rejects Unix sockets and SOCKS destinations unless the policy explicitly enables them', async () => {
    const unix = await validateEgressTarget({
      destination: 'unix:///var/run/docker.sock',
      policy: allowApi,
      resolve_host: async () => [],
    });
    const socks = await validateEgressTarget({
      destination: 'socks5://api.example.com:1080',
      policy: allowApi,
      resolve_host: async () => ['203.0.113.10'],
    });

    expect(unix.reason_code).toBe('unix_socket_denied');
    expect(socks.reason_code).toBe('socks5_denied');
  });

  it('fails closed on malformed URLs and DNS errors without leaking resolver details', async () => {
    const malformed = await validateEgressTarget({
      destination: 'not a URL',
      policy: allowApi,
      resolve_host: async () => [],
    });
    const dns = await validateEgressTarget({
      destination: 'https://api.example.com/data',
      policy: allowApi,
      resolve_host: async () => {
        throw new Error('resolver secret detail');
      },
    });

    expect(malformed.reason_code).toBe('invalid_destination');
    expect(dns).toEqual({ allowed: false, reason_code: 'dns_resolution_failed' });
    expect(JSON.stringify(dns)).not.toContain('secret');
  });
});
