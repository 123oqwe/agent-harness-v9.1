import {
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  pbkdf2Sync,
} from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

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
  SecretNotFoundError,
  SecretsBroker,
  SecretsBrokerApi,
  secretReadOperation,
} from '../../security/secrets-broker.js';

const NOW = '2026-01-01T00:00:00.000Z';
const PASSWORD = 'correct horse vault password';
const HASHES = {
  manifest: 'a'.repeat(64),
  policy: 'b'.repeat(64),
  effect: 'c'.repeat(64),
  budget: 'f'.repeat(64),
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function vaultPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'harness-secret-boundary-'));
  temporaryDirectories.push(directory);
  return join(directory, 'vault.sqlite');
}

function authority(): AuthorizationService {
  const keys = generateKeyPairSync('ed25519');
  let token = 1;
  return new AuthorizationService({
    private_key: keys.privateKey,
    public_key: keys.publicKey,
    state_store: new InMemoryCapabilityStateStore(),
    now: () => NOW,
    random_uuid: () =>
      `11111111-1111-4111-8111-${String(token++).padStart(12, '0')}`,
  });
}

function capabilityRequest(
  name: string,
  overrides: Partial<CapabilityIssueRequest> = {},
): CapabilityIssueRequest {
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

function broker(
  overrides: Partial<ConstructorParameters<typeof SecretsBroker>[0]> = {},
): SecretsBroker {
  return new SecretsBroker({
    database_path: vaultPath(),
    password: PASSWORD,
    tenant_id: 'tenant-1',
    authorization_service: authority(),
    now: () => NOW,
    ...overrides,
  });
}

function decrypt(
  key: Buffer,
  row: { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer },
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, row.nonce, {
    authTagLength: 16,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
}

describe('SecretsBroker public input boundaries', () => {
  it('preserves exact public error identities and redacted messages', () => {
    expect(new SecretBrokerError()).toMatchObject({
      name: 'SecretBrokerError',
      message: 'secret broker request failed',
    });
    expect(new SecretAccessDeniedError()).toMatchObject({
      name: 'SecretAccessDeniedError',
      message: 'secret access denied',
    });
    expect(new SecretNotFoundError()).toMatchObject({
      name: 'SecretNotFoundError',
      message: 'secret not found',
    });
    expect(new SecretIntegrityError()).toMatchObject({
      name: 'SecretIntegrityError',
      message: 'secret integrity verification failed',
    });
  });

  it('accepts exact secret-name boundaries and rejects each malformed shape', () => {
    const maximum = `A${'a'.repeat(123)}._-9`;
    expect(maximum).toHaveLength(128);
    for (const name of ['A', 'A._-9', maximum]) {
      expect(secretReadOperation(name)).toBe(
        `vault.secret.read:${createHash('sha256').update(name).digest('hex')}`,
      );
    }
    for (const name of [
      undefined,
      1,
      '',
      '_name',
      '*name',
      'name*',
      'name@domain',
      `${'a'.repeat(128)}*`,
    ]) {
      expect(() => secretReadOperation(name as never)).toThrow(
        expect.objectContaining({
          name: 'SecretBrokerError',
          message: 'invalid secret name',
        }),
      );
    }
  });

  it('accepts exact requester boundaries and rejects invalid prefixes, suffixes, characters, and lengths', () => {
    const value = broker();
    const maximum = `A${'a'.repeat(251)}._:@`;
    expect(maximum).toHaveLength(256);
    expect(value.listSecrets('A')).toEqual([]);
    expect(value.listSecrets(maximum)).toEqual([]);
    for (const requester of [
      '',
      '_user',
      '*user',
      'user*',
      'user#domain',
      `${'a'.repeat(256)}*`,
    ]) {
      expect(() => value.listSecrets(requester)).toThrow(
        expect.objectContaining({
          name: 'SecretBrokerError',
          message: 'invalid requester',
        }),
      );
    }
    value.close();
  });

  it('rejects every invalid entropy shape and accepts an exact nonzero boundary buffer', () => {
    for (const first of [
      'not-bytes',
      new Uint8Array(),
      new Uint8Array(15).fill(1),
      new Uint8Array(17).fill(1),
      new Uint8Array(16),
    ]) {
      expect(() =>
        broker({
          random_bytes: ((length: number) =>
            first instanceof Uint8Array ? first : first) as never,
        }),
      ).toThrow(
        expect.objectContaining({
          name: 'SecretBrokerError',
          message: 'invalid vault entropy',
        }),
      );
    }

    let call = 0;
    const accepted = broker({
      random_bytes: (length) => {
        call += 1;
        const value = new Uint8Array(length);
        value[value.length - 1] = call;
        return value;
      },
    });
    accepted.close();
  });

  it('rejects each malformed constructor dependency with its exact redacted error', () => {
    expect(() => new SecretsBroker(null as never)).toThrow(
      expect.objectContaining({ name: 'SecretBrokerError', message: 'invalid secret broker options' }),
    );
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ database_path: 'relative.sqlite' }, 'vault database path must be absolute'],
      [{ password: undefined }, 'invalid vault password'],
      [{ password: '' }, 'invalid vault password'],
      [{ password: 'x'.repeat(1025) }, 'invalid vault password'],
      [{ tenant_id: undefined }, 'invalid vault tenant'],
      [{ tenant_id: '_tenant' }, 'invalid vault tenant'],
      [{ tenant_id: 'tenant*' }, 'invalid vault tenant'],
      [{ authorization_service: null }, 'authorization service is required'],
      [{ now: 'not-a-function' }, 'now must be a function'],
      [{ random_bytes: 'not-a-function' }, 'random_bytes must be a function'],
      [{ now: () => 'not-an-instant' }, 'clock returned an invalid timestamp'],
    ];
    for (const [overrides, message] of cases) {
      expect(() => broker(overrides as never)).toThrow(
        expect.objectContaining({ name: 'SecretBrokerError', message }),
      );
    }
  });

  it('distinguishes symlinks, empty files, non-vault SQLite files, and corrupt files', () => {
    const target = vaultPath();
    const created = broker({ database_path: target });
    created.close();
    const alias = `${target}.alias`;
    symlinkSync(target, alias);
    expect(() => broker({ database_path: alias })).toThrow(
      expect.objectContaining({
        name: 'SecretBrokerError',
        message: 'vault database symlinks are forbidden',
      }),
    );

    const emptyPath = vaultPath();
    writeFileSync(emptyPath, '');
    const initialized = broker({ database_path: emptyPath });
    initialized.close();

    const nonVaultPath = vaultPath();
    const nonVault = new Database(nonVaultPath);
    nonVault.exec('CREATE TABLE unrelated(value TEXT)');
    nonVault.close();
    expect(() => broker({ database_path: nonVaultPath })).toThrow(
      expect.objectContaining({
        name: 'SecretAccessDeniedError',
        message: 'vault unlock failed',
      }),
    );

    const corruptPath = vaultPath();
    writeFileSync(corruptPath, 'not a SQLite database');
    expect(() => broker({ database_path: corruptPath })).toThrow(
      expect.objectContaining({
        name: 'SecretBrokerError',
        message: 'vault initialization failed',
      }),
    );
  });

  it('records exact management receipts for put, list, delete, denial, and close', () => {
    const value = broker();
    value.putSecret('beta', Buffer.from('two'), 'user-1');
    value.putSecret('alpha', Buffer.from('one'), 'user-1');
    expect(value.listSecrets('user-1')).toEqual(['alpha', 'beta']);
    expect(Object.isFrozen(value.listSecrets('user-1'))).toBe(true);
    expect(value.deleteSecret('missing', 'user-1')).toBe(false);
    expect(value.deleteSecret('alpha', 'user-1')).toBe(true);
    expect(() => value.putSecret('invalid-value', new Uint8Array(), 'user-1')).toThrow(
      expect.objectContaining({ name: 'SecretBrokerError', message: 'invalid secret value' }),
    );
    expect(value.auditEvents).toEqual([
      { timestamp: NOW, action: 'put', secret_name: 'beta', requester: 'user-1', outcome: 'grant', reason_code: 'stored' },
      { timestamp: NOW, action: 'put', secret_name: 'alpha', requester: 'user-1', outcome: 'grant', reason_code: 'stored' },
      { timestamp: NOW, action: 'list', secret_name: '*', requester: 'user-1', outcome: 'grant', reason_code: 'listed' },
      { timestamp: NOW, action: 'list', secret_name: '*', requester: 'user-1', outcome: 'grant', reason_code: 'listed' },
      { timestamp: NOW, action: 'delete', secret_name: 'missing', requester: 'user-1', outcome: 'deny', reason_code: 'not_found' },
      { timestamp: NOW, action: 'delete', secret_name: 'alpha', requester: 'user-1', outcome: 'grant', reason_code: 'deleted' },
      { timestamp: NOW, action: 'put', secret_name: 'invalid-value', requester: 'user-1', outcome: 'deny', reason_code: 'invalid_secret_value' },
    ]);
    expect(Object.isFrozen(value.auditEvents)).toBe(true);
    expect(Object.isFrozen(value.auditEvents[0])).toBe(true);
    value.close();
    value.close();
    expect(() => value.listSecrets('user-1')).toThrow(
      expect.objectContaining({ name: 'SecretBrokerError', message: 'secret broker is closed' }),
    );
  });

  it('tries exactly four nonce candidates and reports entropy failures precisely', () => {
    let call = 0;
    const colliding = broker({
      random_bytes: (length) => {
        call += 1;
        if (call === 1) return new Uint8Array(length).fill(1);
        if (call <= 6) return new Uint8Array(length).fill(2);
        return new Uint8Array(length).fill(3);
      },
    });
    expect(() => colliding.putSecret('key', Buffer.from('value'), 'user-1')).toThrow(
      expect.objectContaining({
        name: 'SecretBrokerError',
        message: 'unable to generate a unique nonce',
      }),
    );
    expect(call).toBe(6);
    colliding.close();

    let entropyCall = 0;
    const invalidOnPut = broker({
      random_bytes: (length) => {
        entropyCall += 1;
        return entropyCall < 3
          ? new Uint8Array(length).fill(entropyCall)
          : new Uint8Array(length);
      },
    });
    expect(() => invalidOnPut.putSecret('key', Buffer.from('value'), 'user-1')).toThrow(
      expect.objectContaining({ name: 'SecretBrokerError', message: 'invalid vault entropy' }),
    );
    invalidOnPut.close();
  });
});

describe('SecretsBroker dispatch and API receipts', () => {
  it('records exact success, scope mismatch, and authority rejection receipts', async () => {
    const auth = authority();
    const value = broker({ authorization_service: auth });
    value.putSecret('provider-key', Buffer.from('provider-secret'), 'user-1');
    const success = await auth.issue(capabilityRequest('provider-key'));
    await expect(
      value.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability: success,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async (secret) => Buffer.from(secret).toString(),
      }),
    ).resolves.toBe('provider-secret');

    const wrongScope = await auth.issue(
      capabilityRequest('provider-key', {
        attempt_id: 'attempt-2',
        audience: 'wrong-audience',
      }),
    );
    await expect(
      value.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability: wrongScope,
        confirmation_key_thumbprint: 'confirmation-key-1',
        dispatch: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(SecretAccessDeniedError);

    const rejected = await auth.issue(
      capabilityRequest('provider-key', { attempt_id: 'attempt-3' }),
    );
    await expect(
      value.dispatchWithSecret({
        name: 'provider-key',
        requester: 'single-agent-runtime',
        capability: rejected,
        confirmation_key_thumbprint: 'wrong-key',
        dispatch: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(SecretAccessDeniedError);
    expect(value.auditEvents).toEqual([
      { timestamp: NOW, action: 'put', secret_name: 'provider-key', requester: 'user-1', outcome: 'grant', reason_code: 'stored' },
      { timestamp: NOW, action: 'get', secret_name: 'provider-key', requester: 'single-agent-runtime', outcome: 'grant', reason_code: 'exchanged' },
      { timestamp: NOW, action: 'get', secret_name: 'provider-key', requester: 'single-agent-runtime', outcome: 'deny', reason_code: 'capability_scope_mismatch' },
      { timestamp: NOW, action: 'get', secret_name: 'provider-key', requester: 'single-agent-runtime', outcome: 'deny', reason_code: 'capability_rejected' },
    ]);
    value.close();
  });

  it('maps malformed, unauthorized, missing, and unexpected API failures exactly', async () => {
    const value = broker();
    const api = new SecretsBrokerApi({
      broker: value,
      authenticate_session: async (token) => {
        if (token === 'throws') throw new Error('private failure');
        if (token === 'valid') return 'user-1';
        if (token === 'invalid-principal') return '../invalid';
        return undefined;
      },
    });
    await expect(api.handle(null as never)).resolves.toEqual({
      status: 400,
      headers: {},
      body: { error: 'invalid_request' },
    });
    await expect(api.handle({ method: 'GET', path: '/vault/secrets', session_token: 'throws' })).resolves.toEqual({
      status: 401,
      headers: {},
      body: { error: 'authentication_required' },
    });
    await expect(
      api.handle({
        method: 'PUT',
        path: '/vault/secrets/key',
        session_token: 'valid',
        body: { extra: 'x', value: 'secret' },
      }),
    ).resolves.toEqual({
      status: 400,
      headers: {},
      body: { error: 'invalid_request' },
    });
    await expect(
      api.handle({ method: 'DELETE', path: '/vault/secrets/missing', session_token: 'valid' }),
    ).resolves.toEqual({
      status: 404,
      headers: {},
      body: { error: 'secret_not_found' },
    });
    await expect(
      api.handle({ method: 'GET', path: '/vault/secrets/%2Fescape', session_token: 'valid' }),
    ).resolves.toEqual({
      status: 400,
      headers: {},
      body: { error: 'invalid_request' },
    });
    expect(value.auditEvents).toEqual([
      { timestamp: NOW, action: 'list', secret_name: '*', requester: 'anonymous', outcome: 'deny', reason_code: 'authentication_required' },
      { timestamp: NOW, action: 'put', secret_name: 'key', requester: 'user-1', outcome: 'deny', reason_code: 'invalid_request' },
      { timestamp: NOW, action: 'delete', secret_name: 'missing', requester: 'user-1', outcome: 'deny', reason_code: 'not_found' },
    ]);

    (value as unknown as { listSecrets: () => never }).listSecrets = () => {
      throw new Error('unexpected database fault');
    };
    await expect(api.handle({ method: 'GET', path: '/vault/secrets', session_token: 'valid' })).resolves.toEqual({
      status: 500,
      headers: {},
      body: { error: 'vault_unavailable' },
    });
    value.close();
  });
});

describe('SecretsBroker cryptographic format anchors', () => {
  it('binds the fixed key check and each secret name/version into AES-GCM AAD', () => {
    let sequence = 0;
    const path = vaultPath();
    const value = broker({
      database_path: path,
      random_bytes: (length) => new Uint8Array(length).fill(++sequence),
    });
    value.putSecret('provider-key', Buffer.from('provider-secret'), 'user-1');

    const database = new Database(path, { readonly: true });
    const metadata = Object.fromEntries(
      database.prepare('SELECT key, value FROM vault_metadata').all().map((entry) => {
        const row = entry as { key: string; value: Buffer };
        return [row.key, row.value];
      }),
    ) as Record<string, Buffer>;
    const key = pbkdf2Sync(PASSWORD, metadata.kdf_salt!, 100_000, 32, 'sha256');
    const keyCheck = decrypt(
      key,
      {
        nonce: metadata.key_check_nonce!,
        ciphertext: metadata.key_check_ciphertext!,
        auth_tag: metadata.key_check_auth_tag!,
      },
      Buffer.from('agent-harness:vault:key-check:v1'),
    );
    expect(keyCheck.toString()).toBe('agent-harness-vault-key-check-v1');

    const encrypted = database
      .prepare('SELECT nonce, ciphertext, auth_tag FROM vault_secrets WHERE name = ?')
      .get('provider-key') as { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
    const plaintext = decrypt(
      key,
      encrypted,
      Buffer.from(JSON.stringify({ name: 'provider-key', version: 1 })),
    );
    expect(plaintext.toString()).toBe('provider-secret');

    plaintext.fill(0);
    keyCheck.fill(0);
    key.fill(0);
    database.close();
    value.close();
  });
});
