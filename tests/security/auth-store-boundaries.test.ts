import { createHash } from 'node:crypto';

import type { WebAuthnCredential } from '@simplewebauthn/server';
import bcrypt from 'bcrypt';
import { describe, expect, it } from 'vitest';

import { AuthApi, AuthError, AuthService, InMemoryAuthStore } from '../../security/auth.js';

const NOW = '2026-01-01T00:00:00.000Z';

function credential(overrides: Partial<WebAuthnCredential> = {}): WebAuthnCredential {
  return {
    id: 'credential-1',
    publicKey: new Uint8Array([1]),
    counter: 0,
    transports: ['internal'],
    ...overrides,
  };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'user-1',
    email: 'user@example.test',
    password_hash: 'not-used',
    webauthn_credentials: [] as WebAuthnCredential[],
    ...overrides,
  };
}

function expectAuthError(promise: Promise<unknown>, code: string, status: number) {
  return expect(promise).rejects.toMatchObject({ name: 'AuthError', message: code, code, status });
}

describe('InMemoryAuthStore credential boundaries', () => {
  it('rejects every malformed credential dimension exactly', async () => {
    const invalid: WebAuthnCredential[] = [
      credential({ id: '' }),
      credential({ id: 1 as never }),
      credential({ id: 'a'.repeat(1025) }),
      credential({ id: `*${'a'.repeat(10)}` }),
      credential({ id: `${'a'.repeat(10)}*` }),
      credential({ publicKey: 'not-bytes' as never }),
      credential({ publicKey: new Uint8Array() }),
      credential({ publicKey: new Uint8Array(4097) }),
      credential({ counter: Number.MAX_SAFE_INTEGER + 1 }),
      credential({ counter: -1 }),
      credential({ counter: 1.5 }),
      credential({ transports: 'internal' as never }),
    ];
    for (const value of invalid) {
      const store = new InMemoryAuthStore();
      await store.createUser(user());
      await expectAuthError(store.addWebAuthnCredential('user-1', value), 'webauthn_verification_failed', 400);
      expect(store.findWebAuthnCredential(value.id)).toBeUndefined();
    }
  });

  it('accepts exact credential size boundaries and returns defensive copies', async () => {
    const store = new InMemoryAuthStore();
    const value = credential({
      id: 'a'.repeat(1024),
      publicKey: new Uint8Array(4096).fill(7),
    });
    await store.createUser(user({ webauthn_credentials: [value] }));
    const found = store.findWebAuthnCredential(value.id)!;
    expect(found.credential.id).toBe(value.id);
    expect(found.credential.publicKey).toHaveLength(4096);
    expect(found.credential.transports).toEqual(['internal']);
    expect(Object.isFrozen(found)).toBe(true);
    found.credential.publicKey[0] = 0;
    expect(store.findWebAuthnCredential(value.id)?.credential.publicKey[0]).toBe(7);
  });

  it('rejects duplicate IDs within one user and across users', async () => {
    const within = new InMemoryAuthStore();
    await expectAuthError(
      within.createUser(user({ webauthn_credentials: [credential(), credential()] })),
      'invalid_request',
      400,
    );

    const across = new InMemoryAuthStore();
    await across.createUser(user({ webauthn_credentials: [credential()] }));
    await expectAuthError(
      across.createUser(
        user({
          user_id: 'user-2',
          email: 'two@example.test',
          webauthn_credentials: [credential()],
        }),
      ),
      'invalid_request',
      400,
    );
  });

  it('rejects add-to-missing-user and duplicate-owner operations', async () => {
    const store = new InMemoryAuthStore();
    await expectAuthError(
      store.addWebAuthnCredential('missing', credential()),
      'webauthn_verification_failed',
      400,
    );
    await store.createUser(user());
    await store.addWebAuthnCredential('user-1', credential());
    await expectAuthError(
      store.addWebAuthnCredential('user-1', credential()),
      'webauthn_verification_failed',
      400,
    );
    expect(store.findWebAuthnCredential('missing')).toBeUndefined();
  });

  it('advances counters only for the bound credential and valid monotonic transitions', async () => {
    const store = new InMemoryAuthStore();
    await store.createUser(
      user({
        webauthn_credentials: [credential(), credential({ id: 'credential-2', counter: 7 })],
      }),
    );
    expect(store.updateWebAuthnCounter('missing', 'credential-1', 0, 1)).toBe(false);
    expect(store.updateWebAuthnCounter('user-1', 'missing', 0, 1)).toBe(false);
    expect(store.updateWebAuthnCounter('user-1', 'credential-2', 0, 1)).toBe(false);
    expect(store.updateWebAuthnCounter('user-1', 'credential-1', 1, 2)).toBe(false);
    expect(store.updateWebAuthnCounter('user-1', 'credential-1', 0, -1)).toBe(false);
    expect(store.updateWebAuthnCounter('user-1', 'credential-1', 0, 1.5)).toBe(false);
    expect(store.updateWebAuthnCounter('user-1', 'credential-1', 0, 0)).toBe(true);
    expect(store.updateWebAuthnCounter('user-1', 'credential-1', 0, 1)).toBe(true);
    expect(store.updateWebAuthnCounter('user-1', 'credential-1', 1, 1)).toBe(false);
    expect(store.updateWebAuthnCounter('user-1', 'credential-1', 1, 2)).toBe(true);
    expect(store.findWebAuthnCredential('credential-1')?.credential.counter).toBe(2);
    expect(store.findWebAuthnCredential('credential-2')?.credential.counter).toBe(7);
  });
});

describe('InMemoryAuthStore session and challenge boundaries', () => {
  it('preserves, copies, lists, revokes, and rejects duplicate sessions exactly', async () => {
    const store = new InMemoryAuthStore();
    const record = {
      token_hash: 'token-hash',
      user_id: 'user-1',
      issued_at: NOW,
      expires_at: '2026-01-02T00:00:00.000Z',
    };
    expect(store.findSession('missing')).toBeUndefined();
    expect(store.revokeSession('missing', NOW)).toBe(false);
    store.createSession(record);
    expect(() => store.createSession(record)).toThrow(
      expect.objectContaining({ name: 'AuthError', code: 'authentication_failed', status: 401 }),
    );
    const found = store.findSession('token-hash')!;
    expect(found).toEqual(record);
    found.revoked_at = 'tampered';
    expect(store.findSession('token-hash')).toEqual(record);
    expect(await store.inspectSessions()).toEqual([record]);
    expect(Object.isFrozen((await store.inspectSessions())[0])).toBe(true);
    expect(store.revokeSession('token-hash', '2026-01-01T01:00:00.000Z')).toBe(true);
    expect(store.findSession('token-hash')?.revoked_at).toBe('2026-01-01T01:00:00.000Z');
    expect(store.revokeSession('token-hash', '2026-01-01T02:00:00.000Z')).toBe(false);
  });

  it('consumes each challenge once and purges consumed or expired records before reuse', () => {
    const store = new InMemoryAuthStore();
    const active = {
      key_hash: 'challenge-key',
      kind: 'authentication' as const,
      challenge: 'challenge',
      expires_at: '2026-01-01T00:05:00.000Z',
    };
    expect(store.consumeChallenge('missing', NOW)).toBeUndefined();
    store.createChallenge(active, NOW);
    expect(() => store.createChallenge(active, NOW)).toThrow(
      expect.objectContaining({ name: 'AuthError', code: 'authentication_failed', status: 401 }),
    );
    expect(store.consumeChallenge('challenge-key', NOW)).toEqual({
      record: { ...active, consumed_at: NOW },
      accepted: true,
    });
    expect(store.consumeChallenge('challenge-key', NOW)).toEqual({
      record: { ...active, consumed_at: NOW },
      accepted: false,
    });
    store.createChallenge(active, NOW);
    expect(store.consumeChallenge('challenge-key', NOW)?.accepted).toBe(true);

    store.createChallenge(
      {
        ...active,
        key_hash: 'expired-key',
        expires_at: '2025-12-31T23:59:59.999Z',
      },
      NOW,
    );
    store.createChallenge({ ...active, key_hash: 'replacement-key' }, NOW);
    expect(store.consumeChallenge('expired-key', NOW)).toBeUndefined();
  });
});

describe('Auth input boundaries', () => {
  function service(overrides: Partial<ConstructorParameters<typeof AuthService>[0]> = {}) {
    return new AuthService({
      store: new InMemoryAuthStore(),
      rp_id: 'localhost',
      rp_name: 'Harness',
      origin: 'http://localhost',
      now: () => NOW,
      random_bytes: (length) => new Uint8Array(length).fill(1),
      ...overrides,
    });
  }

  it('rejects non-string, malformed, and overlong email values with one public error', async () => {
    const auth = service();
    const maxEmail = `${'a'.repeat(247)}@b.test`;
    expect(maxEmail).toHaveLength(254);
    for (const email of [
      undefined,
      1,
      'missing-at.example.test',
      '@example.test',
      'user@',
      '@user@example.test',
      'user@example.test@',
      `*${maxEmail}`,
      `${maxEmail}*`,
    ]) {
      await expectAuthError(auth.login(email, 'password', 'client'), 'invalid_request', 400);
    }
    await expectAuthError(auth.login(maxEmail, 'password', 'client'), 'authentication_failed', 401);
  });

  it('normalizes surrounding whitespace and case before account lookup and audit', async () => {
    const auth = service();
    await expectAuthError(auth.login(' USER@Example.Test ', 'password', 'client'), 'authentication_failed', 401);
    expect(auth.auditEvents).toEqual([
      {
        timestamp: NOW,
        action: 'login',
        outcome: 'denied',
        subject_ref: createHash('sha256').update('user@example.test').digest('hex'),
        reason_code: 'authentication_failed',
      },
    ]);
  });

  it('enforces constructor and client string length boundaries', async () => {
    for (const options of [
      { rp_id: undefined },
      { rp_id: '' },
      { rp_id: 'a'.repeat(254) },
      { rp_name: 'a'.repeat(129) },
      { origin: 'a'.repeat(2049) },
    ]) {
      expect(() => service(options as never)).toThrow(
        expect.objectContaining({ name: 'AuthError', code: 'invalid_request', status: 400 }),
      );
    }
    const auth = service({ rp_id: 'a'.repeat(253), rp_name: 'a'.repeat(128) });
    await expectAuthError(auth.login('user@example.test', 'password', 'a'.repeat(257)), 'invalid_request', 400);
  });

  it('allows HTTPS origins, rejects insecure remote HTTP, and enforces the 72-byte password limit', async () => {
    expect(() => service({ origin: 'https://example.test' })).not.toThrow();
    expect(() => service({ origin: 'http://example.test' })).toThrow(
      expect.objectContaining({ name: 'AuthError', code: 'invalid_request', status: 400 }),
    );
    const auth = service();
    await expectAuthError(auth.login('user@example.test', 'a'.repeat(72), 'client'), 'authentication_failed', 401);
    await expectAuthError(auth.login('user@example.test', 'a'.repeat(73), 'client'), 'invalid_request', 400);
    await expectAuthError(auth.login('user@example.test', 'é'.repeat(37), 'client'), 'invalid_request', 400);
  });

  it('records exact allowed, rate-limited, and anonymous-session audit events', async () => {
    const store = new InMemoryAuthStore();
    await store.createUser(
      user({
        password_hash: await bcrypt.hash('correct-password', 12),
      }),
    );
    const auth = service({ store });
    await expect(auth.login('user@example.test', 'correct-password', 'client')).resolves.toMatchObject({
      user_id: 'user-1',
    });
    expect(auth.auditEvents.at(-1)).toEqual({
      timestamp: NOW,
      action: 'login',
      outcome: 'allowed',
      subject_ref: createHash('sha256').update('user-1').digest('hex'),
      reason_code: 'authenticated',
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expectAuthError(auth.login('blocked@example.test', 'wrong', 'blocked-client'), 'authentication_failed', 401);
    }
    await expectAuthError(auth.login('blocked@example.test', 'wrong', 'blocked-client'), 'rate_limited', 429);
    expect(auth.auditEvents.at(-1)).toEqual({
      timestamp: NOW,
      action: 'login',
      outcome: 'denied',
      subject_ref: createHash('sha256').update('blocked@example.test').digest('hex'),
      reason_code: 'rate_limited',
    });

    expect(() => auth.authenticate('')).toThrow(
      expect.objectContaining({ code: 'authentication_required', status: 401 }),
    );
    expect(auth.auditEvents.at(-1)).toEqual({
      timestamp: NOW,
      action: 'session_check',
      outcome: 'denied',
      subject_ref: createHash('sha256').update('anonymous').digest('hex'),
      reason_code: 'authentication_required',
    });
  }, 30_000);

  it('fails closed when the injected clock is not an ISO instant', async () => {
    const auth = service({ now: () => 'not-an-instant' });
    await expect(auth.login('user@example.test', 'password', 'client')).rejects.toThrow('invalid clock value');
  });
});

describe('Auth cookie parser boundaries', () => {
  async function fixture() {
    const store = new InMemoryAuthStore();
    await store.createUser(user());
    const token = 'a'.repeat(43);
    store.createSession({
      token_hash: createHash('sha256').update(token).digest('hex'),
      user_id: 'user-1',
      issued_at: NOW,
      expires_at: '2026-01-02T00:00:00.000Z',
    });
    const service = new AuthService({
      store,
      rp_id: 'localhost',
      rp_name: 'Harness',
      origin: 'http://localhost',
      now: () => NOW,
      random_bytes: (length) => new Uint8Array(length).fill(1),
    });
    return { api: new AuthApi(service), token };
  }

  it('accepts exactly one well-formed host cookie among unrelated cookies', async () => {
    const { api, token } = await fixture();
    await expect(
      api.handle({
        method: 'GET',
        path: '/auth/me',
        cookie: `other=value; __Host-harness_session=${token}`,
      }),
    ).resolves.toEqual({ status: 200, headers: {}, body: { user_id: 'user-1' } });
  });

  it('rejects malformed login bodies and unknown authentication methods exactly', async () => {
    const { api } = await fixture();
    for (const body of [null, [], 'password', 1, { method: 'unknown' }]) {
      await expect(
        api.handle({
          method: 'POST',
          path: '/auth/login',
          client_id: 'client',
          body,
        }),
      ).resolves.toEqual({
        status: 400,
        headers: {},
        body: { error: 'invalid_request' },
      });
    }
  });

  it('rejects duplicate, truncated, extended, and invalid-alphabet session cookies', async () => {
    const { api, token } = await fixture();
    for (const cookie of [
      `__Host-harness_session=${token}; __Host-harness_session=${token}`,
      `__Host-harness_session=${token.slice(1)}`,
      `__Host-harness_session=${token}a`,
      `__Host-harness_session=*${token}`,
      `__Host-harness_session=${token}*`,
      `__Host-harness_session=${token}=extra`,
    ]) {
      await expect(api.handle({ method: 'GET', path: '/auth/me', cookie })).resolves.toEqual({
        status: 401,
        headers: {},
        body: { error: 'authentication_required' },
      });
    }
  });

  it('preserves AuthError identity and exact public fields', () => {
    expect(new AuthError('invalid_request', 400)).toMatchObject({
      name: 'AuthError',
      message: 'invalid_request',
      code: 'invalid_request',
      status: 400,
    });
  });
});
