import { generateKeyPairSync, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthorizationService,
  InMemoryCapabilityStateStore,
  hashCapabilityGrant,
  type CapabilityIssueRequest,
} from '../../security/authorization-service.js';
import {
  SecretAccessDeniedError,
  SecretBrokerError,
  SecretIntegrityError,
  SecretsBroker,
  SecretsBrokerApi,
  secretReadOperation,
} from '../../security/secrets-broker.js';

const NOW = '2026-01-01T00:00:00.000Z';
const PASSWORD = 'correct horse vault password';
const SECRET_VALUE = 'glm-provider-key-that-must-stay-local';
const HASHES = {
  manifest: 'a'.repeat(64),
  policy: 'b'.repeat(64),
  effect: 'c'.repeat(64),
  budget: 'f'.repeat(64),
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryVaultPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'harness-secret-broker-'));
  temporaryDirectories.push(directory);
  return join(directory, 'vault.sqlite');
}

function authorizationService(
  tokenId = '11111111-1111-4111-8111-111111111111',
  now: () => string = () => NOW,
) {
  const keys = generateKeyPairSync('ed25519');
  return {
    keys,
    service: new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new InMemoryCapabilityStateStore(),
      now,
      random_uuid: () => tokenId,
    }),
  };
}

function capabilityRequest(name: string, overrides: Partial<CapabilityIssueRequest> = {}): CapabilityIssueRequest {
  return {
    operation_id: secretReadOperation(name),
    attempt_id: 'attempt-1',
    manifest_hash: HASHES.manifest,
    policy_decision_hash: HASHES.policy,
    tool_effect_contract_hash: HASHES.effect,
    subject_workload: 'single-agent-runtime',
    tenant_id: 'tenant-1',
    audience: 'harness-secrets-broker',
    tool_grant_hash: hashCapabilityGrant(['secrets.exchange']),
    resource_grant_hash: hashCapabilityGrant([`vault-secret:${name}`]),
    budget_ceiling_hash: HASHES.budget,
    execution_epoch: 'epoch-1',
    confirmation_key_thumbprint: 'confirmation-key-1',
    not_before: NOW,
    expires_at: '2026-01-01T00:05:00.000Z',
    ...overrides,
  };
}

function createBroker(options: {
  path?: string;
  now?: () => string;
  random_bytes?: (length: number) => Uint8Array;
  token_id?: string;
  authorization_now?: () => string;
} = {}) {
  const path = options.path ?? temporaryVaultPath();
  const authority = authorizationService(options.token_id, options.authorization_now);
  const broker = new SecretsBroker({
    database_path: path,
    password: PASSWORD,
    tenant_id: 'tenant-1',
    authorization_service: authority.service,
    now: options.now ?? (() => NOW),
    ...(options.random_bytes === undefined ? {} : { random_bytes: options.random_bytes }),
  });
  return { path, broker, ...authority };
}

function apiFor(broker: SecretsBroker) {
  return new SecretsBrokerApi({
    broker,
    authenticate_session: async (token) => (token === 'valid-session' ? 'user-1' : undefined),
  });
}

describe('AH-CAPMAP-006 encrypted local SQLite vault', () => {
  it('stores only AES-256-GCM ciphertext in a real permission-restricted SQLite database', () => {
    let randomByte = 0;
    const { broker, path } = createBroker({
      random_bytes: (length) => Buffer.alloc(length, ++randomByte),
    });

    broker.putSecret('glm-api-key', Buffer.from(SECRET_VALUE), 'user-1');

    const file = readFileSync(path);
    expect(file.subarray(0, 16).toString()).toBe('SQLite format 3\0');
    expect(file.includes(Buffer.from(SECRET_VALUE))).toBe(false);
    expect(file.includes(Buffer.from(PASSWORD))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    const database = new Database(path, { readonly: true });
    const metadata = Object.fromEntries(
      database.prepare('SELECT key, value FROM vault_metadata').all().map((row) => {
        const entry = row as { key: string; value: Buffer };
        return [entry.key, entry.value];
      }),
    ) as Record<string, Buffer>;
    const encrypted = database
      .prepare('SELECT nonce, ciphertext, auth_tag FROM vault_secrets WHERE name = ?')
      .get('glm-api-key') as { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
    expect(metadata.kdf_algorithm!.toString()).toBe('PBKDF2-SHA256');
    expect(metadata.kdf_iterations!.toString()).toBe('100000');
    expect(metadata.kdf_salt).toHaveLength(16);
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.auth_tag).toHaveLength(16);
    expect(encrypted.ciphertext.equals(Buffer.from(SECRET_VALUE))).toBe(false);
    const derivedKey = pbkdf2Sync(PASSWORD, metadata.kdf_salt!, 100_000, 32, 'sha256');
    expect(file.includes(derivedKey)).toBe(false);
    database.close();
    derivedKey.fill(0);
    broker.close();
  });

  it('uses a fresh nonce on overwrite and rejects invalid entropy', () => {
    let sequence = 0;
    const { broker, path } = createBroker({
      random_bytes: (length) => Buffer.alloc(length, ++sequence),
    });
    broker.putSecret('provider-key', Buffer.from('same-value'), 'user-1');
    const database = new Database(path, { readonly: true });
    const first = database.prepare('SELECT nonce, ciphertext FROM vault_secrets WHERE name = ?').get('provider-key') as {
      nonce: Buffer;
      ciphertext: Buffer;
    };
    database.close();
    broker.putSecret('provider-key', Buffer.from('same-value'), 'user-1');
    const reopened = new Database(path, { readonly: true });
    const second = reopened.prepare('SELECT nonce, ciphertext FROM vault_secrets WHERE name = ?').get('provider-key') as {
      nonce: Buffer;
      ciphertext: Buffer;
    };
    expect(second.nonce.equals(first.nonce)).toBe(false);
    expect(second.ciphertext.equals(first.ciphertext)).toBe(false);
    expect((reopened.prepare('SELECT count(*) AS total FROM vault_nonces').get() as { total: number }).total).toBe(3);
    reopened.close();
    broker.close();

    expect(
      () =>
        createBroker({
          random_bytes: () => Buffer.alloc(0),
        }),
    ).toThrow(SecretBrokerError);
  });

  it('reopens with the password, rejects the wrong password, and never persists the derived key', async () => {
    const path = temporaryVaultPath();
    const first = createBroker({ path, token_id: '11111111-1111-4111-8111-111111111111' });
    first.broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    first.broker.close();

    expect(
      () =>
        new SecretsBroker({
          database_path: path,
          password: 'wrong password',
          tenant_id: 'tenant-1',
          authorization_service: authorizationService().service,
          now: () => NOW,
        }),
    ).toThrowError(new SecretAccessDeniedError('vault unlock failed'));
    expect(
      () =>
        new SecretsBroker({
          database_path: path,
          password: PASSWORD,
          tenant_id: 'tenant-2',
          authorization_service: authorizationService().service,
          now: () => NOW,
        }),
    ).toThrowError(new SecretAccessDeniedError('vault unlock failed'));

    const second = createBroker({ path, token_id: '22222222-2222-4222-8222-222222222222' });
    const capability = await second.service.issue(capabilityRequest('provider-key'));
    await expect(
      second.broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async (value) => Buffer.from(value).toString(),
      }),
    ).resolves.toBe(SECRET_VALUE);
    second.broker.close();
  });

  it('rejects relative paths, symlink databases, malformed names, and oversized values', () => {
    const authority = authorizationService();
    expect(
      () =>
        new SecretsBroker({
          database_path: 'relative.sqlite',
          password: PASSWORD,
          tenant_id: 'tenant-1',
          authorization_service: authority.service,
        }),
    ).toThrow(SecretBrokerError);

    const directory = mkdtempSync(join(tmpdir(), 'harness-secret-symlink-'));
    temporaryDirectories.push(directory);
    const target = join(directory, 'target.sqlite');
    const first = new SecretsBroker({
      database_path: target,
      password: PASSWORD,
      tenant_id: 'tenant-1',
      authorization_service: authority.service,
    });
    first.close();
    const alias = join(directory, 'alias.sqlite');
    symlinkSync(target, alias);
    expect(
      () =>
        new SecretsBroker({
          database_path: alias,
          password: PASSWORD,
          tenant_id: 'tenant-1',
          authorization_service: authority.service,
        }),
    ).toThrow(SecretBrokerError);

    const { broker } = createBroker();
    for (const name of ['', '../secret', 'a/b', 'x'.repeat(129)]) {
      expect(() => broker.putSecret(name, Buffer.from('value'), 'user-1')).toThrow(SecretBrokerError);
    }
    expect(() => broker.putSecret('valid', Buffer.alloc(1024 * 1024 + 1), 'user-1')).toThrow(
      SecretBrokerError,
    );
    broker.close();
  });

  it('fails closed for malformed construction, clocks, entropy, existing files, and closed use', () => {
    const authority = authorizationService().service;
    const path = temporaryVaultPath();
    expect(() => new SecretsBroker(null as never)).toThrow(SecretBrokerError);
    for (const password of ['', 'x'.repeat(1025)]) {
      expect(
        () =>
          new SecretsBroker({
            database_path: path,
            password,
            tenant_id: 'tenant-1',
            authorization_service: authority,
          }),
      ).toThrow(SecretBrokerError);
    }
    const boundary = new SecretsBroker({
      database_path: temporaryVaultPath(),
      password: 'x'.repeat(1024),
      tenant_id: 'tenant-1',
      authorization_service: authority,
      now: () => NOW,
    });
    boundary.close();
    expect(
      () =>
        new SecretsBroker({
          database_path: path,
          password: PASSWORD,
          tenant_id: '',
          authorization_service: authority,
        }),
    ).toThrow(SecretBrokerError);
    for (const random_bytes of [
      (() => 'not-bytes') as never,
      () => Buffer.alloc(15, 1),
      () => Buffer.alloc(16),
    ]) {
      expect(
        () =>
          new SecretsBroker({
            database_path: temporaryVaultPath(),
            password: PASSWORD,
            tenant_id: 'tenant-1',
            authorization_service: authority,
            now: () => NOW,
            random_bytes,
          }),
      ).toThrow(SecretBrokerError);
    }
    expect(
      () =>
        new SecretsBroker({
          database_path: path,
          password: PASSWORD,
          tenant_id: 'tenant-1',
          authorization_service: null as never,
        }),
    ).toThrow(SecretBrokerError);
    expect(
      () =>
        new SecretsBroker({
          database_path: path,
          password: PASSWORD,
          tenant_id: 'tenant-1',
          authorization_service: authority,
          now: 'invalid' as never,
        }),
    ).toThrow(SecretBrokerError);
    expect(
      () =>
        new SecretsBroker({
          database_path: path,
          password: PASSWORD,
          tenant_id: 'tenant-1',
          authorization_service: authority,
          now: () => 'invalid',
        }),
    ).toThrow(SecretBrokerError);
    expect(
      () =>
        new SecretsBroker({
          database_path: path,
          password: PASSWORD,
          tenant_id: 'tenant-1',
          authorization_service: authority,
          random_bytes: 'invalid' as never,
        }),
    ).toThrow(SecretBrokerError);

    const existing = temporaryVaultPath();
    writeFileSync(existing, 'not a SQLite vault');
    expect(
      () =>
        new SecretsBroker({
          database_path: existing,
          password: PASSWORD,
          tenant_id: 'tenant-1',
          authorization_service: authority,
        }),
    ).toThrow(SecretBrokerError);

    const { broker } = createBroker();
    expect(() => broker.listSecrets('../invalid')).toThrow(SecretBrokerError);
    expect(() => broker.putSecret('key', Buffer.alloc(0), 'user-1')).toThrow(SecretBrokerError);
    expect(() => broker.putSecret('key', 'not-bytes' as never, 'user-1')).toThrow(SecretBrokerError);
    expect(() => broker.putSecret('key', Buffer.from('value'), '../invalid')).toThrow(SecretBrokerError);
    const maximum = Buffer.alloc(1024 * 1024, 7);
    broker.putSecret('maximum', maximum, 'user-1');
    maximum.fill(0);
    broker.close();
    broker.close();
    expect(() => broker.listSecrets('user-1')).toThrow(SecretBrokerError);
    expect(() => broker.putSecret('key', Buffer.from('value'), 'user-1')).toThrow(SecretBrokerError);
  });

  it('rejects every corrupted or ambiguous vault metadata field before deriving a usable key', () => {
    const corruptions: Array<(database: Database.Database) => void> = [
      (database) => database.prepare('UPDATE vault_metadata SET value = ? WHERE key = ?').run(Buffer.from('2'), 'schema_version'),
      (database) => database.prepare('UPDATE vault_metadata SET value = ? WHERE key = ?').run(Buffer.from('other'), 'cipher_algorithm'),
      (database) => database.prepare('UPDATE vault_metadata SET value = ? WHERE key = ?').run(Buffer.from('other'), 'kdf_algorithm'),
      (database) => database.prepare('UPDATE vault_metadata SET value = ? WHERE key = ?').run(Buffer.from('99999'), 'kdf_iterations'),
      (database) => database.prepare('UPDATE vault_metadata SET value = ? WHERE key = ?').run(Buffer.alloc(15, 1), 'kdf_salt'),
      (database) => database.prepare('UPDATE vault_metadata SET value = ? WHERE key = ?').run(Buffer.from('0'.repeat(64)), 'tenant_id_hash'),
      (database) => database.prepare('DELETE FROM vault_metadata WHERE key = ?').run('key_check_auth_tag'),
      (database) => database.prepare('INSERT INTO vault_metadata(key, value) VALUES (?, ?)').run('unexpected', Buffer.from('value')),
    ];

    for (const corrupt of corruptions) {
      const path = temporaryVaultPath();
      const created = createBroker({ path });
      created.broker.close();
      const database = new Database(path);
      corrupt(database);
      database.close();
      expect(
        () =>
          new SecretsBroker({
            database_path: path,
            password: PASSWORD,
            tenant_id: 'tenant-1',
            authorization_service: authorizationService().service,
            now: () => NOW,
          }),
      ).toThrow(SecretAccessDeniedError);
    }
  });
});

describe('AH-CAPMAP-006 capability-scoped credential exchange', () => {
  it('decrypts only after signature validation and consumes a capability exactly once', async () => {
    const path = temporaryVaultPath();
    const { broker, service } = createBroker({ path });
    broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    const capability = await service.issue(capabilityRequest('provider-key'));
    const dispatch = vi.fn(async (value: Uint8Array) => {
      expect(Buffer.from(value).toString()).toBe(SECRET_VALUE);
      expect(Object.values(process.env)).not.toContain(SECRET_VALUE);
      return 'dispatched';
    });

    await expect(
      broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch,
      }),
    ).resolves.toBe('dispatched');
    await expect(
      broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch,
      }),
    ).rejects.toBeInstanceOf(SecretAccessDeniedError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    broker.close();
  });

  it('zeros plaintext after successful and failed dispatch and never writes it to the environment', async () => {
    const path = temporaryVaultPath();
    const { broker, service } = createBroker({ path });
    broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    const first = await service.issue(capabilityRequest('provider-key'));
    let captured: Uint8Array | undefined;
    await broker.dispatchWithSecret({
      name: 'provider-key',
      requester: 'single-agent-runtime',
      capability: first,
      confirmation_key_thumbprint: 'confirmation-key-1',
      dispatch: async (value) => {
        captured = value;
        return 'ok';
      },
    });
    expect(captured).toBeDefined();
    expect(captured!.every((value) => value === 0)).toBe(true);

    broker.close();
    const { broker: secondBroker, service: secondAuthority } = createBroker({
      path,
      token_id: '22222222-2222-4222-8222-222222222222',
    });
    const second = await secondAuthority.issue(capabilityRequest('provider-key', { attempt_id: 'attempt-2' }));
    let capturedOnFailure: Uint8Array | undefined;
    await expect(
      secondBroker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability: second,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async (value) => {
          capturedOnFailure = value;
          throw new Error('tool failed');
        },
      }),
    ).rejects.toThrow('tool failed');
    expect(capturedOnFailure!.every((value) => value === 0)).toBe(true);
    expect(Object.values(process.env)).not.toContain(SECRET_VALUE);
    secondBroker.close();
  });

  it('fails closed for wrong confirmation, audience, workload, operation, resource, expiry, or signature', async () => {
    const cases: Array<Partial<CapabilityIssueRequest>> = [
      { audience: 'wrong-audience' },
      { tenant_id: 'wrong-tenant' },
      { subject_workload: 'wrong-workload' },
      { tool_grant_hash: hashCapabilityGrant(['other-tool']) },
      { operation_id: secretReadOperation('other-key') },
      { resource_grant_hash: hashCapabilityGrant(['vault-secret:other-key']) },
    ];

    for (const [index, overrides] of cases.entries()) {
      const tokenId = `${String(index + 2).padStart(8, '0')}-1111-4111-8111-111111111111`;
      const { broker, service } = createBroker({ token_id: tokenId });
      broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
      const capability = await service.issue(capabilityRequest('provider-key', overrides));
      await expect(
        broker.dispatchWithSecret({
          name: 'provider-key',
          requester: 'single-agent-runtime',
          capability,
          confirmation_key_thumbprint: 'confirmation-key-1',
          dispatch: async () => 'must not run',
        }),
      ).rejects.toBeInstanceOf(SecretAccessDeniedError);
      broker.close();
    }

    let authorizationNow = NOW;
    const expiredCase = createBroker({
      token_id: '88888888-1111-4111-8111-111111111111',
      authorization_now: () => authorizationNow,
    });
    expiredCase.broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    const expired = await expiredCase.service.issue(capabilityRequest('provider-key'));
    authorizationNow = expired.claims.expires_at;
    await expect(
      expiredCase.broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability: expired,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async () => 'must not run',
      }),
    ).rejects.toBeInstanceOf(SecretAccessDeniedError);
    expiredCase.broker.close();

    const { broker, service } = createBroker({ token_id: '99999999-1111-4111-8111-111111111111' });
    broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    const capability = await service.issue(capabilityRequest('provider-key'));
    await expect(
      broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability,
        confirmation_key_thumbprint: 'wrong-key',
        dispatch: async () => 'must not run',
      }),
    ).rejects.toBeInstanceOf(SecretAccessDeniedError);
    const tampered = { ...capability, signature: `${capability.signature}x` };
    await expect(
      broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability: tampered,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async () => 'must not run',
      }),
    ).rejects.toBeInstanceOf(SecretAccessDeniedError);
    broker.close();
  });

  it('permits only one of concurrent exchanges and persists replay protection across restart', async () => {
    const path = temporaryVaultPath();
    const tokenId = '11111111-1111-4111-8111-111111111111';
    const first = createBroker({ path, token_id: tokenId });
    first.broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    const capability = await first.service.issue(capabilityRequest('provider-key'));
    const outcomes = await Promise.allSettled([
      first.broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async () => 'first',
      }),
      first.broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async () => 'second',
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    first.broker.close();

    const second = createBroker({ path, token_id: tokenId });
    const replay = await second.service.issue(capabilityRequest('provider-key'));
    await expect(
      second.broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability: replay,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async () => 'must not run',
      }),
    ).rejects.toBeInstanceOf(SecretAccessDeniedError);
    second.broker.close();
  });

  it('fails closed on ciphertext tampering and does not dispatch corrupted plaintext', async () => {
    const { path, broker, service } = createBroker();
    broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    const database = new Database(path);
    database.prepare('UPDATE vault_secrets SET ciphertext = ? WHERE name = ?').run(Buffer.from('tampered'), 'provider-key');
    database.close();
    const capability = await service.issue(capabilityRequest('provider-key'));
    const dispatch = vi.fn();

    await expect(
      broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch,
      }),
    ).rejects.toBeInstanceOf(SecretIntegrityError);
    expect(dispatch).not.toHaveBeenCalled();
    broker.close();
  });

  it('rejects malformed nonce and authentication-tag shapes before attempting decryption', async () => {
    for (const column of ['nonce', 'auth_tag'] as const) {
      const { path, broker, service } = createBroker();
      broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
      const database = new Database(path);
      database.pragma('ignore_check_constraints = ON');
      database.prepare(`UPDATE vault_secrets SET ${column} = ? WHERE name = ?`).run(Buffer.alloc(1, 1), 'provider-key');
      database.close();
      const capability = await service.issue(capabilityRequest('provider-key'));
      await expect(
        broker.dispatchWithSecret({
          name: 'provider-key',
          requester: 'single-agent-runtime',
          capability,
          confirmation_key_thumbprint: 'confirmation-key-1',
          dispatch: async () => 'must not run',
        }),
      ).rejects.toBeInstanceOf(SecretIntegrityError);
      broker.close();
    }
  });
});

describe('AH-CAPMAP-006 vault API and audit', () => {
  it('implements PUT/GET/list/DELETE with session management and capability-protected reads', async () => {
    const { broker, service } = createBroker();
    const api = apiFor(broker);

    await expect(
      api.handle({ method: 'PUT', path: '/vault/secrets/provider-key', body: { value: SECRET_VALUE } }),
    ).resolves.toMatchObject({ status: 401, body: { error: 'authentication_required' } });
    await expect(
      api.handle({
        method: 'PUT',
        path: '/vault/secrets/provider-key',
        session_token: 'valid-session',
        body: { value: SECRET_VALUE },
      }),
    ).resolves.toMatchObject({ status: 201, body: { stored: true } });
    await expect(api.handle({ method: 'GET', path: '/vault/secrets/provider-key' })).resolves.toMatchObject({
      status: 403,
      body: { error: 'capability_required' },
    });

    const capability = await service.issue(capabilityRequest('provider-key'));
    const get = await api.handle({
      method: 'GET',
      path: '/vault/secrets/provider-key',
      capability,
      confirmation_key_thumbprint: 'confirmation-key-1',
    });
    expect(get).toMatchObject({ status: 200, body: { value: SECRET_VALUE, expires_at: capability.claims.expires_at } });
    expect(get.headers).toMatchObject({ 'cache-control': 'no-store', pragma: 'no-cache' });

    const list = await api.handle({
      method: 'GET',
      path: '/vault/secrets',
      session_token: 'valid-session',
    });
    expect(list).toEqual({ status: 200, headers: {}, body: ['provider-key'] });
    expect(JSON.stringify(list)).not.toContain(SECRET_VALUE);

    await expect(
      api.handle({
        method: 'DELETE',
        path: '/vault/secrets/provider-key',
        session_token: 'valid-session',
      }),
    ).resolves.toEqual({ status: 204, headers: {}, body: null });
    await expect(
      api.handle({ method: 'GET', path: '/vault/secrets', session_token: 'valid-session' }),
    ).resolves.toEqual({ status: 200, headers: {}, body: [] });
    broker.close();
  });

  it('returns generic errors for malformed requests, missing secrets, and authorization failures', async () => {
    const { broker, service } = createBroker();
    const api = apiFor(broker);
    await expect(
      api.handle({ method: 'PUT', path: '/vault/secrets/key', session_token: 'valid-session', body: { value: 1 } }),
    ).resolves.toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    const capability = await service.issue(capabilityRequest('missing'));
    await expect(
      api.handle({
        method: 'GET',
        path: '/vault/secrets/missing',
        capability,
        confirmation_key_thumbprint: 'confirmation-key-1',
      }),
    ).resolves.toMatchObject({ status: 404, body: { error: 'secret_not_found' } });
    await expect(api.handle({ method: 'POST', path: '/vault/secrets' })).resolves.toEqual({
      status: 404,
      headers: {},
      body: { error: 'not_found' },
    });
    await expect(api.handle(null as never)).resolves.toMatchObject({
      status: 400,
      body: { error: 'invalid_request' },
    });
    await expect(
      api.handle({ method: 'GET', path: '/vault/secrets/%2Fescape', session_token: 'valid-session' }),
    ).resolves.toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    await expect(api.handle({ method: 1 as never, path: '/vault/secrets' })).resolves.toMatchObject({ status: 400 });
    await expect(api.handle({ method: 'GET', path: 1 as never })).resolves.toMatchObject({ status: 400 });
    await expect(api.handle({ method: 'GET', path: '/prefix/vault/secrets/key' })).resolves.toMatchObject({ status: 404 });
    await expect(api.handle({ method: 'GET', path: '/vault/secrets/key/suffix' })).resolves.toMatchObject({ status: 404 });
    broker.close();
  });

  it('requires each capability input independently and maps integrity failures to a generic 403', async () => {
    const { path, broker, service } = createBroker();
    broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    const first = await service.issue(capabilityRequest('provider-key'));
    await expect(
      apiFor(broker).handle({
        method: 'GET',
        path: '/vault/secrets/provider-key',
        capability: first,
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: 'capability_required' } });
    await expect(
      apiFor(broker).handle({
        method: 'GET',
        path: '/vault/secrets/provider-key',
        confirmation_key_thumbprint: 'confirmation-key-1',
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: 'capability_required' } });

    const secondAuthority = authorizationService('22222222-2222-4222-8222-222222222222').service;
    broker.close();
    const secondBroker = new SecretsBroker({
      database_path: path,
      password: PASSWORD,
      tenant_id: 'tenant-1',
      authorization_service: secondAuthority,
      now: () => NOW,
    });
    const database = new Database(path);
    database.prepare('UPDATE vault_secrets SET ciphertext = ? WHERE name = ?').run(Buffer.from('tampered'), 'provider-key');
    database.close();
    const second = await secondAuthority.issue(capabilityRequest('provider-key', { attempt_id: 'attempt-2' }));
    await expect(
      apiFor(secondBroker).handle({
        method: 'GET',
        path: '/vault/secrets/provider-key',
        capability: second,
        confirmation_key_thumbprint: 'confirmation-key-1',
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: 'access_denied' } });
    secondBroker.close();
  });

  it('rejects invalid API dependencies instead of constructing a partially authorized adapter', () => {
    const { broker } = createBroker();
    expect(() => new SecretsBrokerApi(null as never)).toThrow(SecretBrokerError);
    expect(
      () => new SecretsBrokerApi({ broker: null as never, authenticate_session: async () => 'user-1' }),
    ).toThrow(SecretBrokerError);
    expect(
      () => new SecretsBrokerApi({ broker, authenticate_session: null as never }),
    ).toThrow(SecretBrokerError);
    broker.close();
  });

  it('audits denied management access and authenticator failures without leaking request bodies', async () => {
    const { broker } = createBroker();
    const api = new SecretsBrokerApi({
      broker,
      authenticate_session: async (token) => {
        if (token === 'throws') throw new Error('private authenticator failure');
        return token === 'invalid-principal' ? '../invalid' : undefined;
      },
    });
    await api.handle({ method: 'GET', path: '/vault/secrets' });
    await api.handle({ method: 'DELETE', path: '/vault/secrets/key', session_token: 'throws' });
    await api.handle({
      method: 'PUT',
      path: '/vault/secrets/key',
      session_token: 'invalid-principal',
      body: { value: SECRET_VALUE },
    });
    expect(broker.auditEvents).toMatchObject([
      { action: 'list', secret_name: '*', requester: 'anonymous', outcome: 'deny' },
      { action: 'delete', secret_name: 'key', requester: 'anonymous', outcome: 'deny' },
      { action: 'put', secret_name: 'key', requester: 'anonymous', outcome: 'deny' },
    ]);
    expect(JSON.stringify(broker.auditEvents)).not.toContain(SECRET_VALUE);
    broker.close();
  });

  it('persists immutable redacted audits for every allow/deny and purges at the 90-day boundary', async () => {
    let now = Date.parse(NOW);
    const path = temporaryVaultPath();
    const first = createBroker({ path, now: () => new Date(now).toISOString() });
    const api = apiFor(first.broker);
    await api.handle({ method: 'GET', path: '/vault/secrets/private-key' });
    await api.handle({
      method: 'PUT',
      path: '/vault/secrets/private-key',
      session_token: 'valid-session',
      body: { value: SECRET_VALUE },
    });
    const capability = await first.service.issue(capabilityRequest('private-key'));
    await api.handle({
      method: 'GET',
      path: '/vault/secrets/private-key',
      capability,
      confirmation_key_thumbprint: 'confirmation-key-1',
    });
    const audits = first.broker.auditEvents;
    expect(audits.map((event) => event.outcome)).toEqual(['deny', 'grant', 'grant']);
    expect(audits.every((event) => event.timestamp === NOW)).toBe(true);
    expect(audits.every((event) => event.secret_name === 'private-key')).toBe(true);
    expect(audits.some((event) => event.requester === 'single-agent-runtime')).toBe(true);
    expect(Object.isFrozen(audits)).toBe(true);
    expect(Object.isFrozen(audits[0])).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(SECRET_VALUE);
    first.broker.close();

    const second = createBroker({
      path,
      now: () => new Date(now).toISOString(),
      token_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(second.broker.auditEvents).toHaveLength(3);
    now += 90 * 24 * 60 * 60 * 1000 - 1;
    expect(second.broker.purgeExpiredAudit()).toBe(0);
    now += 1;
    expect(second.broker.purgeExpiredAudit()).toBe(3);
    expect(second.broker.auditEvents).toEqual([]);
    second.broker.close();
  });

  it('never includes secret values in thrown errors, API errors, database audit rows, or serialized broker state', async () => {
    const { path, broker, service } = createBroker();
    broker.putSecret('provider-key', Buffer.from(SECRET_VALUE), 'user-1');
    const capability = await service.issue(capabilityRequest('other-key'));
    let thrown: unknown;
    try {
      await broker.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async () => 'must not run',
      });
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify(thrown)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(broker.auditEvents)).not.toContain(SECRET_VALUE);
    const database = new Database(path, { readonly: true });
    expect(JSON.stringify(database.prepare('SELECT * FROM vault_audit').all())).not.toContain(SECRET_VALUE);
    database.close();
    expect(readFileSync(path).includes(Buffer.from(SECRET_VALUE))).toBe(false);
    broker.close();
  });
});
