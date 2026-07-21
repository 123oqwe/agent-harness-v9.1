import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type GenerateAuthenticationOptionsOpts,
  type GenerateRegistrationOptionsOpts,
  type PublicKeyCredentialRequestOptionsJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_LIFETIME_MS = DAY_MS;
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const RATE_LIMIT_MS = 15 * 60 * 1000;
const AUDIT_RETENTION_MS = 90 * DAY_MS;
const MAX_FAILED_ATTEMPTS = 5;
const MAX_ACTIVE_CHALLENGES = 1024;
const BCRYPT_COST = 12;
const SESSION_COOKIE = '__Host-harness_session';
const WEBAUTHN_COOKIE = '__Host-harness_webauthn';

type AuthErrorCode =
  | 'authentication_failed'
  | 'authentication_required'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'webauthn_verification_failed';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode, status: number) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export interface AuthUserRecord {
  readonly user_id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly webauthn_credentials: readonly WebAuthnCredential[];
}

interface SessionRecord {
  readonly token_hash: string;
  readonly user_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  revoked_at?: string;
}

interface ChallengeRecord {
  readonly key_hash: string;
  readonly kind: 'registration' | 'authentication';
  readonly user_id?: string;
  readonly challenge: string;
  readonly expires_at: string;
  consumed_at?: string;
}

interface ConsumedChallenge {
  readonly record: ChallengeRecord;
  readonly accepted: boolean;
}

export interface AuthAuditEvent {
  readonly timestamp: string;
  readonly action:
    'login' | 'logout' | 'session_check' | 'webauthn_register' | 'webauthn_authenticate' | 'webauthn_verify';
  readonly outcome: 'allowed' | 'denied';
  readonly subject_ref: string;
  readonly reason_code: string;
}

interface FailedAttemptState {
  attempts: number;
  blocked_until?: string;
}

export interface WebAuthnPort {
  generateRegistrationOptions(
    options: GenerateRegistrationOptionsOpts,
  ): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistrationResponse(options: VerifyRegistrationResponseOpts): Promise<VerifiedRegistrationResponse>;
  generateAuthenticationOptions(
    options: GenerateAuthenticationOptionsOpts,
  ): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthenticationResponse(options: VerifyAuthenticationResponseOpts): Promise<VerifiedAuthenticationResponse>;
}

export interface AuthServiceOptions {
  readonly store: InMemoryAuthStore;
  readonly rp_id: string;
  readonly rp_name: string;
  readonly origin: string;
  readonly now?: () => string;
  readonly random_bytes?: (length: number) => Uint8Array;
  readonly webauthn?: WebAuthnPort;
}

export interface RegisterPasswordUserInput {
  readonly user_id: string;
  readonly email: string;
  readonly password: string;
}

export interface AuthSession {
  readonly token: string;
  readonly cookie: string;
  readonly user_id: string;
}

export interface WebAuthnCeremony<TOptions> {
  readonly options: TOptions;
  readonly cookie: string;
}

export interface AuthApiRequest {
  readonly method: string;
  readonly path: string;
  readonly client_id?: string;
  readonly cookie?: string;
  readonly body?: unknown;
}

export interface AuthApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneCredential(credential: WebAuthnCredential): WebAuthnCredential {
  return {
    id: credential.id,
    publicKey: new Uint8Array(credential.publicKey),
    counter: credential.counter,
    ...(credential.transports === undefined ? {} : { transports: [...credential.transports] }),
  };
}

function validateCredential(credential: WebAuthnCredential): void {
  if (
    typeof credential.id !== 'string' ||
    credential.id.length === 0 ||
    credential.id.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/u.test(credential.id) ||
    !(credential.publicKey instanceof Uint8Array) ||
    credential.publicKey.byteLength === 0 ||
    credential.publicKey.byteLength > 4096 ||
    !Number.isSafeInteger(credential.counter) ||
    credential.counter < 0 ||
    (credential.transports !== undefined && !Array.isArray(credential.transports))
  ) {
    throw new AuthError('webauthn_verification_failed', 400);
  }
}

function cloneUser(user: AuthUserRecord): AuthUserRecord {
  return {
    user_id: user.user_id,
    email: user.email,
    password_hash: user.password_hash,
    webauthn_credentials: user.webauthn_credentials.map(cloneCredential),
  };
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new AuthError('invalid_request', 400);
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new AuthError('invalid_request', 400);
  }
  return normalized;
}

function requireString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new AuthError('invalid_request', 400);
  }
  return value;
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('invalid clock value');
  return parsed;
}

function parseCookie(cookie: string | undefined, expectedName: string): string | undefined {
  if (cookie === undefined) return undefined;
  let token: string | undefined;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== expectedName) continue;
    if (token !== undefined || rest.length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(rest[0] ?? '')) {
      return undefined;
    }
    token = rest[0];
  }
  return token;
}

function parseSessionCookie(cookie: string | undefined): string | undefined {
  return parseCookie(cookie, SESSION_COOKIE);
}

function parseWebAuthnCookie(cookie: string | undefined): string | undefined {
  return parseCookie(cookie, WEBAUTHN_COOKIE);
}

export class InMemoryAuthStore {
  readonly #usersByEmail = new Map<string, AuthUserRecord>();
  readonly #usersById = new Map<string, AuthUserRecord>();
  readonly #credentialOwners = new Map<string, string>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #challenges = new Map<string, ChallengeRecord>();

  async createUser(user: AuthUserRecord): Promise<void> {
    if (this.#usersByEmail.has(user.email) || this.#usersById.has(user.user_id)) {
      throw new AuthError('invalid_request', 400);
    }
    const credentialIds = new Set<string>();
    for (const credential of user.webauthn_credentials) {
      validateCredential(credential);
      if (credentialIds.has(credential.id) || this.#credentialOwners.has(credential.id)) {
        throw new AuthError('invalid_request', 400);
      }
      credentialIds.add(credential.id);
    }
    const stored = cloneUser(user);
    this.#usersByEmail.set(user.email, stored);
    this.#usersById.set(user.user_id, stored);
    for (const credentialId of credentialIds) this.#credentialOwners.set(credentialId, user.user_id);
  }

  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    const user = this.#usersByEmail.get(email);
    return user === undefined ? undefined : cloneUser(user);
  }

  getUser(userId: string): AuthUserRecord | undefined {
    const user = this.#usersById.get(userId);
    return user === undefined ? undefined : cloneUser(user);
  }

  async addWebAuthnCredential(userId: string, credential: WebAuthnCredential): Promise<void> {
    validateCredential(credential);
    const current = this.#usersById.get(userId);
    if (current === undefined || this.#credentialOwners.has(credential.id)) {
      throw new AuthError('webauthn_verification_failed', 400);
    }
    const updated: AuthUserRecord = {
      ...current,
      webauthn_credentials: [...current.webauthn_credentials.map(cloneCredential), cloneCredential(credential)],
    };
    this.#usersById.set(userId, updated);
    this.#usersByEmail.set(current.email, updated);
    this.#credentialOwners.set(credential.id, userId);
  }

  findWebAuthnCredential(
    credentialId: string,
  ): { readonly user: AuthUserRecord; readonly credential: WebAuthnCredential } | undefined {
    const userId = this.#credentialOwners.get(credentialId);
    const user = userId === undefined ? undefined : this.#usersById.get(userId);
    const credential = user?.webauthn_credentials.find((candidate) => candidate.id === credentialId);
    if (user === undefined || credential === undefined) return undefined;
    return Object.freeze({
      user: cloneUser(user),
      credential: cloneCredential(credential),
    });
  }

  updateWebAuthnCounter(userId: string, credentialId: string, expectedCounter: number, newCounter: number): boolean {
    if (!Number.isSafeInteger(newCounter) || newCounter < 0) return false;
    const current = this.#usersById.get(userId);
    const index = current?.webauthn_credentials.findIndex((credential) => credential.id === credentialId) ?? -1;
    const credential = index < 0 ? undefined : current?.webauthn_credentials[index];
    if (
      current === undefined ||
      credential === undefined ||
      credential.counter !== expectedCounter ||
      (expectedCounter !== 0 && newCounter <= expectedCounter)
    ) {
      return false;
    }
    const credentials = current.webauthn_credentials.map((item, credentialIndex) =>
      credentialIndex === index ? cloneCredential({ ...item, counter: newCounter }) : cloneCredential(item),
    );
    const updated: AuthUserRecord = {
      ...current,
      webauthn_credentials: credentials,
    };
    this.#usersById.set(userId, updated);
    this.#usersByEmail.set(current.email, updated);
    return true;
  }

  createSession(record: SessionRecord): void {
    if (this.#sessions.has(record.token_hash)) throw new AuthError('authentication_failed', 401);
    this.#sessions.set(record.token_hash, { ...record });
  }

  findSession(tokenHash: string): SessionRecord | undefined {
    const record = this.#sessions.get(tokenHash);
    return record === undefined ? undefined : { ...record };
  }

  revokeSession(tokenHash: string, revokedAt: string): boolean {
    const record = this.#sessions.get(tokenHash);
    if (record === undefined || record.revoked_at !== undefined) return false;
    record.revoked_at = revokedAt;
    return true;
  }

  createChallenge(record: ChallengeRecord, now: string): void {
    for (const [keyHash, challenge] of this.#challenges) {
      if (challenge.consumed_at !== undefined || instant(now) >= instant(challenge.expires_at)) {
        this.#challenges.delete(keyHash);
      }
    }
    if (this.#challenges.size >= MAX_ACTIVE_CHALLENGES) throw new AuthError('rate_limited', 429);
    if (this.#challenges.has(record.key_hash)) throw new AuthError('authentication_failed', 401);
    this.#challenges.set(record.key_hash, { ...record });
  }

  consumeChallenge(keyHash: string, now: string): ConsumedChallenge | undefined {
    const record = this.#challenges.get(keyHash);
    if (record === undefined) return undefined;
    const accepted = record.consumed_at === undefined && instant(now) < instant(record.expires_at);
    if (!accepted) return Object.freeze({ record: { ...record }, accepted: false });
    record.consumed_at = now;
    return Object.freeze({ record: { ...record }, accepted: true });
  }

  async inspectSessions(): Promise<readonly Readonly<SessionRecord>[]> {
    return [...this.#sessions.values()].map((record) => Object.freeze({ ...record }));
  }
}

const defaultWebAuthn: WebAuthnPort = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

export class AuthService {
  readonly #store: InMemoryAuthStore;
  readonly #rpId: string;
  readonly #rpName: string;
  readonly #origin: string;
  readonly #now: () => string;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #webauthn: WebAuthnPort;
  readonly #failedAttempts = new Map<string, FailedAttemptState>();
  readonly #audit: AuthAuditEvent[] = [];
  #dummyPasswordHash: Promise<string> | undefined;

  constructor(options: AuthServiceOptions) {
    this.#store = options.store;
    this.#rpId = requireString(options.rp_id, 253);
    this.#rpName = requireString(options.rp_name, 128);
    this.#origin = requireString(options.origin, 2048);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomBytes = options.random_bytes ?? randomBytes;
    this.#webauthn = options.webauthn ?? defaultWebAuthn;
    const origin = new URL(this.#origin);
    if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
      throw new AuthError('invalid_request', 400);
    }
  }

  get auditEvents(): readonly AuthAuditEvent[] {
    return Object.freeze(this.#audit.map((event) => Object.freeze({ ...event })));
  }

  async registerPasswordUser(input: RegisterPasswordUserInput): Promise<void> {
    const userId = requireString(input.user_id, 128);
    const email = normalizeEmail(input.email);
    const password = requireString(input.password, 128);
    if (Buffer.byteLength(password, 'utf8') > 72) throw new AuthError('invalid_request', 400);
    await this.#store.createUser({
      user_id: userId,
      email,
      password_hash: await bcrypt.hash(password, BCRYPT_COST),
      webauthn_credentials: [],
    });
  }

  async login(emailValue: unknown, passwordValue: unknown, clientIdValue: unknown): Promise<AuthSession> {
    const email = normalizeEmail(emailValue);
    const password = requireString(passwordValue, 128);
    if (Buffer.byteLength(password, 'utf8') > 72) throw new AuthError('invalid_request', 400);
    const clientId = requireString(clientIdValue, 256);
    const accountRateKey = sha256(`account\u0000${email}`);
    const clientRateKey = sha256(`client\u0000${clientId}`);
    const rateKeys = [accountRateKey, clientRateKey];
    const subjectRef = sha256(email);
    const nowMs = instant(this.#now());
    for (const rateKey of rateKeys) {
      const state = this.#failedAttempts.get(rateKey);
      if (state?.blocked_until !== undefined && nowMs < instant(state.blocked_until)) {
        this.#recordAudit('login', 'denied', subjectRef, 'rate_limited');
        throw new AuthError('rate_limited', 429);
      }
      if (state?.blocked_until !== undefined) this.#failedAttempts.delete(rateKey);
    }

    const user = await this.#store.findUserByEmail(email);
    this.#dummyPasswordHash ??= bcrypt.hash(Buffer.from(this.#randomBytes(32)).toString('base64url'), BCRYPT_COST);
    const valid = await bcrypt.compare(password, user?.password_hash ?? (await this.#dummyPasswordHash));
    if (!valid || user === undefined) {
      for (const rateKey of rateKeys) {
        const attempts = (this.#failedAttempts.get(rateKey)?.attempts ?? 0) + 1;
        this.#failedAttempts.set(rateKey, {
          attempts,
          ...(attempts >= MAX_FAILED_ATTEMPTS ? { blocked_until: new Date(nowMs + RATE_LIMIT_MS).toISOString() } : {}),
        });
      }
      this.#recordAudit('login', 'denied', subjectRef, 'authentication_failed');
      throw new AuthError('authentication_failed', 401);
    }
    this.#failedAttempts.delete(accountRateKey);
    this.#recordAudit('login', 'allowed', sha256(user.user_id), 'authenticated');
    return this.#issueSession(user.user_id);
  }

  authenticate(sessionToken: string | undefined): AuthUserRecord {
    if (sessionToken === undefined || sessionToken.length === 0) {
      this.#recordAudit('session_check', 'denied', sha256('anonymous'), 'authentication_required');
      throw new AuthError('authentication_required', 401);
    }
    const session = this.#store.findSession(sha256(sessionToken));
    const user = session === undefined ? undefined : this.#store.getUser(session.user_id);
    if (
      session === undefined ||
      session.revoked_at !== undefined ||
      instant(this.#now()) >= instant(session.expires_at) ||
      user === undefined
    ) {
      this.#recordAudit('session_check', 'denied', sha256('invalid-session'), 'authentication_required');
      throw new AuthError('authentication_required', 401);
    }
    this.#recordAudit('session_check', 'allowed', sha256(user.user_id), 'authenticated');
    return user;
  }

  logout(sessionToken: string | undefined): void {
    if (sessionToken === undefined || !this.#store.revokeSession(sha256(sessionToken), this.#now())) {
      this.#recordAudit('logout', 'denied', sha256('invalid-session'), 'authentication_required');
      throw new AuthError('authentication_required', 401);
    }
    this.#recordAudit('logout', 'allowed', sha256(sessionToken), 'session_revoked');
  }

  async beginWebAuthnRegistration(
    sessionToken: string | undefined,
  ): Promise<WebAuthnCeremony<PublicKeyCredentialCreationOptionsJSON>> {
    const user = this.authenticate(sessionToken);
    const options = await this.#webauthn.generateRegistrationOptions({
      rpName: this.#rpName,
      rpID: this.#rpId,
      userID: new TextEncoder().encode(user.user_id),
      userName: user.email,
      userDisplayName: 'Harness user',
      timeout: CHALLENGE_LIFETIME_MS,
      attestationType: 'none',
      excludeCredentials: user.webauthn_credentials.map((credential) => ({
        id: credential.id,
        ...(credential.transports === undefined ? {} : { transports: [...credential.transports] }),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    const challenge = requireString(options.challenge, 1024);
    const now = this.#now();
    const ceremonyToken = this.#createOpaqueToken();
    this.#store.createChallenge(
      {
        key_hash: sha256(ceremonyToken),
        kind: 'registration',
        user_id: user.user_id,
        challenge,
        expires_at: new Date(instant(now) + CHALLENGE_LIFETIME_MS).toISOString(),
      },
      now,
    );
    this.#recordAudit('webauthn_register', 'allowed', sha256(user.user_id), 'challenge_issued');
    return Object.freeze({
      options: structuredClone(options),
      cookie: this.#ceremonyCookie(ceremonyToken),
    });
  }

  async beginWebAuthnAuthentication(): Promise<WebAuthnCeremony<PublicKeyCredentialRequestOptionsJSON>> {
    const options = await this.#webauthn.generateAuthenticationOptions({
      rpID: this.#rpId,
      timeout: CHALLENGE_LIFETIME_MS,
      userVerification: 'required',
    });
    const challenge = requireString(options.challenge, 1024);
    const now = this.#now();
    const ceremonyToken = this.#createOpaqueToken();
    this.#store.createChallenge(
      {
        key_hash: sha256(ceremonyToken),
        kind: 'authentication',
        challenge,
        expires_at: new Date(instant(now) + CHALLENGE_LIFETIME_MS).toISOString(),
      },
      now,
    );
    this.#recordAudit('webauthn_authenticate', 'allowed', sha256('anonymous'), 'challenge_issued');
    return Object.freeze({
      options: structuredClone(options),
      cookie: this.#ceremonyCookie(ceremonyToken),
    });
  }

  async verifyWebAuthnCeremony(ceremonyToken: string | undefined, response: unknown): Promise<AuthSession> {
    if (ceremonyToken === undefined) {
      this.#recordAudit('webauthn_verify', 'denied', sha256('anonymous'), 'challenge_invalid');
      throw new AuthError('authentication_failed', 401);
    }
    const consumed = this.#store.consumeChallenge(sha256(ceremonyToken), this.#now());
    if (consumed === undefined) {
      this.#recordAudit('webauthn_verify', 'denied', sha256('anonymous'), 'challenge_invalid');
      throw new AuthError('authentication_failed', 401);
    }
    const failure = (): never => {
      const registration = consumed.record.kind === 'registration';
      const subject = consumed.record.user_id === undefined ? 'anonymous' : consumed.record.user_id;
      this.#recordAudit('webauthn_verify', 'denied', sha256(subject), 'verification_failed');
      throw new AuthError(
        registration ? 'webauthn_verification_failed' : 'authentication_failed',
        registration ? 400 : 401,
      );
    };
    if (!consumed.accepted || typeof response !== 'object' || response === null || Array.isArray(response)) {
      return failure();
    }
    if (consumed.record.kind === 'registration') {
      return this.#verifyWebAuthnRegistration(consumed.record, response, failure);
    }
    return this.#verifyWebAuthnAuthentication(consumed.record, response, failure);
  }

  async #verifyWebAuthnRegistration(
    challenge: ChallengeRecord,
    response: unknown,
    failure: () => never,
  ): Promise<AuthSession> {
    const user = challenge.user_id === undefined ? undefined : this.#store.getUser(challenge.user_id);
    if (user === undefined) return failure();
    let result: VerifiedRegistrationResponse;
    try {
      result = await this.#webauthn.verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.#origin,
        expectedRPID: this.#rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      return failure();
    }
    if (
      !result.verified ||
      !result.registrationInfo.userVerified ||
      result.registrationInfo.origin !== this.#origin ||
      result.registrationInfo.rpID !== this.#rpId
    ) {
      return failure();
    }
    try {
      await this.#store.addWebAuthnCredential(user.user_id, result.registrationInfo.credential);
    } catch {
      return failure();
    }
    this.#recordAudit('webauthn_verify', 'allowed', sha256(user.user_id), 'credential_registered');
    return this.#issueSession(user.user_id);
  }

  async #verifyWebAuthnAuthentication(
    challenge: ChallengeRecord,
    response: unknown,
    failure: () => never,
  ): Promise<AuthSession> {
    const credentialId = (response as Record<string, unknown>).id;
    if (typeof credentialId !== 'string' || credentialId.length === 0 || credentialId.length > 1024) {
      return failure();
    }
    const match = this.#store.findWebAuthnCredential(credentialId);
    if (match === undefined) return failure();
    let result: VerifiedAuthenticationResponse;
    try {
      result = await this.#webauthn.verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.#origin,
        expectedRPID: this.#rpId,
        credential: match.credential,
        expectedType: 'webauthn.get',
        requireUserVerification: true,
      });
    } catch {
      return failure();
    }
    const info = result.authenticationInfo;
    if (
      !result.verified ||
      !info.userVerified ||
      info.credentialID !== credentialId ||
      info.origin !== this.#origin ||
      info.rpID !== this.#rpId ||
      !this.#store.updateWebAuthnCounter(match.user.user_id, credentialId, match.credential.counter, info.newCounter)
    ) {
      return failure();
    }
    this.#recordAudit('webauthn_verify', 'allowed', sha256(match.user.user_id), 'authenticated');
    return this.#issueSession(match.user.user_id);
  }

  purgeExpiredAuditEvents(): number {
    const cutoff = instant(this.#now()) - AUDIT_RETENTION_MS;
    const retained = this.#audit.filter((event) => instant(event.timestamp) >= cutoff);
    const removed = this.#audit.length - retained.length;
    this.#audit.splice(0, this.#audit.length, ...retained);
    return removed;
  }

  #issueSession(userId: string): AuthSession {
    const token = this.#createOpaqueToken();
    const now = this.#now();
    this.#store.createSession({
      token_hash: sha256(token),
      user_id: userId,
      issued_at: now,
      expires_at: new Date(instant(now) + SESSION_LIFETIME_MS).toISOString(),
    });
    return {
      token,
      user_id: userId,
      cookie: `${SESSION_COOKIE}=${token}; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Strict`,
    };
  }

  #createOpaqueToken(): string {
    const bytes = this.#randomBytes(32);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
      throw new AuthError('authentication_failed', 401);
    }
    return Buffer.from(bytes).toString('base64url');
  }

  #ceremonyCookie(token: string): string {
    return `${WEBAUTHN_COOKIE}=${token}; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Strict`;
  }

  #recordAudit(
    action: AuthAuditEvent['action'],
    outcome: AuthAuditEvent['outcome'],
    subjectRef: string,
    reasonCode: string,
  ): void {
    this.#audit.push(
      Object.freeze({
        timestamp: this.#now(),
        action,
        outcome,
        subject_ref: subjectRef,
        reason_code: reasonCode,
      }),
    );
  }
}

export class AuthApi {
  readonly #service: AuthService;

  constructor(service: AuthService) {
    this.#service = service;
  }

  async handle(request: AuthApiRequest): Promise<AuthApiResponse> {
    try {
      if (request.method === 'POST' && request.path === '/auth/login') {
        if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
          throw new AuthError('invalid_request', 400);
        }
        const body = request.body as Record<string, unknown>;
        let session: AuthSession;
        if (body.method === 'password') {
          session = await this.#service.login(body.email, body.password, request.client_id);
        } else if (body.method === 'webauthn') {
          session = await this.#service.verifyWebAuthnCeremony(
            parseWebAuthnCookie(request.cookie),
            body.webauthn_assertion,
          );
        } else {
          throw new AuthError('invalid_request', 400);
        }
        return this.#response(200, { authenticated: true }, { 'set-cookie': session.cookie });
      }
      if (request.method === 'GET' && request.path === '/auth/me') {
        const user = this.#service.authenticate(parseSessionCookie(request.cookie));
        return this.#response(200, { user_id: user.user_id });
      }
      if (request.method === 'POST' && request.path === '/auth/logout') {
        this.#service.logout(parseSessionCookie(request.cookie));
        return this.#response(
          200,
          { authenticated: false },
          {
            'set-cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`,
          },
        );
      }
      if (request.method === 'POST' && request.path === '/auth/webauthn/register') {
        const ceremony = await this.#service.beginWebAuthnRegistration(parseSessionCookie(request.cookie));
        return this.#response(200, ceremony.options, {
          'set-cookie': ceremony.cookie,
        });
      }
      if (request.method === 'POST' && request.path === '/auth/webauthn/authenticate') {
        const ceremony = await this.#service.beginWebAuthnAuthentication();
        return this.#response(200, ceremony.options, {
          'set-cookie': ceremony.cookie,
        });
      }
      if (request.method === 'POST' && request.path === '/auth/webauthn/verify') {
        const body =
          typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
            ? (request.body as Record<string, unknown>)
            : undefined;
        const session = await this.#service.verifyWebAuthnCeremony(
          parseWebAuthnCookie(request.cookie),
          body?.credential,
        );
        return this.#response(200, { authenticated: true }, { 'set-cookie': session.cookie });
      }
      return this.#response(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof AuthError) return this.#response(error.status, { error: error.code });
      return this.#response(400, { error: 'invalid_request' });
    }
  }

  #response(status: number, body: unknown, headers: Record<string, string> = {}): AuthApiResponse {
    return Object.freeze({
      status,
      headers: Object.freeze({ ...headers }),
      body: structuredClone(body),
    });
  }
}
