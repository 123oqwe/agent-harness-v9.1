import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDurableHookSystem,
  SqliteHookJournal,
  type HookDispatchOutcome,
  type HookJournalClaim,
  type HookJournalRecord,
  type HookScope,
} from '../../../packages/runtime-core/src/index.js';

const roots: string[] = [];
const masterKey = Buffer.alloc(32, 0x42);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-hook-journal-'));
  roots.push(root);
  return join(root, 'hooks.sqlite');
};

const scope = (
  tenantId = 'tenant-a',
  runId = 'run-a',
  sessionId = 'session-a',
): HookScope => ({
  tenant_id: tenantId,
  run_id: runId,
  session_id: sessionId,
  operation_id: 'operation-a',
  attempt_id: 'attempt-a',
});

const claimInput = (idempotencyKey: string, hookScope = scope()) => ({
  scope: hookScope,
  idempotency_key: idempotencyKey,
  event: 'pre_tool_use' as const,
  input_hash: createHash('sha256').update(idempotencyKey).digest('hex'),
});

const outcome = (secret: string): HookDispatchOutcome => ({
  event: 'pre_tool_use',
  action: 'continue',
  payload: { secret },
  follow_ups: [],
  replayed: false,
});

const record = (
  input: ReturnType<typeof claimInput>,
  secret: string,
): HookJournalRecord => ({
  scope: input.scope,
  idempotency_key: input.idempotency_key,
  event: input.event,
  input_hash: input.input_hash,
  outcome: outcome(secret),
});

const claimedToken = (claim: HookJournalClaim): string => {
  expect(claim.status).toBe('claimed');
  if (claim.status !== 'claimed') throw new Error('claim was not acquired');
  return claim.claim_token;
};

describe('AH-HOOK-001 encrypted SQLite HookJournal', () => {
  it('provides a durable default composition instead of an in-memory journal', async () => {
    const path = fixture();
    const runtime = createDurableHookSystem({
      databasePath: path,
      masterKey,
      ownerId: 'default-composition',
      leaseMs: 1_000,
      registrations: [
        {
          id: 'managed-default',
          event: 'pre_tool_use',
          trust: 'managed',
          priority: 1,
          timeout_ms: 100,
          handler: { handle: async () => ({ action: 'continue' }) },
        },
      ],
    });
    const input = {
      event: 'pre_tool_use' as const,
      invocation_id: 'default-invocation',
      idempotency_key: 'default-idempotency',
      scope: scope(),
      payload: { value: 'sensitive' },
    };

    await expect(runtime.hooks.dispatch(input)).resolves.toMatchObject({
      replayed: false,
    });
    runtime.close();

    const restarted = createDurableHookSystem({
      databasePath: path,
      masterKey,
      ownerId: 'default-composition-restart',
      leaseMs: 1_000,
      registrations: [],
    });
    await expect(restarted.hooks.dispatch(input)).resolves.toMatchObject({
      replayed: true,
    });
    restarted.close();
  });

  it('wires every optional durable Hook port into the existing authorities', async () => {
    const auditEntries: unknown[] = [];
    const audit = {
      record: vi.fn(async (entry) => {
        auditEntries.push(entry);
      }),
    };
    const attenuationPolicy = {
      validate: vi.fn(() => ({ allowed: true as const })),
    };
    const executionPort = {
      execute: vi.fn(async () => ({
        action: 'observe' as const,
        follow_up: { source: 'wired-execution-port' },
      })),
    };
    const monotonicValues = [10, 12, 20, 25];
    const runtime = createDurableHookSystem({
      databasePath: fixture(),
      masterKey,
      ownerId: 'all-options-composition',
      leaseMs: 1_000,
      nowMs: () => 0,
      now: () => '2026-08-03T00:00:00.000Z',
      monotonicNow: () => monotonicValues.shift() ?? 25,
      audit,
      attenuationPolicy,
      executionPort,
      registrations: [
        {
          id: 'managed-attenuation',
          event: 'pre_tool_use',
          trust: 'managed',
          priority: 1,
          timeout_ms: 100,
          handler: {
            handle: async () => ({
              action: 'attenuate' as const,
              payload: { permitted: true },
            }),
          },
        },
        {
          id: 'reviewed-observer',
          event: 'post_tool_use',
          trust: 'hash_reviewed',
          priority: 2,
          timeout_ms: 100,
          content_hash: 'a'.repeat(64),
          execution: {
            executable_path: '/usr/bin/node',
            argv: ['/tmp/reviewed-hook.mjs'],
            source_path: '/tmp/reviewed-hook.mjs',
          },
        },
      ],
    });

    await expect(
      runtime.hooks.dispatch({
        event: 'pre_tool_use',
        invocation_id: 'all-options-attenuation',
        idempotency_key: 'all-options-attenuation-key',
        scope: scope(),
        payload: { permitted: true, excessive: true },
      }),
    ).resolves.toMatchObject({
      action: 'continue',
      payload: { permitted: true },
    });
    await expect(
      runtime.hooks.dispatch({
        event: 'post_tool_use',
        invocation_id: 'all-options-observer',
        idempotency_key: 'all-options-observer-key',
        scope: scope(),
        payload: { result: 'ok' },
      }),
    ).resolves.toMatchObject({
      action: 'continue',
      follow_ups: [{ source: 'wired-execution-port' }],
    });

    expect(attenuationPolicy.validate).toHaveBeenCalledOnce();
    expect(executionPort.execute).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(auditEntries).toMatchObject([
      {
        hook_id: 'managed-attenuation',
        outcome: 'attenuated',
        timestamp: '2026-08-03T00:00:00.000Z',
        duration_ms: 2,
      },
      {
        hook_id: 'reviewed-observer',
        outcome: 'observed',
        timestamp: '2026-08-03T00:00:00.000Z',
        duration_ms: 5,
      },
    ]);
    runtime.close();
    await expect(runtime.journal.claim(claimInput('after-close'))).rejects.toThrow(
      'Hook journal is closed',
    );
  });

  it('atomically commits and replays within tenant/run/session scope', async () => {
    const path = fixture();
    const first = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-a',
      leaseMs: 1_000,
    });
    const input = claimInput('idempotency-a');
    const token = claimedToken(await first.claim(input));
    await first.commit(token, record(input, 'sensitive-payload'));
    first.close();

    const restarted = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-b',
      leaseMs: 1_000,
    });
    await expect(restarted.claim(input)).resolves.toMatchObject({
      status: 'replay',
      record: {
        scope: input.scope,
        outcome: { payload: { secret: 'sensitive-payload' } },
      },
    });
    restarted.close();

    const raw = new Database(path, { readonly: true });
    const row = raw
      .prepare(
        'SELECT outcome_ciphertext FROM hook_journal WHERE idempotency_key = ?',
      )
      .get(input.idempotency_key) as { outcome_ciphertext: string };
    expect(row.outcome_ciphertext).toMatch(/^ahenc:v1:/u);
    expect(row.outcome_ciphertext).not.toContain('sensitive-payload');
    raw.close();
  });

  it('binds persisted key metadata to the canonical derivation contexts', () => {
    const path = fixture();
    new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'derivation-reference',
      leaseMs: 1_000,
    }).close();
    const raw = new Database(path, { readonly: true });
    const metadata = Object.fromEntries(
      (
        raw
          .prepare('SELECT key, value FROM hook_journal_metadata ORDER BY key')
          .all() as Array<{ key: string; value: string }>
      ).map(({ key, value }) => [key, value]),
    );
    raw.close();
    const salt = Buffer.from(metadata.encryption_salt!, 'base64');
    const recordKey = Buffer.from(
      hkdfSync(
        'sha256',
        masterKey,
        salt,
        'agent-harness/hook-journal/v1',
        32,
      ),
    );
    const expectedKeyCheck = createHmac('sha256', recordKey)
      .update('agent-harness/hook-journal/key-check/v1')
      .digest('hex');
    expect(metadata.encryption_key_check).toBe(expectedKeyCheck);
    recordKey.fill(0);
    salt.fill(0);
  });

  it('isolates identical idempotency keys across tenants', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-a',
      leaseMs: 1_000,
    });
    const tenantA = claimInput('same-key', scope('tenant-a'));
    const tenantB = claimInput('same-key', scope('tenant-b'));

    expect((await journal.claim(tenantA)).status).toBe('claimed');
    expect((await journal.claim(tenantB)).status).toBe('claimed');
    journal.close();
  });

  it('fails closed on an active claim from an independent SQLite connection', async () => {
    const path = fixture();
    let now = 1_000;
    const first = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-a',
      leaseMs: 1_000,
      nowMs: () => now,
    });
    const second = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-b',
      leaseMs: 1_000,
      nowMs: () => now,
    });
    const input = claimInput('contended-key');

    expect((await first.claim(input)).status).toBe('claimed');
    await expect(second.claim(input)).resolves.toMatchObject({
      status: 'reconciliation',
      reason_code: 'hook_claim_in_flight',
    });
    now = 2_000;
    await expect(second.claim(input)).resolves.toMatchObject({
      status: 'reconciliation',
      reason_code: 'hook_claim_abandoned',
    });
    first.close();
    second.close();
  });

  it('detects an uncommitted claim created by a separate process', async () => {
    const path = fixture();
    const initialized = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'initializer',
      leaseMs: 1_000,
      nowMs: () => 1_000,
    });
    initialized.close();
    const input = claimInput('cross-process-key');
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `const Database=require('better-sqlite3');
const db=new Database(process.argv[1]);
const input=JSON.parse(process.argv[2]);
db.prepare(\`INSERT INTO hook_journal (
 tenant_id,run_id,session_id,operation_id,attempt_id,idempotency_key,event,
 input_hash,state,owner_id,claim_token_hash,lease_expires_at_ms,
 outcome_ciphertext,created_at_ms,updated_at_ms
) VALUES (?,?,?,?,?,?,?,?,'CLAIMED',?,?,?,NULL,?,?)\`).run(
 input.scope.tenant_id,input.scope.run_id,input.scope.session_id,
 input.scope.operation_id,input.scope.attempt_id,input.idempotency_key,
 input.event,input.input_hash,'child-process','${'b'.repeat(64)}',2000,1000,1000);
db.close();`,
        path,
        JSON.stringify(input),
      ],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(0);

    const parent = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'parent-process',
      leaseMs: 1_000,
      nowMs: () => 1_000,
    });
    await expect(parent.claim(input)).resolves.toMatchObject({
      status: 'reconciliation',
      reason_code: 'hook_claim_in_flight',
    });
    parent.close();
  });

  it('does not blindly replay an uncommitted claim after restart', async () => {
    const path = fixture();
    let now = 10;
    const beforeCrash = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'crashed-process',
      leaseMs: 10,
      nowMs: () => now,
    });
    const input = claimInput('crash-key');
    expect((await beforeCrash.claim(input)).status).toBe('claimed');
    beforeCrash.close();

    now = 21;
    const restarted = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'replacement-process',
      leaseMs: 10,
      nowMs: () => now,
    });
    await expect(restarted.claim(input)).resolves.toMatchObject({
      status: 'reconciliation',
      reason_code: 'hook_claim_abandoned',
    });
    restarted.close();
  });

  it('durably reconciles instead of re-executing after post-handler audit failure', async () => {
    const path = fixture();
    let executions = 0;
    const registration = {
      id: 'post-handler-audit-failure',
      event: 'pre_tool_use' as const,
      trust: 'managed' as const,
      priority: 1,
      timeout_ms: 100,
      handler: {
        handle: async () => {
          executions += 1;
          return { action: 'continue' as const };
        },
      },
    };
    const input = {
      event: 'pre_tool_use' as const,
      invocation_id: 'audit-failure-invocation',
      idempotency_key: 'audit-failure-idempotency',
      scope: scope(),
      payload: { value: 'must-run-once' },
    };
    const first = createDurableHookSystem({
      databasePath: path,
      masterKey,
      ownerId: 'audit-failure-first',
      leaseMs: 1_000,
      registrations: [registration],
      audit: {
        record: async () => {
          throw new Error('audit persistence failed');
        },
      },
    });

    await expect(first.hooks.dispatch(input)).rejects.toThrow(
      'audit persistence failed',
    );
    first.close();

    const restarted = createDurableHookSystem({
      databasePath: path,
      masterKey,
      ownerId: 'audit-failure-restart',
      leaseMs: 1_000,
      registrations: [registration],
    });
    await expect(restarted.hooks.dispatch(input)).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_claim_abandoned',
      replayed: false,
    });
    expect(executions).toBe(1);
    restarted.close();
  });

  it('allows a definitely-uncommitted released claim to be acquired again', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-a',
      leaseMs: 1_000,
    });
    const input = claimInput('released-key');
    const token = claimedToken(await journal.claim(input));
    await journal.release(token);

    expect((await journal.claim(input)).status).toBe('claimed');
    journal.close();
  });

  it('authenticates ciphertext against its exact tenant/run/session row', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-a',
      leaseMs: 1_000,
    });
    const firstInput = claimInput(
      'row-a',
      scope('tenant-a', 'run-a', 'session-a'),
    );
    const secondInput = claimInput(
      'row-b',
      scope('tenant-a', 'run-b', 'session-b'),
    );
    await journal.commit(
      claimedToken(await journal.claim(firstInput)),
      record(firstInput, 'secret-a'),
    );
    await journal.commit(
      claimedToken(await journal.claim(secondInput)),
      record(secondInput, 'secret-b'),
    );
    journal.close();

    const raw = new Database(path);
    const rows = raw
      .prepare(
        'SELECT idempotency_key, outcome_ciphertext FROM hook_journal ORDER BY idempotency_key',
      )
      .all() as Array<{ idempotency_key: string; outcome_ciphertext: string }>;
    raw
      .prepare(
        'UPDATE hook_journal SET outcome_ciphertext = ? WHERE idempotency_key = ?',
      )
      .run(rows[1]!.outcome_ciphertext, rows[0]!.idempotency_key);
    raw.close();

    const reopened = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-b',
      leaseMs: 1_000,
    });
    await expect(reopened.claim(firstInput)).rejects.toThrow(
      'hook journal authentication failed',
    );
    reopened.close();
  });

  it('rejects ciphertext tampering instead of returning attacker-controlled payload', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-a',
      leaseMs: 1_000,
    });
    const input = claimInput('tamper-key');
    await journal.commit(
      claimedToken(await journal.claim(input)),
      record(input, 'secret-a'),
    );
    journal.close();

    const raw = new Database(path);
    const stored = raw
      .prepare(
        'SELECT outcome_ciphertext FROM hook_journal WHERE idempotency_key = ?',
      )
      .get(input.idempotency_key) as { outcome_ciphertext: string };
    const envelope = stored.outcome_ciphertext.split(':');
    const ciphertext = envelope[4]!;
    envelope[4] = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;
    raw
      .prepare(
        'UPDATE hook_journal SET outcome_ciphertext = ? WHERE idempotency_key = ?',
      )
      .run(envelope.join(':'), input.idempotency_key);
    raw.close();

    const reopened = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'process-b',
      leaseMs: 1_000,
    });
    await expect(reopened.claim(input)).rejects.toThrow(
      'hook journal authentication failed',
    );
    reopened.close();
  });

  it('rejects the wrong master key before changing an established journal', () => {
    const path = fixture();
    const initialized = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'initializer',
      leaseMs: 1_000,
    });
    initialized.close();

    const before = new Database(path, { readonly: true });
    const beforeRows = before
      .prepare('SELECT key, value FROM hook_journal_metadata ORDER BY key')
      .all();
    before.close();

    expect(
      () =>
        new SqliteHookJournal(path, {
          masterKey: Buffer.alloc(32, 0x24),
          ownerId: 'wrong-key-process',
          leaseMs: 1_000,
        }),
    ).toThrow('Hook journal master key rejected');

    const after = new Database(path, { readonly: true });
    expect(
      after
        .prepare('SELECT key, value FROM hook_journal_metadata ORDER BY key')
        .all(),
    ).toEqual(beforeRows);
    expect(
      after.prepare('SELECT COUNT(*) AS count FROM hook_journal').get(),
    ).toEqual({ count: 0 });
    after.close();
  });

  it('rejects a key-check digest with trailing attacker-controlled hex', () => {
    const path = fixture();
    new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'key-check-anchor-writer',
      leaseMs: 1_000,
    }).close();
    const raw = new Database(path);
    raw
      .prepare(
        "UPDATE hook_journal_metadata SET value = value || 'a' WHERE key = 'encryption_key_check'",
      )
      .run();
    raw.close();
    expect(
      () =>
        new SqliteHookJournal(path, {
          masterKey,
          ownerId: 'key-check-anchor-reader',
          leaseMs: 1_000,
        }),
    ).toThrow('Hook journal master key rejected');
  });

  it('validates constructor identity, key length and lease before use', () => {
    for (const [options, message] of [
      [undefined, 'ownerId is required'],
      [{ masterKey, ownerId: '', leaseMs: 1_000 }, 'ownerId is required'],
      [{ masterKey, ownerId: '   ', leaseMs: 1_000 }, 'ownerId is required'],
      [
        { masterKey: Buffer.alloc(31), ownerId: 'owner', leaseMs: 1_000 },
        '32-byte Hook journal masterKey is required',
      ],
      [
        { masterKey: Buffer.alloc(33), ownerId: 'owner', leaseMs: 1_000 },
        '32-byte Hook journal masterKey is required',
      ],
      [
        { masterKey: undefined, ownerId: 'owner', leaseMs: 1_000 },
        '32-byte Hook journal masterKey is required',
      ],
      [
        { masterKey, ownerId: 'owner', leaseMs: 0 },
        'Hook journal leaseMs must be a positive safe integer',
      ],
      [
        { masterKey, ownerId: 'owner', leaseMs: 1.5 },
        'Hook journal leaseMs must be a positive safe integer',
      ],
    ] as const) {
      expect(() => new SqliteHookJournal(fixture(), options as never)).toThrow(
        message,
      );
    }
    expect(
      () =>
        new SqliteHookJournal('', {
          masterKey,
          ownerId: 'owner',
          leaseMs: 1_000,
        }),
    ).toThrow('databasePath is required');
  });

  it('rejects malformed claim input before creating a row', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'validator',
      leaseMs: 1_000,
    });
    const valid = claimInput('validation-key');
    const invalid: Array<[unknown, string]> = [
      [{ ...valid, scope: null }, 'tenant_id is required'],
      [{ ...valid, scope: { ...scope(), tenant_id: '' } }, 'tenant_id is required'],
      [{ ...valid, scope: { ...scope(), tenant_id: '   ' } }, 'tenant_id is required'],
      [{ ...valid, scope: { ...scope(), run_id: '' } }, 'run_id is required'],
      [{ ...valid, scope: { ...scope(), session_id: '' } }, 'session_id is required'],
      [{ ...valid, scope: { ...scope(), operation_id: '' } }, 'operation_id is required'],
      [{ ...valid, scope: { ...scope(), attempt_id: '' } }, 'attempt_id is required'],
      [{ ...valid, idempotency_key: '' }, 'idempotency_key is required'],
      [{ ...valid, event: 'unknown' }, 'unknown Hook event'],
      [{ ...valid, input_hash: '' }, 'Hook journal input_hash must be SHA-256'],
      [
        { ...valid, input_hash: `g${'0'.repeat(63)}` },
        'Hook journal input_hash must be SHA-256',
      ],
      [
        { ...valid, input_hash: `${'a'.repeat(64)}a` },
        'Hook journal input_hash must be SHA-256',
      ],
      [
        { ...valid, input_hash: `a${'b'.repeat(64)}` },
        'Hook journal input_hash must be SHA-256',
      ],
    ];
    for (const [input, message] of invalid) {
      await expect(journal.claim(input as never)).rejects.toThrow(message);
    }
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM hook_journal').get()).toEqual({
      count: 0,
    });
    raw.close();
    journal.close();
  });

  it('accepts an exact required-only scope and replays without optional keys', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'required-scope-owner',
      leaseMs: 1_000,
      nowMs: () => 0,
    });
    const requiredScope: HookScope = {
      tenant_id: 'tenant-required',
      run_id: 'run-required',
      session_id: 'session-required',
    };
    const input = claimInput('required-scope', requiredScope);
    await journal.commit(
      claimedToken(await journal.claim(input)),
      record(input, 'required-secret'),
    );
    const replay = await journal.claim(input);
    expect(replay.status).toBe('replay');
    if (replay.status !== 'replay') throw new Error('expected replay');
    expect(replay.record.scope).toEqual(requiredScope);
    expect(Object.keys(replay.record.scope).sort()).toEqual([
      'run_id',
      'session_id',
      'tenant_id',
    ]);
    journal.close();
  });

  it('binds a claim to optional scope, event and input hash identity', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'identity-owner',
      leaseMs: 1_000,
    });
    const changes: Array<(input: ReturnType<typeof claimInput>) => typeof input> = [
      (input) => ({ ...input, scope: { ...input.scope, operation_id: 'other' } }),
      (input) => ({ ...input, scope: { ...input.scope, attempt_id: 'other' } }),
      (input) => ({ ...input, event: 'post_tool_use' as never }),
      (input) => ({ ...input, input_hash: 'a'.repeat(64) }),
    ];
    for (const [index, change] of changes.entries()) {
      const input = claimInput(`identity-${index}`);
      expect((await journal.claim(input)).status).toBe('claimed');
      await expect(journal.claim(change(input))).rejects.toThrow(
        'Hook journal idempotency key collision',
      );
    }
    journal.close();
  });

  it('fails closed on invalid clocks with zero journal writes', async () => {
    for (const invalidNow of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      const path = fixture();
      const journal = new SqliteHookJournal(path, {
        masterKey,
        ownerId: 'clock-owner',
        leaseMs: 1_000,
        nowMs: () => invalidNow,
      });
      await expect(journal.claim(claimInput(`clock-${invalidNow}`))).rejects.toThrow(
        'Hook journal clock must return non-negative milliseconds',
      );
      const raw = new Database(path, { readonly: true });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM hook_journal').get()).toEqual({
        count: 0,
      });
      raw.close();
      journal.close();
    }
  });

  it('rejects invalid tokens and all operations after close', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'closed-owner',
      leaseMs: 1_000,
    });
    const input = claimInput('closed-key');
    const token = claimedToken(await journal.claim(input));
    await expect(journal.commit('', record(input, 'secret'))).rejects.toThrow(
      'claimToken is required',
    );
    await expect(journal.release('unknown-token')).rejects.toThrow(
      'invalid Hook journal claim',
    );
    await journal.release(token);
    journal.close();
    journal.close();
    await expect(journal.claim(input)).rejects.toThrow('Hook journal is closed');
    await expect(journal.commit(token, record(input, 'secret'))).rejects.toThrow(
      'Hook journal is closed',
    );
    await expect(journal.release(token)).rejects.toThrow('Hook journal is closed');
  });

  it('binds commit to the live token, record identity and outcome event', async () => {
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'commit-owner',
      leaseMs: 1_000,
    });
    const input = claimInput('commit-identity');
    const token = claimedToken(await journal.claim(input));
    const valid = record(input, 'commit-secret');
    for (const [candidate, message] of [
      [{ ...valid, idempotency_key: 'other' }, 'Hook journal record identity conflict'],
      [
        { ...valid, scope: { ...valid.scope, operation_id: 'other' } },
        'Hook journal idempotency key collision',
      ],
      [
        { ...valid, scope: { ...valid.scope, attempt_id: 'other' } },
        'Hook journal idempotency key collision',
      ],
      [
        { ...valid, input_hash: 'a'.repeat(64) },
        'Hook journal idempotency key collision',
      ],
      [
        { ...valid, outcome: null },
        'Hook journal outcome event mismatch',
      ],
      [
        { ...valid, outcome: { ...valid.outcome, event: 'post_tool_use' } },
        'Hook journal outcome event mismatch',
      ],
    ] as const) {
      await expect(journal.commit(token, candidate as never)).rejects.toThrow(
        message,
      );
    }
    await expect(journal.commit('unknown-token', valid)).rejects.toThrow(
      'invalid Hook journal claim',
    );
    await journal.commit(token, valid);
    await expect(journal.commit(token, valid)).rejects.toThrow(
      'invalid Hook journal claim',
    );
    journal.close();
  });

  it('moves an expired commit to reconciliation without writing an outcome', async () => {
    let now = 100;
    const path = fixture();
    const journal = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'expiry-owner',
      leaseMs: 10,
      nowMs: () => now,
    });
    const input = claimInput('expired-commit');
    const token = claimedToken(await journal.claim(input));
    now = 110;
    await expect(journal.commit(token, record(input, 'must-not-write'))).rejects.toThrow(
      'Hook journal claim expired and requires reconciliation',
    );
    const raw = new Database(path, { readonly: true });
    expect(
      raw
        .prepare('SELECT state, outcome_ciphertext FROM hook_journal WHERE idempotency_key = ?')
        .get(input.idempotency_key),
    ).toEqual({ state: 'RECONCILIATION', outcome_ciphertext: null });
    raw.close();
    await expect(journal.claim(input)).resolves.toEqual({
      status: 'reconciliation',
      reason_code: 'hook_claim_abandoned',
    });
    journal.close();
  });

  it.each([
    ['bad-prefix', (parts: string[]) => { parts[0] = 'bad'; }],
    ['missing-part', (parts: string[]) => { parts.pop(); }],
    ['bad-nonce', (parts: string[]) => { parts[2] = Buffer.alloc(11).toString('base64'); }],
    ['bad-tag', (parts: string[]) => { parts[3] = Buffer.alloc(15).toString('base64'); }],
    ['bad-ciphertext', (parts: string[]) => { parts[4] = Buffer.from('tampered').toString('base64'); }],
  ] as const)(
    'rejects authenticated envelope variant %s',
    async (_case, mutate) => {
      const path = fixture();
      const input = claimInput(`envelope-${_case}`);
      const journal = new SqliteHookJournal(path, {
        masterKey,
        ownerId: 'envelope-writer',
        leaseMs: 1_000,
      });
      await journal.commit(
        claimedToken(await journal.claim(input)),
        record(input, 'envelope-secret'),
      );
      journal.close();
      const raw = new Database(path);
      const row = raw
        .prepare('SELECT outcome_ciphertext FROM hook_journal WHERE idempotency_key = ?')
        .get(input.idempotency_key) as { outcome_ciphertext: string };
      const parts = row.outcome_ciphertext.split(':');
      mutate(parts);
      raw
        .prepare('UPDATE hook_journal SET outcome_ciphertext = ? WHERE idempotency_key = ?')
        .run(parts.join(':'), input.idempotency_key);
      raw.close();
      const reopened = new SqliteHookJournal(path, {
        masterKey,
        ownerId: 'envelope-reader',
        leaseMs: 1_000,
      });
      await expect(reopened.claim(input)).rejects.toThrow(
        'hook journal authentication failed',
      );
      reopened.close();
    },
  );

  it('fails closed on invalid encryption metadata and legacy populated migration', () => {
    const invalidSaltPath = fixture();
    new SqliteHookJournal(invalidSaltPath, {
      masterKey,
      ownerId: 'salt-initializer',
      leaseMs: 1_000,
    }).close();
    const invalidSalt = new Database(invalidSaltPath);
    invalidSalt
      .prepare("UPDATE hook_journal_metadata SET value = '' WHERE key = 'encryption_salt'")
      .run();
    invalidSalt.close();
    expect(
      () =>
        new SqliteHookJournal(invalidSaltPath, {
          masterKey,
          ownerId: 'salt-reader',
          leaseMs: 1_000,
        }),
    ).toThrow('Hook journal encryption salt invalid');

    const legacyPath = fixture();
    new SqliteHookJournal(legacyPath, {
      masterKey,
      ownerId: 'legacy-initializer',
      leaseMs: 1_000,
    }).close();
    const legacy = new Database(legacyPath);
    legacy.prepare("DELETE FROM hook_journal_metadata WHERE key = 'encryption_key_check'").run();
    legacy
      .prepare(
        `INSERT INTO hook_journal (
          tenant_id, run_id, session_id, operation_id, attempt_id,
          idempotency_key, event, input_hash, state, owner_id,
          claim_token_hash, lease_expires_at_ms, outcome_ciphertext,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'RECONCILIATION', NULL, NULL, NULL, NULL, 0, 0)`,
      )
      .run(
        'legacy-tenant',
        'legacy-run',
        'legacy-session',
        'legacy-key',
        'pre_tool_use',
        'a'.repeat(64),
      );
    legacy.close();
    expect(
      () =>
        new SqliteHookJournal(legacyPath, {
          masterKey,
          ownerId: 'legacy-reader',
          leaseMs: 1_000,
        }),
    ).toThrow('Hook journal key-check migration requires an empty journal');
  });

  it('rejects a committed row without authenticated outcome bytes', async () => {
    const path = fixture();
    const input = claimInput('incomplete-commit');
    const writer = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'incomplete-writer',
      leaseMs: 1_000,
    });
    await writer.claim(input);
    writer.close();
    const raw = new Database(path);
    raw
      .prepare(
        `UPDATE hook_journal
         SET state = 'COMMITTED', owner_id = NULL, claim_token_hash = NULL,
             lease_expires_at_ms = NULL, outcome_ciphertext = NULL
         WHERE idempotency_key = ?`,
      )
      .run(input.idempotency_key);
    raw.close();
    const reader = new SqliteHookJournal(path, {
      masterKey,
      ownerId: 'incomplete-reader',
      leaseMs: 1_000,
    });
    await expect(reader.claim(input)).rejects.toThrow(
      'Hook journal committed row is incomplete',
    );
    reader.close();
  });
});
