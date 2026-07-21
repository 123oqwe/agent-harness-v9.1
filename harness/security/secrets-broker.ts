import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import Database from 'better-sqlite3';

import {
  AuthorizationService,
  hashCapabilityGrant,
  type CredentialExchangeContext,
} from './authorization-service.js';
import { CredentialDispatchError, type SignedCapabilityToken } from './capability.js';
import { isStrictDateTime } from './policy-engine.js';

const PBKDF2_ITERATIONS = 100_000;
const MASTER_KEY_BYTES = 32;
const KDF_SALT_BYTES = 16;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_PASSWORD_BYTES = 1024;
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const KEY_CHECK_PLAINTEXT = Buffer.from('agent-harness-vault-key-check-v1');
const KEY_CHECK_AAD = Buffer.from('agent-harness:vault:key-check:v1');
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUESTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const RECORD_DENIAL = Symbol('record-secret-access-denial');

interface MetadataRow {
  key: string;
  value: Buffer;
}

interface EncryptedSecretRow {
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}

interface ExchangeResult {
  readonly kind: 'success' | 'replay' | 'missing' | 'integrity';
  readonly value?: Buffer;
}

export interface SecretAuditEvent {
  readonly timestamp: string;
  readonly action: 'put' | 'get' | 'list' | 'delete';
  readonly secret_name: string;
  readonly requester: string;
  readonly outcome: 'grant' | 'deny';
  readonly reason_code: string;
}

export interface SecretsBrokerOptions {
  readonly database_path: string;
  readonly password: string;
  readonly tenant_id: string;
  readonly authorization_service: AuthorizationService;
  readonly now?: () => string;
  readonly random_bytes?: (length: number) => Uint8Array;
}

export interface SecretDispatchRequest<T> {
  readonly name: string;
  readonly requester: string;
  readonly capability: SignedCapabilityToken;
  readonly confirmation_key_thumbprint: string;
  readonly dispatch: (credential: Uint8Array) => Promise<T>;
}

export interface SecretsBrokerApiRequest {
  readonly method: string;
  readonly path: string;
  readonly session_token?: string;
  readonly capability?: SignedCapabilityToken;
  readonly confirmation_key_thumbprint?: string;
  readonly body?: unknown;
}

export interface SecretsBrokerApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export class SecretBrokerError extends Error {
  constructor(message = 'secret broker request failed') {
    super(message);
    this.name = new.target.name;
  }
}

export class SecretAccessDeniedError extends SecretBrokerError {
  constructor(message = 'secret access denied') {
    super(message);
  }
}

export class SecretNotFoundError extends SecretBrokerError {
  constructor() {
    super('secret not found');
  }
}

export class SecretIntegrityError extends SecretBrokerError {
  constructor() {
    super('secret integrity verification failed');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new SecretBrokerError('invalid secret name');
  }
}

function validateRequester(requester: unknown): asserts requester is string {
  if (typeof requester !== 'string' || !REQUESTER_PATTERN.test(requester)) {
    throw new SecretBrokerError('invalid requester');
  }
}

function requireBytes(value: unknown, label: string, expectedLength?: number): Buffer {
  if (!(value instanceof Uint8Array)) throw new SecretBrokerError(`invalid ${label}`);
  const copy = Buffer.from(value);
  if (
    (expectedLength !== undefined && copy.byteLength !== expectedLength) ||
    copy.byteLength === 0 ||
    copy.every((byte) => byte === 0)
  ) {
    copy.fill(0);
    throw new SecretBrokerError(`invalid ${label}`);
  }
  return copy;
}

function secretAad(name: string): Buffer {
  return Buffer.from(JSON.stringify({ name, version: 1 }));
}

function encrypt(
  key: Buffer,
  plaintext: Buffer,
  nonce: Buffer,
  aad: Buffer,
): { ciphertext: Buffer; authTag: Buffer } {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, authTag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, row: EncryptedSecretRow, aad: Buffer): Buffer {
  if (
    !(row.nonce instanceof Buffer) ||
    row.nonce.byteLength !== GCM_NONCE_BYTES ||
    !(row.ciphertext instanceof Buffer) ||
    !(row.auth_tag instanceof Buffer) ||
    row.auth_tag.byteLength !== GCM_TAG_BYTES
  ) {
    throw new SecretIntegrityError();
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, row.nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  } catch {
    throw new SecretIntegrityError();
  }
}

function canonicalTimestamp(value: unknown): string {
  if (!isStrictDateTime(value)) throw new SecretBrokerError('clock returned an invalid timestamp');
  return new Date(Date.parse(value)).toISOString();
}

function cloneAudit(row: SecretAuditEvent): SecretAuditEvent {
  return Object.freeze({ ...row });
}

export function secretReadOperation(name: string): string {
  validateName(name);
  return `vault.secret.read:${createHash('sha256').update(name).digest('hex')}`;
}

export class SecretsBroker {
  readonly #database: Database.Database;
  readonly #databasePath: string;
  readonly #now: () => string;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #authorizationService: AuthorizationService;
  readonly #tenantId: string;
  readonly #masterKey: Buffer;
  #closed = false;

  constructor(options: SecretsBrokerOptions) {
    if (!isRecord(options)) throw new SecretBrokerError('invalid secret broker options');
    if (typeof options.database_path !== 'string' || !isAbsolute(options.database_path)) {
      throw new SecretBrokerError('vault database path must be absolute');
    }
    if (
      typeof options.password !== 'string' ||
      Buffer.byteLength(options.password, 'utf8') === 0 ||
      Buffer.byteLength(options.password, 'utf8') > MAX_PASSWORD_BYTES
    ) {
      throw new SecretBrokerError('invalid vault password');
    }
    if (typeof options.tenant_id !== 'string' || !REQUESTER_PATTERN.test(options.tenant_id)) {
      throw new SecretBrokerError('invalid vault tenant');
    }
    if (!(options.authorization_service instanceof AuthorizationService)) {
      throw new SecretBrokerError('authorization service is required');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new SecretBrokerError('now must be a function');
    }
    if (options.random_bytes !== undefined && typeof options.random_bytes !== 'function') {
      throw new SecretBrokerError('random_bytes must be a function');
    }
    if (existsSync(options.database_path) && lstatSync(options.database_path).isSymbolicLink()) {
      throw new SecretBrokerError('vault database symlinks are forbidden');
    }

    this.#databasePath = options.database_path;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomBytes = options.random_bytes ?? randomBytes;
    this.#authorizationService = options.authorization_service;
    this.#tenantId = options.tenant_id;
    canonicalTimestamp(this.#now());
    const parent = dirname(this.#databasePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const hadContent = existsSync(this.#databasePath) && statSync(this.#databasePath).size > 0;
    const database = new Database(this.#databasePath);
    let masterKey: Buffer | undefined;
    try {
      chmodSync(this.#databasePath, 0o600);
      database.pragma('journal_mode = DELETE');
      database.pragma('foreign_keys = ON');
      database.pragma('secure_delete = ON');
      database.pragma('trusted_schema = OFF');
      database.exec(`
        CREATE TABLE IF NOT EXISTS vault_metadata (
          key TEXT PRIMARY KEY,
          value BLOB NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vault_secrets (
          name TEXT PRIMARY KEY,
          nonce BLOB NOT NULL CHECK(length(nonce) = 12),
          ciphertext BLOB NOT NULL,
          auth_tag BLOB NOT NULL CHECK(length(auth_tag) = 16),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vault_nonces (
          nonce BLOB PRIMARY KEY CHECK(length(nonce) = 12)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vault_exchanges (
          token_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          secret_name TEXT NOT NULL,
          exchanged_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vault_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('put', 'get', 'list', 'delete')),
          secret_name TEXT NOT NULL,
          requester TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('grant', 'deny')),
          reason_code TEXT NOT NULL
        ) STRICT;
      `);
      const metadataRows = database.prepare('SELECT key, value FROM vault_metadata').all() as MetadataRow[];
      if (metadataRows.length === 0) {
        if (hadContent) throw new SecretAccessDeniedError('vault unlock failed');
        masterKey = this.#initializeVault(database, options.password, options.tenant_id);
      } else {
        masterKey = this.#unlockVault(database, metadataRows, options.password, options.tenant_id);
      }
    } catch (error) {
      masterKey?.fill(0);
      database.close();
      if (error instanceof SecretBrokerError) throw error;
      throw new SecretBrokerError('vault initialization failed');
    }
    this.#database = database;
    this.#masterKey = masterKey;
  }

  get auditEvents(): readonly SecretAuditEvent[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        'SELECT timestamp, action, secret_name, requester, outcome, reason_code FROM vault_audit ORDER BY id',
      )
      .all() as SecretAuditEvent[];
    return Object.freeze(rows.map(cloneAudit));
  }

  putSecret(name: string, value: Uint8Array, requester: string): void {
    this.#assertOpen();
    validateName(name);
    validateRequester(requester);
    if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_SECRET_BYTES) {
      this.#writeAudit('put', name, requester, 'deny', 'invalid_secret_value');
      throw new SecretBrokerError('invalid secret value');
    }
    const plaintext = Buffer.from(value);
    let nonce: Buffer | undefined;
    let encrypted: { ciphertext: Buffer; authTag: Buffer } | undefined;
    try {
      nonce = this.#uniqueNonce();
      encrypted = encrypt(this.#masterKey, plaintext, nonce, secretAad(name));
      const encryptedPayload = encrypted;
      const now = canonicalTimestamp(this.#now());
      const write = this.#database.transaction(() => {
        this.#database.prepare('INSERT INTO vault_nonces(nonce) VALUES (?)').run(nonce);
        this.#database
          .prepare(
            `INSERT INTO vault_secrets(name, nonce, ciphertext, auth_tag, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               nonce = excluded.nonce,
               ciphertext = excluded.ciphertext,
               auth_tag = excluded.auth_tag,
               updated_at = excluded.updated_at`,
          )
          .run(name, nonce, encryptedPayload.ciphertext, encryptedPayload.authTag, now, now);
        this.#insertAudit(now, 'put', name, requester, 'grant', 'stored');
      });
      write.immediate();
    } catch (error) {
      if (error instanceof SecretBrokerError) throw error;
      throw new SecretBrokerError('secret storage failed');
    } finally {
      plaintext.fill(0);
      nonce?.fill(0);
      encrypted?.ciphertext.fill(0);
      encrypted?.authTag.fill(0);
    }
  }

  listSecrets(requester: string): readonly string[] {
    this.#assertOpen();
    validateRequester(requester);
    try {
      const list = this.#database.transaction(() => {
        const names = this.#database
          .prepare('SELECT name FROM vault_secrets ORDER BY name')
          .all()
          .map((row) => (row as { name: string }).name);
        this.#insertAudit(canonicalTimestamp(this.#now()), 'list', '*', requester, 'grant', 'listed');
        return names;
      });
      return Object.freeze(list.immediate());
    } catch {
      throw new SecretBrokerError('secret listing failed');
    }
  }

  deleteSecret(name: string, requester: string): boolean {
    this.#assertOpen();
    validateName(name);
    validateRequester(requester);
    try {
      const remove = this.#database.transaction(() => {
        const changed = this.#database.prepare('DELETE FROM vault_secrets WHERE name = ?').run(name).changes === 1;
        this.#insertAudit(
          canonicalTimestamp(this.#now()),
          'delete',
          name,
          requester,
          changed ? 'grant' : 'deny',
          changed ? 'deleted' : 'not_found',
        );
        return changed;
      });
      return remove.immediate();
    } catch {
      throw new SecretBrokerError('secret deletion failed');
    }
  }

  async dispatchWithSecret<T>(request: SecretDispatchRequest<T>): Promise<T> {
    this.#assertOpen();
    if (!isRecord(request)) throw new SecretAccessDeniedError();
    validateName(request.name);
    validateRequester(request.requester);
    if (typeof request.dispatch !== 'function') throw new SecretAccessDeniedError();
    const claims = isRecord(request.capability) && isRecord(request.capability.claims)
      ? request.capability.claims
      : undefined;
    const expectedResourceHash = hashCapabilityGrant([`vault-secret:${request.name}`]);
    if (
      claims === undefined ||
      claims.operation_id !== secretReadOperation(request.name) ||
      claims.resource_grant_hash !== expectedResourceHash ||
      claims.tool_grant_hash !== hashCapabilityGrant(['secrets.exchange']) ||
      claims.tenant_id !== this.#tenantId ||
      claims.audience !== 'harness-secrets-broker' ||
      claims.subject_workload !== request.requester ||
      typeof request.confirmation_key_thumbprint !== 'string' ||
      request.confirmation_key_thumbprint.length === 0
    ) {
      this.#writeAudit('get', request.name, request.requester, 'deny', 'capability_scope_mismatch');
      throw new SecretAccessDeniedError();
    }

    let dispatchStarted = false;
    try {
      return await this.#authorizationService.dispatchWithExchangedCredential({
        capability: request.capability,
        confirmation_key_thumbprint: request.confirmation_key_thumbprint,
        exchange: async (context) => {
          const exchanged = this.#exchange(request.name, request.requester, context);
          if (exchanged.kind === 'replay') throw new SecretAccessDeniedError();
          if (exchanged.kind === 'missing') throw new SecretNotFoundError();
          if (exchanged.kind === 'integrity') throw new SecretIntegrityError();
          const value = exchanged.value!;
          return {
            value,
            dispose: () => {
              value.fill(0);
            },
          };
        },
        dispatch: async (credential) => {
          dispatchStarted = true;
          return request.dispatch(credential);
        },
      });
    } catch (error) {
      if (dispatchStarted) throw error;
      if (error instanceof SecretNotFoundError || error instanceof SecretIntegrityError) throw error;
      if (!(error instanceof SecretAccessDeniedError)) {
        this.#writeAudit('get', request.name, request.requester, 'deny', 'capability_rejected');
      }
      throw new SecretAccessDeniedError();
    }
  }

  purgeExpiredAudit(): number {
    this.#assertOpen();
    const cutoff = new Date(Date.parse(canonicalTimestamp(this.#now())) - AUDIT_RETENTION_MS).toISOString();
    try {
      return this.#database.prepare('DELETE FROM vault_audit WHERE timestamp <= ?').run(cutoff).changes;
    } catch {
      throw new SecretBrokerError('audit retention failed');
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#masterKey.fill(0);
    this.#database.close();
    this.#closed = true;
  }

  [RECORD_DENIAL](
    action: SecretAuditEvent['action'],
    name: string,
    requester: string,
    reasonCode: string,
  ): void {
    this.#assertOpen();
    const safeName = name === '*' || NAME_PATTERN.test(name) ? name : '<invalid>';
    const safeRequester = REQUESTER_PATTERN.test(requester) ? requester : 'anonymous';
    this.#writeAudit(action, safeName, safeRequester, 'deny', reasonCode);
  }

  #initializeVault(database: Database.Database, password: string, tenantId: string): Buffer {
    const salt = requireBytes(this.#randomBytes(KDF_SALT_BYTES), 'vault entropy', KDF_SALT_BYTES);
    const passwordBytes = Buffer.from(password);
    let key: Buffer | undefined;
    let nonce: Buffer | undefined;
    let encrypted: { ciphertext: Buffer; authTag: Buffer } | undefined;
    let initialized = false;
    try {
      key = pbkdf2Sync(passwordBytes, salt, PBKDF2_ITERATIONS, MASTER_KEY_BYTES, 'sha256');
      nonce = requireBytes(this.#randomBytes(GCM_NONCE_BYTES), 'vault entropy', GCM_NONCE_BYTES);
      encrypted = encrypt(key, KEY_CHECK_PLAINTEXT, nonce, KEY_CHECK_AAD);
      const values: Array<[string, Buffer]> = [
        ['schema_version', Buffer.from('1')],
        ['cipher_algorithm', Buffer.from('AES-256-GCM')],
        ['kdf_algorithm', Buffer.from('PBKDF2-SHA256')],
        ['kdf_iterations', Buffer.from(String(PBKDF2_ITERATIONS))],
        ['kdf_salt', salt],
        ['tenant_id_hash', Buffer.from(createHash('sha256').update(tenantId).digest('hex'))],
        ['key_check_nonce', nonce],
        ['key_check_ciphertext', encrypted.ciphertext],
        ['key_check_auth_tag', encrypted.authTag],
      ];
      const initialize = database.transaction(() => {
        const insert = database.prepare('INSERT INTO vault_metadata(key, value) VALUES (?, ?)');
        for (const [metadataKey, value] of values) insert.run(metadataKey, value);
        database.prepare('INSERT INTO vault_nonces(nonce) VALUES (?)').run(nonce);
      });
      initialize.immediate();
      initialized = true;
      return key;
    } finally {
      if (!initialized) key?.fill(0);
      passwordBytes.fill(0);
      salt.fill(0);
      nonce?.fill(0);
      encrypted?.ciphertext.fill(0);
      encrypted?.authTag.fill(0);
    }
  }

  #unlockVault(
    database: Database.Database,
    rows: MetadataRow[],
    password: string,
    tenantId: string,
  ): Buffer {
    const metadata = new Map(rows.map((row) => [row.key, Buffer.from(row.value)]));
    const required = [
      'schema_version',
      'cipher_algorithm',
      'kdf_algorithm',
      'kdf_iterations',
      'kdf_salt',
      'tenant_id_hash',
      'key_check_nonce',
      'key_check_ciphertext',
      'key_check_auth_tag',
    ];
    if (
      metadata.size !== required.length ||
      required.some((key) => !metadata.has(key)) ||
      metadata.get('schema_version')!.toString() !== '1' ||
      metadata.get('cipher_algorithm')!.toString() !== 'AES-256-GCM' ||
      metadata.get('kdf_algorithm')!.toString() !== 'PBKDF2-SHA256' ||
      metadata.get('kdf_iterations')!.toString() !== String(PBKDF2_ITERATIONS) ||
      metadata.get('kdf_salt')!.byteLength !== KDF_SALT_BYTES ||
      metadata.get('tenant_id_hash')!.toString() !== createHash('sha256').update(tenantId).digest('hex')
    ) {
      for (const value of metadata.values()) value.fill(0);
      throw new SecretAccessDeniedError('vault unlock failed');
    }
    const passwordBytes = Buffer.from(password);
    const key = pbkdf2Sync(
      passwordBytes,
      metadata.get('kdf_salt')!,
      PBKDF2_ITERATIONS,
      MASTER_KEY_BYTES,
      'sha256',
    );
    passwordBytes.fill(0);
    try {
      const plaintext = decrypt(
        key,
        {
          nonce: metadata.get('key_check_nonce')!,
          ciphertext: metadata.get('key_check_ciphertext')!,
          auth_tag: metadata.get('key_check_auth_tag')!,
        },
        KEY_CHECK_AAD,
      );
      const valid = plaintext.length === KEY_CHECK_PLAINTEXT.length && plaintext.equals(KEY_CHECK_PLAINTEXT);
      plaintext.fill(0);
      if (!valid) throw new SecretAccessDeniedError('vault unlock failed');
      database.prepare('INSERT OR IGNORE INTO vault_nonces(nonce) VALUES (?)').run(
        metadata.get('key_check_nonce')!,
      );
      return key;
    } catch {
      key.fill(0);
      throw new SecretAccessDeniedError('vault unlock failed');
    } finally {
      for (const value of metadata.values()) value.fill(0);
    }
  }

  #uniqueNonce(): Buffer {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const nonce = requireBytes(this.#randomBytes(GCM_NONCE_BYTES), 'vault entropy', GCM_NONCE_BYTES);
      const existing = this.#database.prepare('SELECT 1 FROM vault_nonces WHERE nonce = ?').get(nonce);
      if (existing === undefined) return nonce;
      nonce.fill(0);
    }
    throw new SecretBrokerError('unable to generate a unique nonce');
  }

  #exchange(name: string, requester: string, context: CredentialExchangeContext): ExchangeResult {
    const exchange = this.#database.transaction((): ExchangeResult => {
      const now = canonicalTimestamp(this.#now());
      const replay = this.#database
        .prepare('SELECT 1 FROM vault_exchanges WHERE token_id = ?')
        .get(context.token_id);
      if (replay !== undefined) {
        this.#insertAudit(now, 'get', name, requester, 'deny', 'exchange_replay');
        return { kind: 'replay' };
      }
      this.#database
        .prepare(
          'INSERT INTO vault_exchanges(token_id, operation_id, attempt_id, secret_name, exchanged_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(context.token_id, context.operation_id, context.attempt_id, name, now);
      const row = this.#database
        .prepare('SELECT nonce, ciphertext, auth_tag FROM vault_secrets WHERE name = ?')
        .get(name) as EncryptedSecretRow | undefined;
      if (row === undefined) {
        this.#insertAudit(now, 'get', name, requester, 'deny', 'not_found');
        return { kind: 'missing' };
      }
      try {
        const value = decrypt(this.#masterKey, row, secretAad(name));
        this.#insertAudit(now, 'get', name, requester, 'grant', 'exchanged');
        return { kind: 'success', value };
      } catch {
        this.#insertAudit(now, 'get', name, requester, 'deny', 'integrity_failure');
        return { kind: 'integrity' };
      }
    });
    try {
      return exchange.immediate();
    } catch {
      throw new SecretAccessDeniedError();
    }
  }

  #writeAudit(
    action: SecretAuditEvent['action'],
    name: string,
    requester: string,
    outcome: SecretAuditEvent['outcome'],
    reasonCode: string,
  ): void {
    try {
      this.#insertAudit(canonicalTimestamp(this.#now()), action, name, requester, outcome, reasonCode);
    } catch {
      throw new SecretBrokerError('audit write failed');
    }
  }

  #insertAudit(
    timestamp: string,
    action: SecretAuditEvent['action'],
    name: string,
    requester: string,
    outcome: SecretAuditEvent['outcome'],
    reasonCode: string,
  ): void {
    this.#database
      .prepare(
        'INSERT INTO vault_audit(timestamp, action, secret_name, requester, outcome, reason_code) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(timestamp, action, name, requester, outcome, reasonCode);
  }

  #assertOpen(): void {
    if (this.#closed) throw new SecretBrokerError('secret broker is closed');
  }
}

export class SecretsBrokerApi {
  readonly #broker: SecretsBroker;
  readonly #authenticateSession: (token: string | undefined) => Promise<string | undefined>;

  constructor(options: {
    readonly broker: SecretsBroker;
    readonly authenticate_session: (token: string | undefined) => Promise<string | undefined>;
  }) {
    if (!isRecord(options) || !(options.broker instanceof SecretsBroker)) {
      throw new SecretBrokerError('broker is required');
    }
    if (typeof options.authenticate_session !== 'function') {
      throw new SecretBrokerError('session authenticator is required');
    }
    this.#broker = options.broker;
    this.#authenticateSession = options.authenticate_session;
  }

  async handle(request: SecretsBrokerApiRequest): Promise<SecretsBrokerApiResponse> {
    try {
      if (!isRecord(request) || typeof request.method !== 'string' || typeof request.path !== 'string') {
        return this.#response(400, { error: 'invalid_request' });
      }
      if (request.method === 'GET' && request.path === '/vault/secrets') {
        const requester = await this.#requireSession(request.session_token, 'list', '*');
        return this.#response(200, this.#broker.listSecrets(requester));
      }
      const name = this.#itemName(request.path);
      if (name === undefined) return this.#response(404, { error: 'not_found' });
      if (request.method === 'PUT') {
        const requester = await this.#requireSession(request.session_token, 'put', name);
        if (!isRecord(request.body) || Object.keys(request.body).join(',') !== 'value' || typeof request.body.value !== 'string') {
          this.#broker[RECORD_DENIAL]('put', name, requester, 'invalid_request');
          return this.#response(400, { error: 'invalid_request' });
        }
        const value = Buffer.from(request.body.value);
        try {
          this.#broker.putSecret(name, value, requester);
        } finally {
          value.fill(0);
        }
        return this.#response(201, { stored: true });
      }
      if (request.method === 'DELETE') {
        const requester = await this.#requireSession(request.session_token, 'delete', name);
        return this.#broker.deleteSecret(name, requester)
          ? this.#response(204, null)
          : this.#response(404, { error: 'secret_not_found' });
      }
      if (request.method === 'GET') {
        if (request.capability === undefined || request.confirmation_key_thumbprint === undefined) {
          this.#broker[RECORD_DENIAL]('get', name, 'anonymous', 'capability_required');
          return this.#response(403, { error: 'capability_required' });
        }
        const requester = isRecord(request.capability.claims) && typeof request.capability.claims.subject_workload === 'string'
          ? request.capability.claims.subject_workload
          : 'anonymous';
        const value = await this.#broker.dispatchWithSecret({
          name,
          requester,
          capability: request.capability,
          confirmation_key_thumbprint: request.confirmation_key_thumbprint,
          dispatch: async (credential) => Buffer.from(credential).toString('utf8'),
        });
        return this.#response(
          200,
          { value, expires_at: request.capability.claims.expires_at },
          { 'cache-control': 'no-store', pragma: 'no-cache' },
        );
      }
      return this.#response(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof SessionRequiredError) {
        return this.#response(401, { error: 'authentication_required' });
      }
      if (error instanceof SecretNotFoundError) {
        return this.#response(404, { error: 'secret_not_found' });
      }
      if (error instanceof SecretAccessDeniedError || error instanceof SecretIntegrityError || error instanceof CredentialDispatchError) {
        return this.#response(403, { error: 'access_denied' });
      }
      if (error instanceof SecretBrokerError) {
        return this.#response(400, { error: 'invalid_request' });
      }
      return this.#response(500, { error: 'vault_unavailable' });
    }
  }

  async #requireSession(
    token: string | undefined,
    action: SecretAuditEvent['action'],
    name: string,
  ): Promise<string> {
    let requester: string | undefined;
    try {
      requester = await this.#authenticateSession(token);
    } catch {
      requester = undefined;
    }
    if (requester === undefined || !REQUESTER_PATTERN.test(requester)) {
      this.#broker[RECORD_DENIAL](action, name, 'anonymous', 'authentication_required');
      throw new SessionRequiredError();
    }
    return requester;
  }

  #itemName(path: string): string | undefined {
    const match = /^\/vault\/secrets\/([^/]+)$/u.exec(path);
    if (match === null) return undefined;
    try {
      const name = decodeURIComponent(match[1]!);
      validateName(name);
      return name;
    } catch {
      throw new SecretBrokerError('invalid secret name');
    }
  }

  #response(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): SecretsBrokerApiResponse {
    return Object.freeze({
      status,
      headers: Object.freeze({ ...headers }),
      body: structuredClone(body),
    });
  }
}

class SessionRequiredError extends Error {}
