import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthorizationService,
  FileCapabilityStateStore,
  InMemoryCapabilityStateStore,
  type CapabilityIssueRequest,
} from '../../security/authorization-service.js';
import {
  CapabilityInvalidError,
  CapabilityUsedError,
  canonicalizeCapabilityValue,
  isUuid,
  signCapabilityClaims,
  verifyCapabilityClaims,
} from '../../security/capability.js';

const NOW = '2026-01-01T00:00:00.000Z';
const temporaryDirectories: string[] = [];

function request(): CapabilityIssueRequest {
  return {
    operation_id: 'operation-1',
    attempt_id: 'attempt-1',
    manifest_hash: 'a'.repeat(64),
    policy_decision_hash: 'b'.repeat(64),
    tool_effect_contract_hash: 'c'.repeat(64),
    subject_workload: 'single-agent-runtime',
    tenant_id: 'tenant-1',
    audience: 'harness-tool-host',
    tool_grant_hash: 'd'.repeat(64),
    resource_grant_hash: 'e'.repeat(64),
    budget_ceiling_hash: 'f'.repeat(64),
    execution_epoch: 'epoch-1',
    confirmation_key_thumbprint: 'key-thumbprint-1',
    not_before: NOW,
    expires_at: '2026-01-01T00:01:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('atomic single-use capability consumption', () => {
  it('allows exactly one winner under concurrent replay', async () => {
    const keys = generateKeyPairSync('ed25519');
    const service = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new InMemoryCapabilityStateStore(),
      now: () => NOW,
    });
    const signed = await service.issue(request());

    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () => service.consume(signed)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(31);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(CapabilityUsedError);
    }
    await expect(service.verify(signed)).rejects.toBeInstanceOf(CapabilityUsedError);
  });

  it('persists use across Authorization Service restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ah-capability-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'capabilities.json');
    const keys = generateKeyPairSync('ed25519');
    const first = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new FileCapabilityStateStore(statePath),
      now: () => NOW,
    });
    const signed = await first.issue(request());
    await first.consume(signed);

    const restarted = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new FileCapabilityStateStore(statePath),
      now: () => NOW,
    });
    await expect(restarted.consume(signed)).rejects.toBeInstanceOf(CapabilityUsedError);
  });

  it('serializes concurrent replay across independent service instances sharing durable state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ah-capability-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'capabilities.json');
    const keys = generateKeyPairSync('ed25519');
    const first = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new FileCapabilityStateStore(statePath),
      now: () => NOW,
    });
    const second = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new FileCapabilityStateStore(statePath),
      now: () => NOW,
    });
    const signed = await first.issue(request());

    const results = await Promise.allSettled([first.consume(signed), second.consume(signed)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('fails closed when durable state is corrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ah-capability-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'capabilities.json');
    const store = new FileCapabilityStateStore(statePath);
    await writeFile(statePath, '{not-json', { mode: 0o600 });
    await expect(store.read('11111111-1111-4111-8111-111111111111')).rejects.toThrow(
      /invalid capability state/u,
    );
  });

  it('covers missing, mismatched, duplicate and revoked in-memory state transitions', async () => {
    const store = new InMemoryCapabilityStateStore();
    const tokenId = '11111111-1111-4111-8111-111111111111';
    const record = {
      token_hash: 'a'.repeat(64),
      signature: 'valid_signature',
      status: 'issued' as const,
    };
    await expect(store.read(tokenId)).resolves.toBeUndefined();
    await expect(store.consume(tokenId, record.token_hash)).resolves.toBe('missing');
    await expect(store.revoke(tokenId)).resolves.toBe(false);
    await store.register(tokenId, record);
    await expect(store.register(tokenId, record)).rejects.toBeInstanceOf(CapabilityInvalidError);
    await expect(store.consume(tokenId, 'b'.repeat(64))).resolves.toBe('mismatch');
    await expect(store.revoke(tokenId)).resolves.toBe(true);
    await expect(store.consume(tokenId, record.token_hash)).resolves.toBe('revoked');
    await expect(store.revoke(tokenId)).resolves.toBe(false);
    await expect(store.read(tokenId)).resolves.toEqual({ ...record, status: 'revoked' });
  });

  it('covers durable state transitions, strict imports and lock timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ah-capability-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'capabilities.json');
    const store = new FileCapabilityStateStore(statePath, { lock_timeout_ms: 20 });
    const tokenId = '11111111-1111-4111-8111-111111111111';
    const record = {
      token_hash: 'a'.repeat(64),
      signature: 'valid_signature',
      status: 'issued' as const,
    };

    await expect(store.read(tokenId)).resolves.toBeUndefined();
    await expect(store.consume(tokenId, record.token_hash)).resolves.toBe('missing');
    await store.register(tokenId, record);
    await expect(store.register(tokenId, record)).rejects.toBeInstanceOf(CapabilityInvalidError);
    await expect(store.consume(tokenId, 'b'.repeat(64))).resolves.toBe('mismatch');
    await expect(store.revoke(tokenId)).resolves.toBe(true);
    await expect(store.consume(tokenId, record.token_hash)).resolves.toBe('revoked');
    await expect(store.revoke(tokenId)).resolves.toBe(false);

    const invalidStates = [
      'null',
      '{}',
      '{"version":2,"records":{}}',
      '{"version":1,"records":[]}',
      '{"version":1,"records":{},"extra":true}',
      '{"version":1,"records":{"bad-id":{"token_hash":"' + 'a'.repeat(64) + '","signature":"x","status":"issued"}}}',
      '{"version":1,"records":{"' + tokenId + '":null}}',
      '{"version":1,"records":{"' + tokenId + '":{"token_hash":"bad","signature":"x","status":"issued"}}}',
      '{"version":1,"records":{"' + tokenId + '":{"token_hash":"' + 'a'.repeat(64) + '","signature":"*","status":"issued"}}}',
      '{"version":1,"records":{"' + tokenId + '":{"token_hash":"' + 'a'.repeat(64) + '","signature":"x","status":"invalid"}}}',
    ];
    for (const serialized of invalidStates) {
      await writeFile(statePath, serialized, { mode: 0o600 });
      await expect(store.read(tokenId)).rejects.toBeInstanceOf(CapabilityInvalidError);
    }

    await mkdir(`${statePath}.lock`);
    await expect(store.read(tokenId)).rejects.toThrow(/lock timeout/u);
  });

  it('rejects relative durable paths and invalid lock limits', () => {
    expect(() => new FileCapabilityStateStore('relative.json')).toThrow(CapabilityInvalidError);
    for (const timeout of [0, -1, 1.5]) {
      expect(() => new FileCapabilityStateStore('/tmp/capability.json', { lock_timeout_ms: timeout })).toThrow(
        CapabilityInvalidError,
      );
    }
  });

  it('fails closed when an on-disk state document is corrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ah-capability-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'capabilities.json');
    await writeFile(statePath, '{broken', { mode: 0o600 });
    await expect(new FileCapabilityStateStore(statePath).read('11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(
      CapabilityInvalidError,
    );
  });
});

describe('capability cryptographic and durable-state boundaries', () => {
  it('canonicalizes nested objects while preserving array order and primitives', () => {
    expect(canonicalizeCapabilityValue(null)).toBeNull();
    expect(canonicalizeCapabilityValue('value')).toBe('value');
    expect(canonicalizeCapabilityValue([3, { b: 2, a: 1 }])).toEqual([3, { a: 1, b: 2 }]);
    expect(canonicalizeCapabilityValue({ z: [2, 1], a: { d: 4, c: 3 } })).toEqual({
      a: { c: 3, d: 4 },
      z: [2, 1],
    });
  });

  it('rejects invalid signature alphabet at both anchors and fails closed on verifier exceptions', async () => {
    const keys = generateKeyPairSync('ed25519');
    const service = new AuthorizationService({
      private_key: keys.privateKey,
      public_key: keys.publicKey,
      state_store: new InMemoryCapabilityStateStore(),
      now: () => NOW,
    });
    const signed = await service.issue(request());
    const signature = signCapabilityClaims(signed.claims, keys.privateKey);

    expect(verifyCapabilityClaims(signed.claims, signature, keys.publicKey)).toBe(true);
    expect(verifyCapabilityClaims(signed.claims, `*${signature}`, keys.publicKey)).toBe(false);
    expect(verifyCapabilityClaims(signed.claims, `${signature}*`, keys.publicKey)).toBe(false);
    expect(verifyCapabilityClaims(signed.claims, signature, {} as KeyObject)).toBe(false);
  });

  it('validates UUID anchors, version, and variant bits exactly', () => {
    const valid = '11111111-1111-4111-8111-111111111111';
    expect(isUuid(valid)).toBe(true);
    for (const value of [
      null,
      1,
      `x${valid}`,
      `${valid}x`,
      '11111111-1111-0111-8111-111111111111',
      '11111111-1111-4111-7111-111111111111',
    ]) {
      expect(isUuid(value)).toBe(false);
    }
  });

  it('reports every persisted state-document violation exactly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ah-capability-boundary-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'capabilities.json');
    const store = new FileCapabilityStateStore(statePath);
    const tokenId = '11111111-1111-4111-8111-111111111111';
    const record = {
      token_hash: 'a'.repeat(64),
      signature: 'valid_signature',
      status: 'issued',
    };
    const cases: Array<[unknown, string]> = [
      ['{', 'invalid capability state JSON'],
      [null, 'invalid capability state document'],
      [{ version: 2, records: {} }, 'invalid capability state document'],
      [{ version: 1, records: [] }, 'invalid capability state document'],
      [{ version: 1, records: {}, extra: true }, 'invalid capability state fields'],
      [{ version: 1, records: { 'bad-id': record } }, 'invalid capability state token id'],
      [{ version: 1, records: { [tokenId]: null } }, 'invalid capability state record'],
      [
        { version: 1, records: { [tokenId]: { ...record, extra: true } } },
        'invalid capability state record fields',
      ],
      [
        {
          version: 1,
          records: { [tokenId]: { signature: record.signature, status: record.status } },
        },
        'invalid capability state record fields',
      ],
      [
        { version: 1, records: { [tokenId]: { ...record, token_hash: `${record.token_hash}a` } } },
        'invalid capability state token hash',
      ],
      [
        { version: 1, records: { [tokenId]: { ...record, token_hash: `a${record.token_hash}` } } },
        'invalid capability state token hash',
      ],
      [
        { version: 1, records: { [tokenId]: { ...record, signature: `*${record.signature}` } } },
        'invalid capability state signature',
      ],
      [
        { version: 1, records: { [tokenId]: { ...record, signature: `${record.signature}*` } } },
        'invalid capability state signature',
      ],
      [
        { version: 1, records: { [tokenId]: { ...record, status: 'invalid' } } },
        'invalid capability state status',
      ],
    ];

    for (const [value, message] of cases) {
      await writeFile(statePath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
      await expect(store.read(tokenId)).rejects.toEqual(new CapabilityInvalidError(message));
    }
  });

  it('reports duplicate IDs, invalid paths, lock limits, and lock timeout exactly', async () => {
    const memory = new InMemoryCapabilityStateStore();
    const tokenId = '11111111-1111-4111-8111-111111111111';
    const record = {
      token_hash: 'a'.repeat(64),
      signature: 'valid_signature',
      status: 'issued' as const,
    };
    await memory.register(tokenId, record);
    await expect(memory.register(tokenId, record)).rejects.toEqual(
      new CapabilityInvalidError('duplicate capability token id'),
    );
    expect(() => new FileCapabilityStateStore('relative.json')).toThrow(
      new CapabilityInvalidError('capability state path must be absolute'),
    );
    expect(() => new FileCapabilityStateStore('/tmp/capability.json', { lock_timeout_ms: 0 })).toThrow(
      new CapabilityInvalidError('lock_timeout_ms must be a positive safe integer'),
    );

    const directory = await mkdtemp(join(tmpdir(), 'ah-capability-lock-'));
    temporaryDirectories.push(directory);
    const statePath = join(directory, 'capabilities.json');
    await mkdir(`${statePath}.lock`);
    await expect(
      new FileCapabilityStateStore(statePath, { lock_timeout_ms: 2 }).read(tokenId),
    ).rejects.toEqual(new CapabilityInvalidError('capability state lock timeout'));
  });
});
