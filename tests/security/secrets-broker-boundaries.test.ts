import {
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  pbkdf2Sync,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthorizationService,
  InMemoryCapabilityStateStore,
} from '../../security/authorization-service.js';
import {
  SecretAccessDeniedError,
  SecretBrokerError,
  SecretIntegrityError,
  SecretNotFoundError,
  SecretsBroker,
  secretReadOperation,
} from '../../security/secrets-broker.js';

const NOW = '2026-01-01T00:00:00.000Z';
const PASSWORD = 'correct horse vault password';
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
  return new AuthorizationService({
    private_key: keys.privateKey,
    public_key: keys.publicKey,
    state_store: new InMemoryCapabilityStateStore(),
    now: () => NOW,
    random_uuid: () => '11111111-1111-4111-8111-111111111111',
  });
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
