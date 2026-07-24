import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CapabilityToken } from '../../contracts/index.js';
import {
  AuthorizationService,
  InMemoryCapabilityStateStore,
  type CapabilityIssueRequest,
} from '../../security/authorization-service.js';
import {
  CapabilityInvalidError,
  CapabilityExpiredError,
  CapabilityNotYetValidError,
  CapabilityRevokedError,
  CapabilityUsedError,
  type CapabilityStateRecord,
  type CapabilityStateStore,
  type SignedCapabilityToken,
} from '../../security/capability.js';

const NOW = '2026-01-01T00:00:00.000Z';
const TOKEN_ID = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);

function issueRequest(overrides: Partial<CapabilityIssueRequest> = {}): CapabilityIssueRequest {
  return {
    operation_id: 'operation-1',
    attempt_id: 'attempt-1',
    manifest_hash: HASH,
    policy_decision_hash: HASH,
    tool_effect_contract_hash: HASH,
    subject_workload: 'workload-1',
    tenant_id: 'tenant-1',
    audience: 'tool-host',
    tool_grant_hash: HASH,
    resource_grant_hash: HASH,
    budget_ceiling_hash: HASH,
    execution_epoch: 'epoch-1',
    confirmation_key_thumbprint: 'key-1',
    not_before: NOW,
    expires_at: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function serviceWith(
  options: {
    now?: () => string;
    random_uuid?: () => string;
    state_store?: CapabilityStateStore;
    private_key?: KeyObject;
    public_key?: KeyObject;
    max_ttl_ms?: number;
  } = {},
) {
  const keys = generateKeyPairSync('ed25519');
  const stateStore = options.state_store ?? new InMemoryCapabilityStateStore();
  const service = new AuthorizationService({
    private_key: options.private_key ?? keys.privateKey,
    public_key: options.public_key ?? keys.publicKey,
    state_store: stateStore,
    now: options.now ?? (() => NOW),
    random_uuid: options.random_uuid ?? (() => TOKEN_ID),
    ...(options.max_ttl_ms === undefined ? {} : { max_ttl_ms: options.max_ttl_ms }),
  });
  return { keys, service, stateStore };
}

async function expectInvalid(promise: Promise<unknown>, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'CapabilityInvalidError',
    message,
  });
}

class ControllableStateStore implements CapabilityStateStore {
  record: CapabilityStateRecord | undefined;
  consumeOutcome: 'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch' = 'consumed';

  async register(_tokenId: string, record: CapabilityStateRecord): Promise<void> {
    this.record = record;
  }

  async read(_tokenId: string): Promise<CapabilityStateRecord | undefined> {
    return this.record;
  }

  async consume(_tokenId: string, _tokenHash: string) {
    return this.consumeOutcome;
  }

  async revoke(_tokenId: string): Promise<boolean> {
    if (this.record === undefined || this.record.status === 'revoked') return false;
    this.record = { ...this.record, status: 'revoked' };
    return true;
  }
}

describe('AuthorizationService exact issue contract', () => {
  const nonEmptyFields = [
    'operation_id',
    'attempt_id',
    'subject_workload',
    'tenant_id',
    'audience',
    'execution_epoch',
    'confirmation_key_thumbprint',
  ] as const;
  const hashFields = [
    'manifest_hash',
    'policy_decision_hash',
    'tool_effect_contract_hash',
    'tool_grant_hash',
    'resource_grant_hash',
    'budget_ceiling_hash',
  ] as const;
  const allFields = [
    ...nonEmptyFields,
    ...hashFields,
    'not_before',
    'expires_at',
  ] as const;

  it('rejects non-object, missing, and unknown issue fields with exact errors', async () => {
    const { service } = serviceWith();
    await expectInvalid(
      service.issue(null as unknown as CapabilityIssueRequest),
      'capability request must be an object',
    );

    for (const field of allFields) {
      const missing = { ...issueRequest() } as Record<string, unknown>;
      delete missing[field];
      await expectInvalid(
        service.issue(missing as unknown as CapabilityIssueRequest),
        'capability request contains unknown or missing fields',
      );
    }
    await expectInvalid(
      service.issue({ ...issueRequest(), extra: true } as unknown as CapabilityIssueRequest),
      'capability request contains unknown or missing fields',
    );
  });

  it('rejects every blank and non-string identity field with its field name', async () => {
    const { service } = serviceWith();
    for (const field of nonEmptyFields) {
      for (const value of ['', ' \t ', 1]) {
        await expectInvalid(
          service.issue(issueRequest({ [field]: value } as Partial<CapabilityIssueRequest>)),
          `${field} must be a non-empty string`,
        );
      }
    }
  });

  it('rejects every malformed hash at both length and alphabet boundaries', async () => {
    const { service } = serviceWith();
    for (const field of hashFields) {
      for (const value of ['a'.repeat(63), 'a'.repeat(65), `g${'a'.repeat(63)}`, `A${'a'.repeat(63)}`, 1]) {
        await expectInvalid(
          service.issue(issueRequest({ [field]: value } as Partial<CapabilityIssueRequest>)),
          `${field} must be a lowercase SHA-256 hash`,
        );
      }
    }
  });

  it('reports each malformed timestamp and an empty validity window exactly', async () => {
    const { service } = serviceWith();
    await expectInvalid(
      service.issue(issueRequest({ not_before: 'bad' })),
      'not_before must be an ISO date-time',
    );
    await expectInvalid(
      service.issue(issueRequest({ expires_at: 'bad' })),
      'expires_at must be an ISO date-time',
    );
    await expectInvalid(
      service.issue(issueRequest({ expires_at: NOW })),
      'capability validity window is empty',
    );
  });

  it('enforces issuance skew, expiry, TTL, and UUID boundaries exactly', async () => {
    const allowed = serviceWith({ now: () => '2026-01-01T00:00:10.000Z' });
    await expect(allowed.service.issue(issueRequest())).resolves.toBeDefined();

    const afterSkew = serviceWith({ now: () => '2026-01-01T00:00:10.001Z' });
    await expectInvalid(
      afterSkew.service.issue(issueRequest()),
      'capability is not valid at issuance time',
    );
    const atExpiry = serviceWith({ now: () => '2026-01-01T00:01:00.000Z' });
    await expectInvalid(
      atExpiry.service.issue(
        issueRequest({
          not_before: '2026-01-01T00:00:59.999Z',
          expires_at: '2026-01-01T00:01:00.000Z',
        }),
      ),
      'capability is not valid at issuance time',
    );
    const exactTtl = serviceWith({ max_ttl_ms: 60_000 });
    await expect(exactTtl.service.issue(issueRequest())).resolves.toBeDefined();
    const overTtl = serviceWith({ max_ttl_ms: 59_999 });
    await expectInvalid(
      overTtl.service.issue(issueRequest()),
      'capability lifetime exceeds Authorization Service policy',
    );
    const badClock = serviceWith({ now: () => 'bad' });
    await expectInvalid(badClock.service.issue(issueRequest()), 'current time must be an ISO date-time');
    const badUuid = serviceWith({ random_uuid: () => 'bad' });
    await expectInvalid(badUuid.service.issue(issueRequest()), 'random_uuid returned an invalid UUID');
  });

  it('uses secure working clock and UUID defaults when they are not injected', async () => {
    const keys = generateKeyPairSync('ed25519');
    const now = Date.now();
    const service = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new InMemoryCapabilityStateStore(),
    });
    const signed = await service.issue(
      issueRequest({
        not_before: new Date(now - 1_000).toISOString(),
        expires_at: new Date(now + 30_000).toISOString(),
      }),
    );
    expect(signed.claims.token_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Date.parse(signed.claims.issued_at)).toBeGreaterThanOrEqual(now);
  });
});

describe('AuthorizationService exact envelope and claim contract', () => {
  const requiredClaims = [
    'token_id',
    'operation_id',
    'attempt_id',
    'manifest_hash',
    'policy_decision_hash',
    'tool_effect_contract_hash',
    'subject_workload',
    'tenant_id',
    'audience',
    'tool_grant_hash',
    'resource_grant_hash',
    'budget_ceiling_hash',
    'issued_at',
    'not_before',
    'expires_at',
    'execution_epoch',
    'use_limit',
    'confirmation_key_thumbprint',
  ] as const;

  async function signedFixture(): Promise<{
    service: AuthorizationService;
    signed: SignedCapabilityToken;
  }> {
    const { service } = serviceWith();
    return { service, signed: await service.issue(issueRequest()) };
  }

  it('rejects every missing claim and every unknown claim before signature verification', async () => {
    const { service, signed } = await signedFixture();
    for (const field of requiredClaims) {
      const claims = { ...signed.claims } as Record<string, unknown>;
      delete claims[field];
      await expectInvalid(
        service.verify({ ...signed, claims: claims as unknown as CapabilityToken }),
        'capability claims contain unknown or missing fields',
      );
    }
    await expectInvalid(
      service.verify({ ...signed, claims: { ...signed.claims, extra: true } as CapabilityToken }),
      'capability claims contain unknown or missing fields',
    );
  });

  it('rejects exact claim-shape boundary failures', async () => {
    const { service, signed } = await signedFixture();
    await expectInvalid(
      service.verify({ ...signed, claims: { ...signed.claims, token_id: 'bad' } }),
      'token_id must be a UUID',
    );
    await expectInvalid(
      service.verify({ ...signed, claims: { ...signed.claims, issued_at: 'bad' } }),
      'issued_at must be an ISO date-time',
    );
    await expectInvalid(
      service.verify({
        ...signed,
        claims: { ...signed.claims, issued_at: '2026-01-01T00:00:10.001Z' },
      }),
      'issued_at must not be after not_before',
    );
    await expectInvalid(
      service.verify({
        ...signed,
        claims: { ...signed.claims, use_limit: 0 } as unknown as CapabilityToken,
      }),
      'use_limit must be 1',
    );
    for (const value of ['', 1]) {
      await expectInvalid(
        service.verify({
          ...signed,
          claims: { ...signed.claims, parent_delegation_proof: value } as CapabilityToken,
        }),
        'parent_delegation_proof must be a non-empty string or null',
      );
    }
  });

  it('distinguishes invalid envelope shape, algorithm, signature, and state binding', async () => {
    const { service, signed } = await signedFixture();
    await expectInvalid(
      service.verify(null as unknown as SignedCapabilityToken),
      'invalid signed capability envelope',
    );
    await expectInvalid(
      service.verify({ ...signed, algorithm: 'HS256' as 'Ed25519' }),
      'invalid signed capability envelope',
    );
    await expectInvalid(
      service.verify({ ...signed, extra: true } as SignedCapabilityToken),
      'signed capability contains unknown or missing fields',
    );
    await expectInvalid(
      service.verify({ ...signed, signature: '*' }),
      'capability signature is invalid',
    );

    const other = serviceWith().service;
    await expectInvalid(other.verify(signed), 'capability signature is invalid');
  });
});

describe('AuthorizationService state, time, and consumption outcomes', () => {
  async function controlledFixture() {
    let clock = NOW;
    const stateStore = new ControllableStateStore();
    const { service } = serviceWith({ state_store: stateStore, now: () => clock });
    const signed = await service.issue(issueRequest());
    const issued = stateStore.record!;
    return {
      issued,
      service,
      setClock(value: string) {
        clock = value;
      },
      signed,
      stateStore,
    };
  }

  it('distinguishes missing, hash-mismatched, and signature-mismatched state binding', async () => {
    for (const mutate of [
      (fixture: Awaited<ReturnType<typeof controlledFixture>>) => {
        fixture.stateStore.record = undefined;
      },
      (fixture: Awaited<ReturnType<typeof controlledFixture>>) => {
        fixture.stateStore.record = { ...fixture.issued, token_hash: HASH };
      },
      (fixture: Awaited<ReturnType<typeof controlledFixture>>) => {
        fixture.stateStore.record = { ...fixture.issued, signature: 'different' };
      },
    ]) {
      const fixture = await controlledFixture();
      mutate(fixture);
      await expectInvalid(
        fixture.service.verify(fixture.signed),
        'capability is unknown or state binding failed',
      );
    }
  });

  it('distinguishes used and revoked records before checking time', async () => {
    const used = await controlledFixture();
    used.stateStore.record = { ...used.issued, status: 'used' };
    await expect(used.service.verify(used.signed)).rejects.toEqual(
      new CapabilityUsedError('capability has already been used'),
    );

    const revoked = await controlledFixture();
    revoked.stateStore.record = { ...revoked.issued, status: 'revoked' };
    await expect(revoked.service.verify(revoked.signed)).rejects.toEqual(
      new CapabilityRevokedError('capability has been revoked'),
    );
  });

  it('enforces exact verify clock and confirmation boundaries', async () => {
    const before = await controlledFixture();
    before.setClock('2025-12-31T23:59:59.999Z');
    await expect(before.service.verify(before.signed)).rejects.toEqual(
      new CapabilityNotYetValidError('capability is not yet valid'),
    );

    const expired = await controlledFixture();
    expired.setClock('2026-01-01T00:01:00.000Z');
    await expect(expired.service.verify(expired.signed)).rejects.toEqual(
      new CapabilityExpiredError('capability has expired'),
    );

    const confirmation = await controlledFixture();
    await expectInvalid(
      confirmation.service.verify(confirmation.signed, {
        confirmation_key_thumbprint: 'wrong',
      }),
      'confirmation key mismatch',
    );
    await expect(confirmation.service.verify(confirmation.signed, {})).resolves.toEqual(
      confirmation.signed.claims,
    );
  });

  it('maps every signed consume outcome to its exact public result', async () => {
    const cases = [
      ['consumed', 'resolve', undefined],
      ['revoked', 'reject', new CapabilityRevokedError('capability has been revoked')],
      ['used', 'reject', new CapabilityUsedError('capability has already been used')],
      ['missing', 'reject', new CapabilityInvalidError('capability state binding failed')],
      ['mismatch', 'reject', new CapabilityInvalidError('capability state binding failed')],
    ] as const;

    for (const [outcome, expected, error] of cases) {
      const fixture = await controlledFixture();
      fixture.stateStore.consumeOutcome = outcome;
      const result = fixture.service.consume(fixture.signed);
      if (expected === 'resolve') {
        await expect(result).resolves.toEqual(fixture.signed.claims);
      } else {
        await expect(result).rejects.toEqual(error);
      }
    }
  });

  it('fails closed for unknown or malformed token IDs on the boolean consume port', async () => {
    const fixture = await controlledFixture();
    fixture.stateStore.record = undefined;
    fixture.stateStore.consumeOutcome = 'missing';
    await expect(fixture.service.consume(TOKEN_ID)).resolves.toBe(false);
    fixture.stateStore.consumeOutcome = 'consumed';
    await expect(fixture.service.consume('bad-id')).resolves.toBe(false);
  });
});

describe('AuthorizationService constructor authority contract', () => {
  it('requires key roles, Ed25519, all state methods, and a safe positive TTL', () => {
    const keys = generateKeyPairSync('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const validStore = new InMemoryCapabilityStateStore();

    expect(
      () =>
        new AuthorizationService({
          private_key: keys.publicKey as never,
          public_key: keys.privateKey as never,
          state_store: validStore,
        }),
    ).toThrow(new CapabilityInvalidError('Authorization Service requires an asymmetric key pair'));
    expect(
      () =>
        new AuthorizationService({
          private_key: rsa.privateKey,
          public_key: rsa.publicKey,
          state_store: validStore,
        }),
    ).toThrow(new CapabilityInvalidError('Authorization Service requires Ed25519 keys'));

    for (const missing of ['register', 'read', 'consume', 'revoke'] as const) {
      const stateStore = {
        register: async () => undefined,
        read: async () => undefined,
        consume: async () => 'missing' as const,
        revoke: async () => false,
      };
      delete stateStore[missing];
      expect(
        () =>
          new AuthorizationService({
            private_key: keys.privateKey,
            public_key: keys.publicKey,
            state_store: stateStore as CapabilityStateStore,
          }),
      ).toThrow(new CapabilityInvalidError('state_store is required'));
    }

    for (const maxTtl of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        () =>
          new AuthorizationService({
            private_key: keys.privateKey,
            public_key: keys.publicKey,
            state_store: validStore,
            max_ttl_ms: maxTtl,
          }),
      ).toThrow(new CapabilityInvalidError('max_ttl_ms must be a positive safe integer'));
    }
  });
});
