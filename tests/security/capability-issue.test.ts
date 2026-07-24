import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  AuthorizationService,
  InMemoryCapabilityStateStore,
  type CapabilityIssueRequest,
} from '../../security/authorization-service.js';
import {
  CapabilityExpiredError,
  CapabilityInvalidError,
  CapabilityNotYetValidError,
  CapabilityRevokedError,
  CredentialDispatchError,
  hashCapabilityValue,
  type SignedCapabilityToken,
} from '../../security/capability.js';
import type { CapabilityAuthorityPort } from '../../security/pep.js';

const HASHES = {
  manifest: 'a'.repeat(64),
  policy: 'b'.repeat(64),
  effect: 'c'.repeat(64),
  tool: 'd'.repeat(64),
  resource: 'e'.repeat(64),
  budget: 'f'.repeat(64),
};
const NOW = '2026-01-01T00:00:00.000Z';

function request(overrides: Partial<CapabilityIssueRequest> = {}): CapabilityIssueRequest {
  return {
    operation_id: 'operation-1',
    attempt_id: 'attempt-1',
    manifest_hash: HASHES.manifest,
    policy_decision_hash: HASHES.policy,
    tool_effect_contract_hash: HASHES.effect,
    subject_workload: 'single-agent-runtime',
    tenant_id: 'tenant-1',
    audience: 'harness-tool-host',
    tool_grant_hash: HASHES.tool,
    resource_grant_hash: HASHES.resource,
    budget_ceiling_hash: HASHES.budget,
    execution_epoch: 'epoch-1',
    confirmation_key_thumbprint: 'key-thumbprint-1',
    not_before: NOW,
    expires_at: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function setup(now = NOW) {
  const keys = generateKeyPairSync('ed25519');
  const service = new AuthorizationService({
    private_key: keys.privateKey,
    public_key: keys.publicKey,
    state_store: new InMemoryCapabilityStateStore(),
    now: () => now,
    random_uuid: () => '11111111-1111-4111-8111-111111111111',
  });
  return { service, keys };
}

describe('AuthorizationService issue and verify', () => {
  it('issues all Contract fields in a signed immutable envelope', async () => {
    const { service } = setup();
    const signed = await service.issue(request());

    expect(signed.algorithm).toBe('Ed25519');
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(signed.claims).toEqual({
      token_id: '11111111-1111-4111-8111-111111111111',
      ...request(),
      issued_at: NOW,
      use_limit: 1,
    });
    expect(Object.isFrozen(signed)).toBe(true);
    expect(Object.isFrozen(signed.claims)).toBe(true);
    expect(Object.keys(signed.claims)).not.toContain('user_data');
    await expect(
      service.verify(signed, { confirmation_key_thumbprint: 'key-thumbprint-1' }),
    ).resolves.toEqual(signed.claims);
  });

  it('rejects malformed issue input, invalid ordering, excessive lifetime and user-content fields', async () => {
    const { service } = setup();
    await expect(service.issue(request({ manifest_hash: 'bad' }))).rejects.toBeInstanceOf(
      CapabilityInvalidError,
    );
    await expect(
      service.issue(request({ not_before: '2026-01-01T00:02:00.000Z' })),
    ).rejects.toBeInstanceOf(CapabilityInvalidError);
    await expect(
      service.issue(request({ expires_at: '2026-01-01T01:00:01.000Z' })),
    ).rejects.toBeInstanceOf(CapabilityInvalidError);
    await expect(
      service.issue({ ...request(), conversation: 'private prompt' } as CapabilityIssueRequest),
    ).rejects.toBeInstanceOf(CapabilityInvalidError);
  });

  it('strictly validates every issue field and injected authority dependency', async () => {
    const { service, keys } = setup();
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
    for (const field of nonEmptyFields) {
      await expect(service.issue(request({ [field]: '' }))).rejects.toBeInstanceOf(
        CapabilityInvalidError,
      );
    }
    for (const field of hashFields) {
      await expect(service.issue(request({ [field]: `A${'a'.repeat(63)}` }))).rejects.toBeInstanceOf(
        CapabilityInvalidError,
      );
    }
    await expect(service.issue(null as unknown as CapabilityIssueRequest)).rejects.toBeInstanceOf(
      CapabilityInvalidError,
    );
    const missing = request() as unknown as Record<string, unknown>;
    delete missing.audience;
    await expect(service.issue(missing as unknown as CapabilityIssueRequest)).rejects.toBeInstanceOf(
      CapabilityInvalidError,
    );
    await expect(service.issue(request({ not_before: 'not-a-date' }))).rejects.toBeInstanceOf(
      CapabilityInvalidError,
    );

    const invalidStores = [null, {}, { register() {} }, { register() {}, read() {} }] as const;
    for (const stateStore of invalidStores) {
      expect(
        () =>
          new AuthorizationService({
            private_key: keys.privateKey,
            public_key: keys.publicKey,
            state_store: stateStore as never,
          }),
      ).toThrow(CapabilityInvalidError);
    }
    for (const maxTtl of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        () =>
          new AuthorizationService({
            private_key: keys.privateKey,
            public_key: keys.publicKey,
            state_store: new InMemoryCapabilityStateStore(),
            max_ttl_ms: maxTtl,
          }),
      ).toThrow(CapabilityInvalidError);
    }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(
      () =>
        new AuthorizationService({
          private_key: rsa.privateKey,
          public_key: rsa.publicKey,
          state_store: new InMemoryCapabilityStateStore(),
        }),
    ).toThrow(CapabilityInvalidError);
    expect(
      () =>
        new AuthorizationService({
          private_key: keys.publicKey as never,
          public_key: keys.privateKey as never,
          state_store: new InMemoryCapabilityStateStore(),
        }),
    ).toThrow(CapabilityInvalidError);
  });

  it('fails closed for invalid clocks, UUID generation, not-before and exact expiry boundaries', async () => {
    const keys = generateKeyPairSync('ed25519');
    const make = (now: () => string, uuid = () => '11111111-1111-4111-8111-111111111111') =>
      new AuthorizationService({
        private_key: keys.privateKey,
        public_key: keys.publicKey,
        state_store: new InMemoryCapabilityStateStore(),
        now,
        random_uuid: uuid,
      });

    await expect(make(() => 'bad-clock').issue(request())).rejects.toBeInstanceOf(
      CapabilityInvalidError,
    );
    await expect(make(() => NOW, () => 'not-a-uuid').issue(request())).rejects.toBeInstanceOf(
      CapabilityInvalidError,
    );
   await expect(
     make(() => '2026-01-01T00:00:11.000Z').issue(request()),
   ).rejects.toBeInstanceOf(CapabilityInvalidError);

    let clock = NOW;
    const service = make(() => clock);
    const delayed = await service.issue(
      request({
        not_before: '2026-01-01T00:00:10.000Z',
        expires_at: '2026-01-01T00:01:00.000Z',
      }),
    );
    await expect(service.verify(delayed)).rejects.toBeInstanceOf(CapabilityNotYetValidError);
    clock = delayed.claims.not_before;
    await expect(service.verify(delayed)).resolves.toEqual(delayed.claims);
  });

  it('rejects signature, claims and confirmation-key tampering before execution', async () => {
    const { service } = setup();
    const signed = await service.issue(request());
    const tamperedSignature =
      `${signed.signature.startsWith('A') ? 'B' : 'A'}${signed.signature.slice(1)}`;

    await expect(
      service.verify({ ...signed, signature: tamperedSignature }),
    ).rejects.toBeInstanceOf(CapabilityInvalidError);
    await expect(
      service.verify({
        ...signed,
        claims: { ...signed.claims, audience: 'attacker' },
      }),
    ).rejects.toBeInstanceOf(CapabilityInvalidError);
    await expect(
      service.verify(signed, { confirmation_key_thumbprint: 'wrong-key' }),
    ).rejects.toBeInstanceOf(CapabilityInvalidError);
  });

  it('rejects malformed envelopes, unknown records and malformed Contract claims', async () => {
    const { service, keys } = setup();
    const signed = await service.issue(request());
    const malformed: unknown[] = [
      null,
      { ...signed, algorithm: 'HS256' },
      { ...signed, extra: true },
      { algorithm: 'Ed25519', signature: signed.signature },
      { ...signed, signature: '*' },
      { ...signed, claims: { ...signed.claims, token_id: 'bad' } },
      { ...signed, claims: { ...signed.claims, use_limit: 2 } },
      { ...signed, claims: { ...signed.claims, parent_delegation_proof: '' } },
      { ...signed, claims: { ...signed.claims, extra: true } },
    ];
    for (const value of malformed) {
      await expect(service.verify(value as SignedCapabilityToken)).rejects.toBeInstanceOf(
        CapabilityInvalidError,
      );
      const malformedClaims = (value as SignedCapabilityToken | null)?.claims;
      if (malformedClaims !== signed.claims) {
        await expect(service.verify_signature(malformedClaims as never)).resolves.toBe(false);
      }
    }

    const other = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new InMemoryCapabilityStateStore(),
      now: () => NOW,
    });
    await expect(other.verify(signed)).rejects.toBeInstanceOf(CapabilityInvalidError);
  });

  it('uses recursive canonical hashing without changing array order', () => {
    expect(hashCapabilityValue({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashCapabilityValue({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(hashCapabilityValue({ values: [1, 2] })).not.toBe(
      hashCapabilityValue({ values: [2, 1] }),
    );
  });

  it('implements the PEP authority port without exposing signing authority', async () => {
    const { service } = setup();
    const authority: CapabilityAuthorityPort = service;
    const signed = await service.issue(request());

    await expect(authority.verify_signature(signed.claims)).resolves.toBe(true);
    await expect(authority.consume(signed.claims.token_id)).resolves.toBe(true);
    await expect(authority.consume(signed.claims.token_id)).resolves.toBe(false);
    await expect(authority.verify_signature(signed.claims)).resolves.toBe(false);
    expect('sign' in authority).toBe(false);
  });

  it('rejects expired and revoked capabilities', async () => {
    const keys = generateKeyPairSync('ed25519');
    let clock = NOW;
    const service = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new InMemoryCapabilityStateStore(),
      now: () => clock,
      random_uuid: () => '11111111-1111-4111-8111-111111111111',
    });
    const signed = await service.issue(request());

    clock = signed.claims.expires_at;
    await expect(service.verify(signed)).rejects.toBeInstanceOf(CapabilityExpiredError);
    clock = NOW;
    await service.revoke(signed.claims.token_id);
    await expect(service.verify(signed)).rejects.toBeInstanceOf(CapabilityRevokedError);
    await expect(service.revoke(signed.claims.token_id)).resolves.toBe(false);
    await expect(service.revoke('bad-id')).rejects.toBeInstanceOf(CapabilityInvalidError);
  });
});

describe('credential reachability boundary', () => {
  it('exchanges once at dispatch, passes credential explicitly, and disposes it without env leakage', async () => {
    const { service } = setup();
    const signed = await service.issue(request());
    const exchange = vi.fn(async () => ({
      value: Buffer.from('dispatch-only-secret'),
      dispose: vi.fn(),
    }));
    const dispatch = vi.fn(async (credential: Uint8Array) => {
      expect(Buffer.from(credential).toString()).toBe('dispatch-only-secret');
      expect(Object.values(process.env)).not.toContain('dispatch-only-secret');
      return 'ok';
    });

    await expect(
      service.dispatchWithExchangedCredential({
        capability: signed,
        confirmation_key_thumbprint: 'key-thumbprint-1',
        exchange,
        dispatch,
      }),
    ).resolves.toBe('ok');
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(Object.values(process.env)).not.toContain('dispatch-only-secret');
  });

  it('disposes credentials when dispatch fails and rejects reused capabilities before exchange', async () => {
    const { service } = setup();
    const signed = await service.issue(request());
    const dispose = vi.fn();
    const exchange = vi.fn(async () => ({ value: Buffer.from('secret'), dispose }));

    await expect(
      service.dispatchWithExchangedCredential({
        capability: signed,
        confirmation_key_thumbprint: 'key-thumbprint-1',
        exchange,
        dispatch: async () => {
          throw new Error('tool failed');
        },
      }),
    ).rejects.toThrow('tool failed');
    expect(dispose).toHaveBeenCalledTimes(1);

    await expect(
      service.dispatchWithExchangedCredential({
        capability: signed,
        confirmation_key_thumbprint: 'key-thumbprint-1',
        exchange,
        dispatch: async () => 'must not run',
      }),
    ).rejects.toBeInstanceOf(CredentialDispatchError);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('rejects the wrong confirmation key before credential exchange', async () => {
    const { service } = setup();
    const signed = await service.issue(request());
    const exchange = vi.fn(async () => ({
      value: Buffer.from('must-not-be-issued'),
      dispose: vi.fn(),
    }));

    await expect(
      service.dispatchWithExchangedCredential({
        capability: signed,
        confirmation_key_thumbprint: 'wrong-key',
        exchange,
        dispatch: async () => 'must not run',
      }),
    ).rejects.toBeInstanceOf(CredentialDispatchError);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('rejects malformed exchanged credentials and zeroes bytes before disposal', async () => {
    const { service } = setup();
    const malformed = await service.issue(request());
    await expect(
      service.dispatchWithExchangedCredential({
        capability: malformed,
        confirmation_key_thumbprint: 'key-thumbprint-1',
        exchange: async () => ({ value: 'secret' as never, dispose: vi.fn() }),
        dispatch: async () => 'must not run',
      }),
    ).rejects.toBeInstanceOf(CredentialDispatchError);

    const { service: secondService } = setup();
    const second = await secondService.issue({ ...request(), operation_id: 'operation-2' });
    const bytes = Buffer.from('secret');
    let zeroedAtDispose = false;
    await secondService.dispatchWithExchangedCredential({
      capability: second,
      confirmation_key_thumbprint: 'key-thumbprint-1',
      exchange: async () => ({
        value: bytes,
        dispose: () => {
          zeroedAtDispose = bytes.every((value) => value === 0);
        },
      }),
      dispatch: async () => 'ok',
    });
    expect(zeroedAtDispose).toBe(true);
  });
});
