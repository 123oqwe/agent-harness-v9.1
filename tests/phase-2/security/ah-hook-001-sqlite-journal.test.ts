import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
    now = 2_001;
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
});
