import { describe, expect, it, vi } from 'vitest';

import { AuthApi, AuthError, AuthService, InMemoryAuthStore, type WebAuthnPort } from '../../security/auth.js';

const NOW = '2026-01-01T00:00:00.000Z';

function setup(options: { webauthn?: WebAuthnPort } = {}) {
  let now = Date.parse(NOW);
  let sequence = 0;
  const store = new InMemoryAuthStore();
  const service = new AuthService({
    store,
    rp_id: 'localhost',
    rp_name: 'Harness',
    origin: 'http://localhost',
    now: () => new Date(now).toISOString(),
    random_bytes: (length) => Buffer.alloc(length, ++sequence),
    ...(options.webauthn === undefined ? {} : { webauthn: options.webauthn }),
  });
  return {
    store,
    service,
    api: new AuthApi(service),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function cookieToken(setCookie: string): string {
  return setCookie.split(';', 1)[0]!.split('=', 2)[1]!;
}

function webauthnPort(overrides: Record<string, unknown> = {}): WebAuthnPort {
  return {
    generateRegistrationOptions: vi.fn(async () => ({ challenge: 'registration-challenge' }) as never),
    verifyRegistrationResponse: vi.fn(async () => ({ verified: false }) as never),
    generateAuthenticationOptions: vi.fn(
      async () =>
        ({
          challenge: 'authentication-challenge',
          rpId: 'localhost',
          timeout: 300_000,
          userVerification: 'required',
        }) as never,
    ),
    verifyAuthenticationResponse: vi.fn(async () => ({ verified: false }) as never),
    ...overrides,
  } as unknown as WebAuthnPort;
}

describe('AH-CAPMAP-002 password authentication and sessions', () => {
  it('hashes passwords with bcrypt cost 12 and never stores plaintext', async () => {
    const { service, store } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'User@Example.test',
      password: 'correct horse battery staple',
    });

    const record = await store.findUserByEmail('user@example.test');
    expect(record?.password_hash).toMatch(/^\$2[aby]\$12\$/u);
    expect(JSON.stringify(record)).not.toContain('correct horse battery staple');
  });

  it('POST /auth/login returns a 24h Secure HttpOnly host cookie for valid credentials', async () => {
    const { service, api, store } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });

    const response = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toMatch(
      /^__Host-harness_session=[A-Za-z0-9_-]+; Max-Age=86400; Path=\/; HttpOnly; Secure; SameSite=Strict$/u,
    );
    expect(response.body).toEqual({ authenticated: true });
    const rawToken = cookieToken(response.headers['set-cookie']!);
    expect(JSON.stringify(await store.inspectSessions())).not.toContain(rawToken);
  });

  it('returns generic 401 for five invalid attempts, then 429 for exactly 15 minutes', async () => {
    const { service, api, advance } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'client-1',
        body: {
          method: 'password',
          email: 'user@example.test',
          password: 'wrong-password',
        },
      });
      expect(response).toMatchObject({
        status: 401,
        body: { error: 'authentication_failed' },
      });
      expect(JSON.stringify(response)).not.toContain('user@example.test');
      expect(JSON.stringify(response)).not.toContain('wrong-password');
    }
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'client-1',
        body: {
          method: 'password',
          email: 'user@example.test',
          password: 'correct horse battery staple',
        },
      }),
    ).resolves.toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    advance(15 * 60 * 1000 - 1);
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'client-1',
        body: {
          method: 'password',
          email: 'user@example.test',
          password: 'correct horse battery staple',
        },
      }),
    ).resolves.toMatchObject({ status: 429 });
    advance(1);
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'client-1',
        body: {
          method: 'password',
          email: 'user@example.test',
          password: 'correct horse battery staple',
        },
      }),
    ).resolves.toMatchObject({ status: 200 });
  }, 30_000);

  it('does not reveal whether an email exists and never logs credentials or email', async () => {
    const { api, service } = setup();
    const unknown = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'private@example.test',
        password: 'super-private-password',
      },
    });
    expect(unknown).toEqual({
      status: 401,
      headers: {},
      body: { error: 'authentication_failed' },
    });
    const serializedAudit = JSON.stringify(service.auditEvents);
    expect(serializedAudit).not.toContain('private@example.test');
    expect(serializedAudit).not.toContain('super-private-password');
  });

  it('GET /auth/me authorizes only a live session and logout invalidates it', async () => {
    const { api, service, advance } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const login = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const cookie = login.headers['set-cookie']!.split(';', 1)[0]!;

    await expect(api.handle({ method: 'GET', path: '/auth/me', cookie })).resolves.toMatchObject({
      status: 200,
      body: { user_id: 'user-1' },
    });
    await expect(api.handle({ method: 'GET', path: '/auth/me' })).resolves.toEqual({
      status: 401,
      headers: {},
      body: { error: 'authentication_required' },
    });
    const logout = await api.handle({
      method: 'POST',
      path: '/auth/logout',
      cookie,
    });
    expect(logout).toMatchObject({
      status: 200,
      body: { authenticated: false },
    });
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    await expect(api.handle({ method: 'GET', path: '/auth/me', cookie })).resolves.toMatchObject({
      status: 401,
    });

    const second = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    advance(24 * 60 * 60 * 1000 - 1);
    await expect(
      api.handle({
        method: 'GET',
        path: '/auth/me',
        cookie: second.headers['set-cookie']!.split(';', 1)[0]!,
      }),
    ).resolves.toMatchObject({ status: 200 });
    advance(1);
    await expect(
      api.handle({
        method: 'GET',
        path: '/auth/me',
        cookie: second.headers['set-cookie']!.split(';', 1)[0]!,
      }),
    ).resolves.toMatchObject({ status: 401 });
  }, 30_000);

  it('fails closed on duplicate session cookies and logout without a session', async () => {
    const { service, api } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const login = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const validCookie = login.headers['set-cookie']!.split(';', 1)[0]!;
    await expect(
      api.handle({
        method: 'GET',
        path: '/auth/me',
        cookie:
          '__Host-harness_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; __Host-harness_session=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: 'authentication_required' },
    });
    for (const malformed of [
      `${validCookie}=extra`,
      `${validCookie}x`,
      `x${validCookie}`,
      '__Host-harness_session=short',
    ]) {
      await expect(api.handle({ method: 'GET', path: '/auth/me', cookie: malformed })).resolves.toMatchObject({
        status: 401,
        body: { error: 'authentication_required' },
      });
    }
    await expect(api.handle({ method: 'POST', path: '/auth/logout' })).resolves.toMatchObject({
      status: 401,
      body: { error: 'authentication_required' },
    });
  });

  it('enforces account-wide rate limits even when an attacker rotates client identifiers', async () => {
    const { service, api } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'blocked-client',
        body: {
          method: 'password',
          email: 'USER@example.test',
          password: 'wrong-password',
        },
      });
    }
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'other-client',
        body: {
          method: 'password',
          email: 'user@example.test',
          password: 'correct horse battery staple',
        },
      }),
    ).resolves.toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  }, 30_000);

  it('enforces client-wide rate limits across account identifiers', async () => {
    const { service, api } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'shared-client',
        body: {
          method: 'password',
          email: `unknown-${attempt}@example.test`,
          password: 'wrong-password',
        },
      });
    }
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'shared-client',
        body: {
          method: 'password',
          email: 'user@example.test',
          password: 'correct horse battery staple',
        },
      }),
    ).resolves.toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  }, 30_000);

  it('does not let a successful account reset the client-wide brute-force bucket', async () => {
    const { service, api } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'shared-client',
        body: { method: 'password', email: `unknown-${attempt}@example.test`, password: 'wrong-password' },
      });
    }
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'shared-client',
        body: { method: 'password', email: 'user@example.test', password: 'correct horse battery staple' },
      }),
    ).resolves.toMatchObject({ status: 200 });
    await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'shared-client',
      body: { method: 'password', email: 'fifth-unknown@example.test', password: 'wrong-password' },
    });
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'shared-client',
        body: { method: 'password', email: 'user@example.test', password: 'correct horse battery staple' },
      }),
    ).resolves.toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  }, 30_000);

  it('strictly rejects malformed requests without reflecting PII', async () => {
    const { api } = setup();
    for (const request of [
      { method: 'POST', path: '/auth/login', client_id: 'x', body: null },
      {
        method: 'POST',
        path: '/auth/login',
        client_id: 'x',
        body: { method: 'password', email: 'bad', password: 'x' },
      },
      { method: 'GET', path: '/unknown' },
    ]) {
      const response = await api.handle(request as never);
      expect([400, 404]).toContain(response.status);
      expect(JSON.stringify(response)).not.toContain('bad');
    }
  });

  it('validates security-sensitive account, password, origin, and entropy boundaries', async () => {
    const { service } = setup();
    await expect(
      service.registerPasswordUser({
        user_id: '',
        email: 'user@example.test',
        password: 'password',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'invalid_request', status: 400 }));
    await expect(
      service.registerPasswordUser({
        user_id: 'user-1',
        email: 'invalid',
        password: 'password',
      }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      service.registerPasswordUser({
        user_id: 'user-1',
        email: 'user@example.test',
        password: '界'.repeat(25),
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'invalid_request',
    });
    expect(
      () =>
        new AuthService({
          store: new InMemoryAuthStore(),
          rp_id: 'example.test',
          rp_name: 'Harness',
          origin: 'http://example.test',
        }),
    ).toThrowError(AuthError);

    const shortEntropy = new AuthService({
      store: new InMemoryAuthStore(),
      rp_id: 'localhost',
      rp_name: 'Harness',
      origin: 'http://localhost',
      random_bytes: () => new Uint8Array(31),
    });
    await shortEntropy.registerPasswordUser({
      user_id: 'user-2',
      email: 'other@example.test',
      password: 'password',
    });
    await expect(shortEntropy.login('other@example.test', 'password', 'client')).rejects.toMatchObject({
      code: 'authentication_failed',
      status: 401,
    });
  }, 30_000);

  it('rejects duplicate identities and preserves store copies', async () => {
    const store = new InMemoryAuthStore();
    const record = {
      user_id: 'user-1',
      email: 'user@example.test',
      password_hash: '$2b$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
      webauthn_credentials: [],
    };
    await store.createUser(record);
    await expect(store.createUser(record)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(store.createUser({ ...record, user_id: 'user-2' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(store.createUser({ ...record, email: 'other@example.test' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const found = await store.findUserByEmail('user@example.test');
    expect(found).toEqual(record);
    expect(store.getUser('missing')).toBeUndefined();
    expect(await store.inspectSessions()).toEqual([]);
  });

  it('matches methods and paths exactly and maps unexpected failures to a generic response', async () => {
    const { api } = setup();
    for (const request of [
      { method: 'GET', path: '/auth/login' },
      { method: 'POST', path: '/auth/me' },
      { method: 'GET', path: '/auth/logout' },
      { method: 'GET', path: '/auth/webauthn/register' },
      { method: 'GET', path: '/auth/webauthn/verify' },
    ]) {
      await expect(api.handle(request)).resolves.toEqual({
        status: 404,
        headers: {},
        body: { error: 'not_found' },
      });
    }
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'client',
        body: [],
      }),
    ).resolves.toEqual({
      status: 400,
      headers: {},
      body: { error: 'invalid_request' },
    });
    for (const body of [null, 'credentials', 42, true]) {
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
    const unexpected = new AuthApi({
      login: async () => {
        throw new Error('private failure');
      },
    } as never);
    await expect(
      unexpected.handle({
        method: 'POST',
        path: '/auth/login',
        client_id: 'client',
        body: {
          method: 'password',
          email: 'user@example.test',
          password: 'private-password',
        },
      }),
    ).resolves.toEqual({
      status: 400,
      headers: {},
      body: { error: 'invalid_request' },
    });
  });
});

describe('AH-CAPMAP-002 WebAuthn', () => {
  it('POST /auth/webauthn/register uses the real library to issue a single-use challenge', async () => {
    const { service, api } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const login = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const cookie = login.headers['set-cookie']!.split(';', 1)[0]!;

    const registration = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/register',
      cookie,
    });
    expect(registration.status).toBe(200);
    expect(registration.body).toMatchObject({
      rp: { id: 'localhost', name: 'Harness' },
      user: { name: 'user@example.test' },
      authenticatorSelection: { userVerification: 'required' },
    });
    expect((registration.body as { challenge: string }).challenge.length).toBeGreaterThan(20);
  }, 30_000);

  it('POST /auth/webauthn/verify validates through the verifier, consumes challenge, and returns a session', async () => {
    const port = webauthnPort({
      generateRegistrationOptions: vi.fn(
        async () =>
          ({
            challenge: 'challenge-1',
            rp: { id: 'localhost', name: 'Harness' },
            user: {
              id: 'dXNlci0x',
              name: 'user@example.test',
              displayName: 'Harness user',
            },
            pubKeyCredParams: [],
            timeout: 300_000,
            attestation: 'none',
            excludeCredentials: [],
            authenticatorSelection: {
              residentKey: 'preferred',
              userVerification: 'required',
            },
            extensions: {},
          }) as never,
      ),
      verifyRegistrationResponse: vi.fn(async (options) => {
        expect(options.expectedChallenge).toBe('challenge-1');
        expect(options.expectedOrigin).toBe('http://localhost');
        expect(options.expectedRPID).toBe('localhost');
        expect(options.requireUserPresence).toBe(true);
        expect(options.requireUserVerification).toBe(true);
        return {
          verified: true,
          registrationInfo: {
            fmt: 'none',
            aaguid: '00000000-0000-0000-0000-000000000000',
            credential: {
              id: 'credential-1',
              publicKey: new Uint8Array([1, 2, 3]),
              counter: 0,
              transports: [],
            },
            credentialType: 'public-key',
            attestationObject: new Uint8Array(),
            userVerified: true,
            credentialDeviceType: 'singleDevice',
            credentialBackedUp: false,
            origin: 'http://localhost',
            rpID: 'localhost',
            authenticatorExtensionResults: {},
          },
        } as never;
      }),
    });
    const { service, api, store } = setup({ webauthn: port });
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const login = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const cookie = login.headers['set-cookie']!.split(';', 1)[0]!;
    const registration = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/register',
      cookie,
    });
    const ceremonyCookie = registration.headers['set-cookie']!.split(';', 1)[0]!;

    const response = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/verify',
      cookie: ceremonyCookie,
      body: {
        credential: {
          id: 'credential-1',
          rawId: 'credential-1',
          response: {},
          type: 'public-key',
          clientExtensionResults: {},
        },
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: true });
    expect(response.headers['set-cookie']).toContain('HttpOnly; Secure');
    await expect(store.findUserByEmail('user@example.test')).resolves.toMatchObject({
      webauthn_credentials: [
        {
          id: 'credential-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: [],
        },
      ],
    });
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/webauthn/verify',
        cookie: ceremonyCookie,
        body: {
          credential: {
            id: 'credential-1',
            rawId: 'credential-1',
            response: {},
            type: 'public-key',
            clientExtensionResults: {},
          },
        },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: 'webauthn_verification_failed' },
    });
  }, 30_000);

  it('real verifier fails closed on malformed WebAuthn data without leaking library errors', async () => {
    const { service, api } = setup();
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const login = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const cookie = login.headers['set-cookie']!.split(';', 1)[0]!;
    const registration = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/register',
      cookie,
    });
    const response = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/verify',
      cookie: registration.headers['set-cookie']!.split(';', 1)[0]!,
      body: { credential: { malformed: true } },
    });
    expect(response).toEqual({
      status: 400,
      headers: {},
      body: { error: 'webauthn_verification_failed' },
    });
  }, 30_000);

  it('expires and consumes registration challenges before invoking the verifier', async () => {
    const verify = vi.fn(async () => ({ verified: false }) as never);
    const port = webauthnPort({
      generateRegistrationOptions: vi.fn(async () => ({ challenge: 'challenge-1' }) as never),
      verifyRegistrationResponse: verify,
    });
    const { service, api, advance } = setup({ webauthn: port });
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const login = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const cookie = login.headers['set-cookie']!.split(';', 1)[0]!;
    const registration = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/register',
      cookie,
    });
    const ceremonyCookie = registration.headers['set-cookie']!.split(';', 1)[0]!;
    advance(5 * 60 * 1000);
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/webauthn/verify',
        cookie: ceremonyCookie,
        body: { credential: {} },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: 'webauthn_verification_failed' },
    });
    expect(verify).not.toHaveBeenCalled();
  }, 30_000);

  it('accepts a challenge immediately before expiry and enforces user verification', async () => {
    const verify = vi.fn(
      async () =>
        ({
          verified: true,
          registrationInfo: {
            userVerified: false,
            credential: {
              id: 'must-not-store',
              publicKey: new Uint8Array([1]),
              counter: 0,
            },
          },
        }) as never,
    );
    const port = webauthnPort({
      generateRegistrationOptions: vi.fn(async () => ({ challenge: 'challenge-1' }) as never),
      verifyRegistrationResponse: verify,
    });
    const { service, api, store, advance } = setup({ webauthn: port });
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const login = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const cookie = login.headers['set-cookie']!.split(';', 1)[0]!;
    const registration = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/register',
      cookie,
    });
    const ceremonyCookie = registration.headers['set-cookie']!.split(';', 1)[0]!;
    advance(5 * 60 * 1000 - 1);
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/webauthn/verify',
        cookie: ceremonyCookie,
        body: { credential: {} },
      }),
    ).resolves.toEqual({
      status: 400,
      headers: {},
      body: { error: 'webauthn_verification_failed' },
    });
    expect(verify).toHaveBeenCalledTimes(1);
    await expect(store.findUserByEmail('user@example.test')).resolves.toMatchObject({
      webauthn_credentials: [],
    });
  }, 30_000);

  it('burns a challenge after a failed verification attempt', async () => {
    const verify = vi.fn(async () => ({ verified: false }) as never);
    const port = webauthnPort({
      generateRegistrationOptions: vi.fn(async () => ({ challenge: 'challenge-1' }) as never),
      verifyRegistrationResponse: verify,
    });
    const { service, api } = setup({ webauthn: port });
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const login = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const cookie = login.headers['set-cookie']!.split(';', 1)[0]!;
    const registration = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/register',
      cookie,
    });
    const ceremonyCookie = registration.headers['set-cookie']!.split(';', 1)[0]!;
    await api.handle({
      method: 'POST',
      path: '/auth/webauthn/verify',
      cookie: ceremonyCookie,
      body: { credential: {} },
    });
    await api.handle({
      method: 'POST',
      path: '/auth/webauthn/verify',
      cookie: ceremonyCookie,
      body: { credential: {} },
    });
    expect(verify).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('authenticates a registered credential without a password and atomically advances its counter', async () => {
    const verifyAuthentication = vi.fn(async (options: Record<string, unknown>) => {
      expect(options).toMatchObject({
        expectedChallenge: 'authentication-challenge',
        expectedOrigin: 'http://localhost',
        expectedRPID: 'localhost',
        requireUserVerification: true,
        credential: { id: 'credential-1', counter: 7 },
      });
      return {
        verified: true,
        authenticationInfo: {
          credentialID: 'credential-1',
          newCounter: 8,
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost',
          rpID: 'localhost',
        },
      } as never;
    });
    const port = webauthnPort({
      generateRegistrationOptions: vi.fn(async () => ({ challenge: 'registration-challenge' }) as never),
      verifyRegistrationResponse: vi.fn(
        async () =>
          ({
            verified: true,
            registrationInfo: {
              userVerified: true,
              credential: {
                id: 'credential-1',
                publicKey: new Uint8Array([1, 2, 3]),
                counter: 7,
              },
              origin: 'http://localhost',
              rpID: 'localhost',
            },
          }) as never,
      ),
      verifyAuthenticationResponse: verifyAuthentication,
    });
    const { service, api, store } = setup({ webauthn: port });
    await service.registerPasswordUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });
    const passwordLogin = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'user@example.test',
        password: 'correct horse battery staple',
      },
    });
    const passwordCookie = passwordLogin.headers['set-cookie']!.split(';', 1)[0]!;
    const registrationChallenge = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/register',
      cookie: passwordCookie,
    });
    const registeredSession = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/verify',
      cookie: registrationChallenge.headers['set-cookie']!.split(';', 1)[0]!,
      body: { credential: { id: 'credential-1' } },
    });
    await api.handle({
      method: 'POST',
      path: '/auth/logout',
      cookie: registeredSession.headers['set-cookie']!.split(';', 1)[0]!,
    });

    const challenge = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/authenticate',
      client_id: 'client-2',
    });
    expect(challenge).toMatchObject({
      status: 200,
      body: {
        challenge: 'authentication-challenge',
        rpId: 'localhost',
        timeout: 300_000,
        userVerification: 'required',
      },
    });
    expect(challenge.headers['set-cookie']).toMatch(
      /^__Host-harness_webauthn=[A-Za-z0-9_-]{43}; Max-Age=300; Path=\/; HttpOnly; Secure; SameSite=Strict$/u,
    );

    const ceremonyCookie = challenge.headers['set-cookie']!.split(';', 1)[0]!;
    const assertion = {
      id: 'credential-1',
      rawId: 'credential-1',
      response: {},
      type: 'public-key',
    };
    const authenticated = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/verify',
      client_id: 'client-2',
      cookie: ceremonyCookie,
      body: { credential: assertion },
    });
    expect(authenticated).toMatchObject({
      status: 200,
      body: { authenticated: true },
    });
    expect(authenticated.headers['set-cookie']).toContain('__Host-harness_session=');
    await expect(store.findUserByEmail('user@example.test')).resolves.toMatchObject({
      webauthn_credentials: [{ id: 'credential-1', counter: 8 }],
    });
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/webauthn/verify',
        client_id: 'client-2',
        cookie: ceremonyCookie,
        body: { credential: assertion },
      }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: 'authentication_failed' },
    });
    expect(verifyAuthentication).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('fails WebAuthn authentication closed for an expired or unknown ceremony', async () => {
    const verifyAuthentication = vi.fn(async () => ({ verified: false }) as never);
    const { api, advance } = setup({
      webauthn: webauthnPort({
        verifyAuthenticationResponse: verifyAuthentication,
      }),
    });
    const challenge = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/authenticate',
      client_id: 'client-1',
    });
    expect(challenge.status).toBe(200);
    const ceremonyCookie = challenge.headers['set-cookie']!.split(';', 1)[0]!;
    advance(5 * 60 * 1000);
    const response = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/verify',
      client_id: 'client-1',
      cookie: ceremonyCookie,
      body: { credential: { id: 'unknown-credential' } },
    });
    expect(response).toEqual({
      status: 401,
      headers: {},
      body: { error: 'authentication_failed' },
    });
    expect(JSON.stringify(response)).not.toContain('unknown-credential');
    expect(verifyAuthentication).not.toHaveBeenCalled();
  });

  it('supports the OpenAPI method=webauthn login form without revealing credential registration', async () => {
    const { api } = setup({ webauthn: webauthnPort() });
    const challenge = await api.handle({
      method: 'POST',
      path: '/auth/webauthn/authenticate',
    });
    const response = await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      cookie: challenge.headers['set-cookie']!.split(';', 1)[0]!,
      body: {
        method: 'webauthn',
        webauthn_assertion: { id: 'private-credential-id' },
      },
    });
    expect(response).toEqual({
      status: 401,
      headers: {},
      body: { error: 'authentication_failed' },
    });
    expect(JSON.stringify(response)).not.toContain('private-credential-id');
  });

  it('rejects every authentication verification invariant with one redacted deny audit', async () => {
    const outcomes = [
      { verified: false, authenticationInfo: undefined },
      {
        verified: true,
        authenticationInfo: {
          credentialID: 'credential-1',
          newCounter: 8,
          userVerified: false,
          origin: 'http://localhost',
          rpID: 'localhost',
        },
      },
      {
        verified: true,
        authenticationInfo: {
          credentialID: 'other',
          newCounter: 8,
          userVerified: true,
          origin: 'http://localhost',
          rpID: 'localhost',
        },
      },
      {
        verified: true,
        authenticationInfo: {
          credentialID: 'credential-1',
          newCounter: 8,
          userVerified: true,
          origin: 'https://evil.example',
          rpID: 'localhost',
        },
      },
      {
        verified: true,
        authenticationInfo: {
          credentialID: 'credential-1',
          newCounter: 8,
          userVerified: true,
          origin: 'http://localhost',
          rpID: 'evil.example',
        },
      },
      {
        verified: true,
        authenticationInfo: {
          credentialID: 'credential-1',
          newCounter: 7,
          userVerified: true,
          origin: 'http://localhost',
          rpID: 'localhost',
        },
      },
    ];
    const verifyAuthentication = vi.fn();
    for (const outcome of outcomes) verifyAuthentication.mockResolvedValueOnce(outcome as never);
    const { api, service, store } = setup({
      webauthn: webauthnPort({
        verifyAuthenticationResponse: verifyAuthentication,
      }),
    });
    await store.createUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password_hash: 'not-used-for-webauthn',
      webauthn_credentials: [],
    });
    await store.addWebAuthnCredential('user-1', {
      id: 'credential-1',
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 7,
    });

    for (const outcome of outcomes) {
      const challenge = await api.handle({
        method: 'POST',
        path: '/auth/webauthn/authenticate',
      });
      const before = service.auditEvents.length;
      const response = await api.handle({
        method: 'POST',
        path: '/auth/webauthn/verify',
        cookie: challenge.headers['set-cookie']!.split(';', 1)[0]!,
        body: { credential: { id: 'credential-1' } },
      });
      expect(response).toEqual({
        status: 401,
        headers: {},
        body: { error: 'authentication_failed' },
      });
      expect(service.auditEvents).toHaveLength(before + 1);
      expect(JSON.stringify(service.auditEvents.at(-1))).not.toContain('credential-1');
      expect(outcome).toBeDefined();
    }
    await expect(store.findUserByEmail('user@example.test')).resolves.toMatchObject({
      webauthn_credentials: [{ counter: 7 }],
    });
  });

  it('allows only one concurrent assertion to advance the same nonzero signature counter', async () => {
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifyAuthentication = vi.fn(async () => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return {
        verified: true,
        authenticationInfo: {
          credentialID: 'credential-1',
          newCounter: 8,
          userVerified: true,
          origin: 'http://localhost',
          rpID: 'localhost',
        },
      } as never;
    });
    const { api, store } = setup({
      webauthn: webauthnPort({
        verifyAuthenticationResponse: verifyAuthentication,
      }),
    });
    await store.createUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password_hash: 'not-used-for-webauthn',
      webauthn_credentials: [],
    });
    await store.addWebAuthnCredential('user-1', {
      id: 'credential-1',
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 7,
    });
    const challenges = await Promise.all([
      api.handle({ method: 'POST', path: '/auth/webauthn/authenticate' }),
      api.handle({ method: 'POST', path: '/auth/webauthn/authenticate' }),
    ]);
    const responses = await Promise.all(
      challenges.map((challenge) =>
        api.handle({
          method: 'POST',
          path: '/auth/webauthn/verify',
          cookie: challenge.headers['set-cookie']!.split(';', 1)[0]!,
          body: { credential: { id: 'credential-1' } },
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    await expect(store.findUserByEmail('user@example.test')).resolves.toMatchObject({
      webauthn_credentials: [{ counter: 8 }],
    });
  });

  it('rejects malformed stored credentials before they can enter the authentication index', async () => {
    const malformed = [
      { id: '', publicKey: new Uint8Array([1]), counter: 0 },
      { id: 'credential-1', publicKey: new Uint8Array(), counter: 0 },
      { id: 'credential-1', publicKey: new Uint8Array([1]), counter: -1 },
      { id: 'credential-1', publicKey: new Uint8Array([1]), counter: 1.5 },
    ];
    for (const credential of malformed) {
      const store = new InMemoryAuthStore();
      await store.createUser({
        user_id: 'user-1',
        email: 'user@example.test',
        password_hash: 'not-used-for-webauthn',
        webauthn_credentials: [],
      });
      await expect(store.addWebAuthnCredential('user-1', credential)).rejects.toMatchObject({
        code: 'webauthn_verification_failed',
      });
      expect(store.findWebAuthnCredential('credential-1')).toBeUndefined();
    }
  });

  it('burns an authentication ceremony on a malformed request and audits unknown ceremony denial once', async () => {
    const verifyAuthentication = vi.fn(async () => ({ verified: false }) as never);
    const { api, service, store } = setup({
      webauthn: webauthnPort({ verifyAuthenticationResponse: verifyAuthentication }),
    });
    await store.createUser({
      user_id: 'user-1',
      email: 'user@example.test',
      password_hash: 'not-used-for-webauthn',
      webauthn_credentials: [],
    });
    await store.addWebAuthnCredential('user-1', {
      id: 'credential-1',
      publicKey: new Uint8Array([1]),
      counter: 0,
    });
    const challenge = await api.handle({ method: 'POST', path: '/auth/webauthn/authenticate' });
    const cookie = challenge.headers['set-cookie']!.split(';', 1)[0]!;

    await expect(
      api.handle({ method: 'POST', path: '/auth/webauthn/verify', cookie, body: null }),
    ).resolves.toMatchObject({ status: 401, body: { error: 'authentication_failed' } });
    await expect(
      api.handle({
        method: 'POST',
        path: '/auth/webauthn/verify',
        cookie,
        body: { credential: { id: 'credential-1' } },
      }),
    ).resolves.toMatchObject({ status: 401, body: { error: 'authentication_failed' } });
    expect(verifyAuthentication).not.toHaveBeenCalled();

    const beforeUnknown = service.auditEvents.length;
    await api.handle({
      method: 'POST',
      path: '/auth/webauthn/verify',
      body: { credential: { id: 'credential-1' } },
    });
    expect(service.auditEvents).toHaveLength(beforeUnknown + 1);
    expect(service.auditEvents.at(-1)).toMatchObject({ outcome: 'denied', reason_code: 'challenge_invalid' });
  });

  it('bounds active WebAuthn ceremonies and releases capacity after their deadline', async () => {
    let now = Date.parse(NOW);
    let sequence = 0;
    const service = new AuthService({
      store: new InMemoryAuthStore(),
      rp_id: 'localhost',
      rp_name: 'Harness',
      origin: 'http://localhost',
      now: () => new Date(now).toISOString(),
      random_bytes: () => {
        const bytes = Buffer.alloc(32);
        bytes.writeUInt32BE(++sequence, 28);
        return bytes;
      },
      webauthn: webauthnPort(),
    });
    const api = new AuthApi(service);
    for (let index = 0; index < 1024; index += 1) {
      await expect(api.handle({ method: 'POST', path: '/auth/webauthn/authenticate' })).resolves.toMatchObject({
        status: 200,
      });
    }
    await expect(api.handle({ method: 'POST', path: '/auth/webauthn/authenticate' })).resolves.toMatchObject({
      status: 429,
      body: { error: 'rate_limited' },
    });
    now += 5 * 60 * 1000;
    await expect(api.handle({ method: 'POST', path: '/auth/webauthn/authenticate' })).resolves.toMatchObject({
      status: 200,
    });
  });

  it('fails closed when a WebAuthn adapter returns an invalid challenge', async () => {
    const { api } = setup({
      webauthn: webauthnPort({
        generateAuthenticationOptions: vi.fn(async () => ({ challenge: '' }) as never),
      }),
    });
    await expect(api.handle({ method: 'POST', path: '/auth/webauthn/authenticate' })).resolves.toEqual({
      status: 400,
      headers: {},
      body: { error: 'invalid_request' },
    });
  });
});

describe('AH-CAPMAP-002 audit retention', () => {
  it('keeps redacted immutable events for 90 days and purges only older events', async () => {
    const { api, service, advance } = setup();
    await api.handle({
      method: 'POST',
      path: '/auth/login',
      client_id: 'client-1',
      body: {
        method: 'password',
        email: 'private@example.test',
        password: 'private-password',
      },
    });
    const event = service.auditEvents[0]!;
    expect(Object.isFrozen(event)).toBe(true);
    expect(JSON.stringify(event)).not.toMatch(/private@example\.test|private-password/u);
    advance(90 * 24 * 60 * 60 * 1000);
    expect(service.purgeExpiredAuditEvents()).toBe(0);
    advance(1);
    expect(service.purgeExpiredAuditEvents()).toBe(1);
  });
});
