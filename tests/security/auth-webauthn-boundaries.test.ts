import type {
  VerifiedRegistrationResponse,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthError,
  AuthService,
  InMemoryAuthStore,
  type WebAuthnPort,
} from '../../security/auth.js';

const NOW = '2026-01-01T00:00:00.000Z';
const ORIGIN = 'http://localhost';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function credential(overrides: Partial<WebAuthnCredential> = {}): WebAuthnCredential {
  return {
    id: 'credential-1',
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ['internal'],
    ...overrides,
  };
}

function registrationResult(
  overrides: Partial<VerifiedRegistrationResponse> = {},
): VerifiedRegistrationResponse {
  return {
    verified: true,
    registrationInfo: {
      credential: credential(),
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      aaguid: '00000000-0000-0000-0000-000000000000',
      credentialType: 'public-key',
      attestationObject: new Uint8Array(),
      userVerified: true,
      origin: ORIGIN,
      rpID: 'localhost',
      fmt: 'none',
    },
    ...overrides,
  } as VerifiedRegistrationResponse;
}

function port(overrides: Partial<WebAuthnPort> = {}): WebAuthnPort {
  return {
    generateRegistrationOptions: vi.fn(async () => ({ challenge: 'registration-challenge' }) as never),
    verifyRegistrationResponse: vi.fn(async () => registrationResult()),
    generateAuthenticationOptions: vi.fn(async () => ({ challenge: 'authentication-challenge' }) as never),
    verifyAuthenticationResponse: vi.fn(async () => ({ verified: false }) as never),
    ...overrides,
  };
}

function service(store: InMemoryAuthStore, webauthn?: WebAuthnPort): AuthService {
  let randomByte = 7;
  return new AuthService({
    store,
    rp_id: 'localhost',
    rp_name: 'Harness',
    origin: ORIGIN,
    now: () => NOW,
    random_bytes: (length) => new Uint8Array(length).fill(randomByte++),
    ...(webauthn === undefined ? {} : { webauthn }),
  });
}

async function seedUser(
  store: InMemoryAuthStore,
  credentials: readonly WebAuthnCredential[] = [],
): Promise<void> {
  await store.createUser({
    user_id: 'user-1',
    email: 'user@example.test',
    password_hash: 'not-used',
    webauthn_credentials: credentials,
  });
}

function seedSession(store: InMemoryAuthStore, token: string, overrides: Record<string, unknown> = {}): void {
  store.createSession({
    token_hash: hash(token),
    user_id: 'user-1',
    issued_at: NOW,
    expires_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  });
}

function registrationChallenge(store: InMemoryAuthStore, token: string, userId: string | undefined): void {
  store.createChallenge(
    {
      key_hash: hash(token),
      kind: 'registration',
      ...(userId === undefined ? {} : { user_id: userId }),
      challenge: 'registration-challenge',
      expires_at: '2026-01-01T00:05:00.000Z',
    },
    NOW,
  );
}

function expectAuthError(promise: Promise<unknown>, code: string, status: number) {
  return expect(promise).rejects.toMatchObject({ name: 'AuthError', message: code, code, status });
}

describe('AuthService session state boundaries', () => {
  it('distinguishes live, expired, revoked, orphaned, and absent sessions with exact audit events', async () => {
    const store = new InMemoryAuthStore();
    await seedUser(store);
    const valid = 'v'.repeat(43);
    seedSession(store, valid);
    const auth = service(store, port());
    expect(auth.authenticate(valid)).toMatchObject({ user_id: 'user-1' });
    expect(auth.auditEvents.at(-1)).toEqual({
      timestamp: NOW,
      action: 'session_check',
      outcome: 'allowed',
      subject_ref: hash('user-1'),
      reason_code: 'authenticated',
    });

    const invalidCases = [
      ['expired', { expires_at: NOW }],
      ['revoked', { revoked_at: NOW }],
      ['orphaned', { user_id: 'missing-user' }],
    ] as const;
    for (const [token, overrides] of invalidCases) {
      seedSession(store, token, overrides);
      expect(() => auth.authenticate(token)).toThrow(
        expect.objectContaining({ name: 'AuthError', code: 'authentication_required', status: 401 }),
      );
      expect(auth.auditEvents.at(-1)).toEqual({
        timestamp: NOW,
        action: 'session_check',
        outcome: 'denied',
        subject_ref: hash('invalid-session'),
        reason_code: 'authentication_required',
      });
    }
    expect(() => auth.authenticate('missing')).toThrow(AuthError);
  });

  it('revokes one live session once and audits both allowed and denied logout', async () => {
    const store = new InMemoryAuthStore();
    await seedUser(store);
    const token = 'l'.repeat(43);
    seedSession(store, token);
    const auth = service(store, port());
    auth.logout(token);
    expect(store.findSession(hash(token))?.revoked_at).toBe(NOW);
    expect(auth.auditEvents.at(-1)).toEqual({
      timestamp: NOW,
      action: 'logout',
      outcome: 'allowed',
      subject_ref: hash(token),
      reason_code: 'session_revoked',
    });
    expect(() => auth.logout(token)).toThrow(
      expect.objectContaining({ code: 'authentication_required', status: 401 }),
    );
    expect(auth.auditEvents.at(-1)).toEqual({
      timestamp: NOW,
      action: 'logout',
      outcome: 'denied',
      subject_ref: hash('invalid-session'),
      reason_code: 'authentication_required',
    });
  });
});

describe('AuthService WebAuthn ceremony boundaries', () => {
  it('builds complete registration and authentication options and records issuance', async () => {
    const store = new InMemoryAuthStore();
    await seedUser(store, [credential()]);
    const sessionToken = 's'.repeat(43);
    seedSession(store, sessionToken);
    const adapter = port();
    const auth = service(store, adapter);

    const registration = await auth.beginWebAuthnRegistration(sessionToken);
    expect(adapter.generateRegistrationOptions).toHaveBeenCalledWith({
      rpName: 'Harness',
      rpID: 'localhost',
      userID: new TextEncoder().encode('user-1'),
      userName: 'user@example.test',
      userDisplayName: 'Harness user',
      timeout: 300_000,
      attestationType: 'none',
      excludeCredentials: [{ id: 'credential-1', transports: ['internal'] }],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    expect(registration.options).toEqual({ challenge: 'registration-challenge' });
    expect(registration.cookie).toMatch(
      /^__Host-harness_webauthn=[A-Za-z0-9_-]{43}; Max-Age=300; Path=\/; HttpOnly; Secure; SameSite=Strict$/u,
    );
    expect(auth.auditEvents.at(-1)).toEqual({
      timestamp: NOW,
      action: 'webauthn_register',
      outcome: 'allowed',
      subject_ref: hash('user-1'),
      reason_code: 'challenge_issued',
    });

    const authentication = await auth.beginWebAuthnAuthentication();
    expect(adapter.generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: 'localhost',
      timeout: 300_000,
      userVerification: 'required',
    });
    expect(authentication.options).toEqual({ challenge: 'authentication-challenge' });
    expect(auth.auditEvents.at(-1)).toEqual({
      timestamp: NOW,
      action: 'webauthn_authenticate',
      outcome: 'allowed',
      subject_ref: hash('anonymous'),
      reason_code: 'challenge_issued',
    });
  });

  it('uses a working default WebAuthn adapter when no test port is injected', async () => {
    const auth = service(new InMemoryAuthStore());
    const ceremony = await auth.beginWebAuthnAuthentication();
    expect(ceremony.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('fails an unknown ceremony with one exact redacted audit event', async () => {
    const auth = service(new InMemoryAuthStore(), port());
    await expectAuthError(auth.verifyWebAuthnCeremony('unknown', {}), 'authentication_failed', 401);
    expect(auth.auditEvents).toEqual([
      {
        timestamp: NOW,
        action: 'webauthn_verify',
        outcome: 'denied',
        subject_ref: hash('anonymous'),
        reason_code: 'challenge_invalid',
      },
    ]);
  });

  it('rejects every registration verifier invariant independently', async () => {
    const cases: Array<VerifiedRegistrationResponse | Error> = [
      registrationResult({ verified: false }),
      registrationResult({
        registrationInfo: { ...registrationResult().registrationInfo, userVerified: false } as never,
      }),
      registrationResult({
        registrationInfo: {
          ...registrationResult().registrationInfo,
          origin: 'https://attacker.test',
        } as never,
      }),
      registrationResult({
        registrationInfo: { ...registrationResult().registrationInfo, rpID: 'attacker.test' } as never,
      }),
      new Error('adapter failure'),
    ];
    for (const result of cases) {
      const store = new InMemoryAuthStore();
      await seedUser(store);
      const token = `ceremony-${cases.indexOf(result)}`;
      registrationChallenge(store, token, 'user-1');
      const adapter = port({
        verifyRegistrationResponse: vi.fn(async () => {
          if (result instanceof Error) throw result;
          return result;
        }),
      });
      const auth = service(store, adapter);
      await expectAuthError(
        auth.verifyWebAuthnCeremony(token, { id: 'response' }),
        'webauthn_verification_failed',
        400,
      );
      expect(auth.auditEvents).toEqual([
        {
          timestamp: NOW,
          action: 'webauthn_verify',
          outcome: 'denied',
          subject_ref: hash('user-1'),
          reason_code: 'verification_failed',
        },
      ]);
    }
  });

  it('rejects malformed responses and registration ceremonies without a bound user', async () => {
    for (const [token, userId, response] of [
      ['malformed', 'user-1', null],
      ['unbound', undefined, { id: 'response' }],
    ] as const) {
      const store = new InMemoryAuthStore();
      await seedUser(store);
      registrationChallenge(store, token, userId);
      const auth = service(store, port());
      await expectAuthError(auth.verifyWebAuthnCeremony(token, response), 'webauthn_verification_failed', 400);
      expect(auth.auditEvents.at(-1)).toMatchObject({
        action: 'webauthn_verify',
        outcome: 'denied',
        reason_code: 'verification_failed',
      });
    }
  });

  it('registers a verified credential, issues a session, and records exact success', async () => {
    const store = new InMemoryAuthStore();
    await seedUser(store);
    const token = 'successful-registration';
    registrationChallenge(store, token, 'user-1');
    const auth = service(store, port());
    const session = await auth.verifyWebAuthnCeremony(token, { id: 'response' });
    expect(session.user_id).toBe('user-1');
    expect(store.findWebAuthnCredential('credential-1')?.user.user_id).toBe('user-1');
    expect(auth.auditEvents).toEqual([
      {
        timestamp: NOW,
        action: 'webauthn_verify',
        outcome: 'allowed',
        subject_ref: hash('user-1'),
        reason_code: 'credential_registered',
      },
    ]);
  });
});
