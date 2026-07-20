import { generateKeyPairSync } from 'node:crypto';
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
import { CapabilityUsedError } from '../../security/capability.js';
import { CapabilityInvalidError } from '../../security/capability.js';

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
