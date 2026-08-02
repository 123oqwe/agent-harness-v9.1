import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  preflightExistingSessionDatabase,
  SqliteSessionStore,
} from '../../session/sqlite-session-store.js';
import { DurableSession } from '../../session/durable-session.js';
import { writeProgressAtomic, readProgress } from '../../session/progress-store.js';
import {
  createTrustedSessionStateRoot,
  type TrustedSessionStateRoot,
} from '../../session/session-state-root.js';

describe('SQLite Session Store', () => {
  const MASTER_KEY = Buffer.alloc(32, 0x5a);
  let dir: string;
  let store: SqliteSessionStore;
  let stateRoot: TrustedSessionStateRoot;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-'));
    stateRoot = createTrustedSessionStateRoot(dir);
    store = new SqliteSessionStore(join(dir, 'session.db'), {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
  });
  afterEach(() => {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('creates and retrieves a run', () => {
    expect(store.createRun('run-1', 'fix the bug', 'react')).toBe(true);
    expect(store.getRun('run-1')).toMatchObject({
      run_id: 'run-1',
      goal: 'fix the bug',
      strategy: 'react',
      status: 'running',
    });
    expect(existsSync(join(dir, 'session.db'))).toBe(true);
    expect(statSync(join(dir, 'session.db')).mode & 0o777).toBe(0o600);
  });

  it('binds encrypted records to the accepted HKDF context and row identity', () => {
    const dbPath = join(dir, 'session.db');
    store.createRun('context-run', 'context-bound goal', 'direct');
    const raw = new Database(dbPath, { readonly: true });
    const salt = Buffer.from(
      (
        raw
          .prepare("SELECT value FROM metadata WHERE key = 'encryption_salt'")
          .get() as { value: string }
      ).value,
      'base64',
    );
    const envelope = (
      raw.prepare('SELECT goal FROM runs WHERE run_id = ?').get('context-run') as {
        goal: string;
      }
    ).goal;
    raw.close();
    const [, , nonce64, tag64, ciphertext64] = envelope.split(':');
    const derived = Buffer.from(
      hkdfSync(
        'sha256',
        MASTER_KEY,
        salt,
        'agent-harness/session-store/v1',
        32,
      ),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      derived,
      Buffer.from(nonce64!, 'base64'),
    );
    decipher.setAAD(Buffer.from('runs:context-run:goal'));
    decipher.setAuthTag(Buffer.from(tag64!, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext64!, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    derived.fill(0);
    salt.fill(0);

    expect(envelope.startsWith('ahenc:v1:')).toBe(true);
    expect(plaintext).toBe('context-bound goal');
  });

  it('requires an exact 256-bit caller-supplied master key', () => {
    expect(
      () =>
        new SqliteSessionStore(join(dir, 'missing-key.db'), undefined as never),
    ).toThrow('32-byte masterKey is required');
    expect(
      () =>
        new SqliteSessionStore(join(dir, 'short-key.db'), {
          masterKey: Buffer.alloc(31),
          state_root: stateRoot,
        }),
    ).toThrow('32-byte masterKey is required');
  });

  it('rejects an invalid persisted encryption salt', () => {
    const dbPath = join(dir, 'session.db');
    store.close();
    const raw = new Database(dbPath);
    raw
      .prepare("UPDATE metadata SET value = 'bad' WHERE key = 'encryption_salt'")
      .run();
    raw.close();

    expect(
      () => new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot }),
    ).toThrow('session encryption salt invalid');
  });

  it('rejects a partial existing schema before attempting salt creation', () => {
    const dbPath = join(dir, 'salt-blocked.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TRIGGER reject_salt BEFORE INSERT ON metadata
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    raw.close();

    expect(
      () => new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot }),
    ).toThrow('session store schema is malformed');
  });

  it('encrypts goals, event data, snapshot summaries, and operation outcomes at rest', () => {
    const dbPath = join(dir, 'session.db');
    store.createRun('encrypted-run', 'secret goal marker', 'react');
    const session = new DurableSession('encrypted-run', {
      clock: () => '2026-07-25T00:00:00.000Z',
      persistence: store,
    });
    session.acquireWriter();
    session.append('user', { text: 'secret event marker' });
    session.snapshot_({ summary: 'secret snapshot marker' });
    store.recordOperation({
      operation_id: 'encrypted-op',
      run_id: 'encrypted-run',
      step_id: 'step',
      attempt_id: 'attempt',
      tool_name: 'read_file',
      idempotency_key: 'encrypted-idempotency',
      effect_state: 'PRE_DISPATCH',
      receipt_json: 'secret outcome marker',
    });
    store.close();

    const databaseBytes = readFileSync(dbPath);
    for (const marker of [
      'secret goal marker',
      'secret event marker',
      'secret snapshot marker',
      'secret outcome marker',
    ]) {
      expect(databaseBytes.includes(Buffer.from(marker))).toBe(false);
    }

    store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
    expect(store.getRun('encrypted-run')?.goal).toBe('secret goal marker');
    expect(store.loadEvents('encrypted-run')[0]?.data).toEqual({
      text: 'secret event marker',
    });
    expect(store.getLatestSnapshot('encrypted-run')?.summary).toEqual({
      summary: 'secret snapshot marker',
    });
    expect(store.getOperation('encrypted-op')?.receipt_json).toBe(
      'secret outcome marker',
    );
  });

  it('fails closed when the database is opened with a different key', () => {
    const dbPath = join(dir, 'session.db');
    store.createRun('wrong-key-run', 'private goal');
    store.close();
    expect(
      () =>
        new SqliteSessionStore(dbPath, {
          masterKey: Buffer.alloc(32, 0x33),
          state_root: stateRoot,
        }),
    ).toThrow(
      'session record key authentication failed',
    );
  });

  it('wrong-key preflight leaves the existing database directory byte-for-byte unchanged', () => {
    const dbPath = join(dir, 'session.db');
    store.createRun('wrong-key-zero-write', 'private');
    store.close();
    const snapshot = () => ({
      directoryMode: statSync(dir).mode & 0o777,
      entries: readdirSync(dir)
        .sort()
        .map((name) => {
          const path = join(dir, name);
          const stat = statSync(path);
          return {
            name,
            mode: stat.mode & 0o777,
            size: stat.size,
            hash: stat.isFile()
              ? createHash('sha256').update(readFileSync(path)).digest('hex')
              : null,
          };
        }),
    });
    const before = snapshot();
    expect(
      () =>
        new SqliteSessionStore(dbPath, {
          masterKey: Buffer.alloc(32, 0x33),
          state_root: stateRoot,
        }),
    ).toThrow('session record key authentication failed');
    expect(snapshot()).toEqual(before);
  });

  it('never lets createScopedRun claim a pre-existing generic run', () => {
    const runId = 'pre-existing-generic-root';
    store.createRun(runId, 'unowned run', 'direct');

    expect(() =>
      store.createScopedRun(
        { tenant_id: 'tenant-claim', root_session_id: runId },
        runId,
        'unowned run',
        'direct',
      ),
    ).toThrow('pre-existing generic run cannot be claimed');

    const database = new Database(join(dir, 'session.db'));
    try {
      expect(
        database.prepare('SELECT * FROM run_scopes WHERE run_id = ?').get(runId),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it.each([
    [
      'trigger',
      `CREATE TRIGGER unexpected_run_trigger AFTER INSERT ON runs
       BEGIN UPDATE runs SET status = 'tampered' WHERE run_id = NEW.run_id; END;`,
    ],
    ['view', 'CREATE VIEW unexpected_runs AS SELECT run_id FROM runs;'],
    ['index', 'CREATE INDEX unexpected_status_index ON runs(status);'],
  ])('validates the exact base schema and rejects an extra %s', (_kind, sql) => {
    const dbPath = join(dir, 'session.db');
    store.close();
    const database = new Database(dbPath);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
    expect(
      () => new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot }),
    ).toThrow('session store schema is malformed');
  });

  it('rejects a malformed run_scopes ownership table', () => {
    const dbPath = join(dir, 'session.db');
    store.close();
    const database = new Database(dbPath);
    try {
      database.exec(`
        DROP TABLE run_scopes;
        CREATE TABLE run_scopes (
          run_id TEXT,
          tenant_id TEXT,
          root_session_id TEXT,
          kind TEXT
        );
        INSERT INTO run_scopes VALUES ('first', 'duplicate-tenant', 'duplicate-root', 'root');
        INSERT INTO run_scopes VALUES ('second', 'duplicate-tenant', 'duplicate-root', 'root');
      `);
    } finally {
      database.close();
    }
    expect(
      () => new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot }),
    ).toThrow('session store schema is malformed');
  });

  it('rejects NUL and oversized durable identifiers at the store boundary', () => {
    expect(() => store.createRun('bad\0run', 'goal')).toThrow(
      'run_id is malformed',
    );
    expect(() => store.createRun('x'.repeat(257), 'goal')).toThrow(
      'run_id is malformed',
    );
    expect(() =>
      store.createScopedRun(
        { tenant_id: 'bad\0tenant', root_session_id: 'root' },
        'root',
        'goal',
      ),
    ).toThrow('tenant_id is malformed');
  });

  it('rejects malformed Unicode and non-NFC identifier aliases', () => {
    for (const invalid of ['\ud800', '\ud801', 'e\u0301']) {
      expect(() => store.createRun(invalid, 'goal')).toThrow(
        'run_id is malformed',
      );
    }
    expect(store.createRun('\u00e9', 'canonical NFC')).toBe(true);
    expect(() => store.getRun('e\u0301')).toThrow('run_id is malformed');
  });

  it('sees and rejects malicious SessionTree schema committed only in WAL', () => {
    const dbPath = join(dir, 'session.db');
    const writer = new Database(dbPath);
    try {
      writer.pragma('journal_mode = WAL');
      writer.exec('CREATE TABLE session_tree_evil (payload TEXT)');
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(() =>
        preflightExistingSessionDatabase(dbPath, MASTER_KEY, stateRoot),
      ).toThrow('session store schema is malformed');
    } finally {
      writer.close();
    }
  });

  it('rejects a symlinked SQLite main file during read-only preflight', () => {
    const dbPath = join(dir, 'session.db');
    store.close();
    const linked = join(dir, 'linked.db');
    symlinkSync(dbPath, linked);
    expect(() =>
      preflightExistingSessionDatabase(linked, MASTER_KEY, stateRoot),
    ).toThrow(/symlink|descriptor|regular file/u);
  });

  it.each([
    ['plaintext', 'plaintext'],
    ['short envelope', 'ahenc:v1:only-one-part'],
    ['wrong prefix', 'wrong:v1:YWJj:YWJj:YWJj'],
    ['bad nonce', 'ahenc:v1:YQ==:AAAAAAAAAAAAAAAAAAAAAA==:YQ=='],
    ['bad tag', 'ahenc:v1:AAAAAAAAAAAAAAAA:YWJj:YQ=='],
  ])('rejects a corrupted encrypted field: %s', (_name, corrupted) => {
    const dbPath = join(dir, 'session.db');
    store.createRun('corrupt-run', 'private');
    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE runs SET goal = ? WHERE run_id = ?')
      .run(corrupted, 'corrupt-run');
    raw.close();

    expect(() => store.getRun('corrupt-run')).toThrow(
      corrupted.startsWith('ahenc:v1:') && corrupted.split(':').length === 5
        ? 'session field authentication failed'
        : 'unencrypted session field rejected',
    );
  });

  it('authenticates row identity so ciphertext cannot be swapped between runs', () => {
    const dbPath = join(dir, 'session.db');
    store.createRun('run-a', 'goal a');
    store.createRun('run-b', 'goal b');
    const raw = new Database(dbPath);
    const first = (
      raw.prepare('SELECT goal FROM runs WHERE run_id = ?').get('run-a') as {
        goal: string;
      }
    ).goal;
    const second = (
      raw.prepare('SELECT goal FROM runs WHERE run_id = ?').get('run-b') as {
        goal: string;
      }
    ).goal;
    raw.prepare('UPDATE runs SET goal = ? WHERE run_id = ?').run(second, 'run-a');
    raw.prepare('UPDATE runs SET goal = ? WHERE run_id = ?').run(first, 'run-b');
    raw.close();

    expect(() => store.getRun('run-a')).toThrow(
      'session field authentication failed',
    );
  });

  it('never replaces an existing run identity', () => {
    expect(store.createRun('run-stable', 'original goal', 'react')).toBe(true);
    expect(store.createRun('run-stable', 'original goal', 'react')).toBe(false);
    expect(() =>
      store.createRun('run-stable', 'different goal', 'react'),
    ).toThrow('run identity conflict');
    expect(() =>
      store.createRun('run-stable', 'different goal', 'direct'),
    ).toThrow('run identity conflict');
    expect(store.getRun('run-stable')?.goal).toBe('original goal');
    expect(() =>
      store.createRun('run-stable', 'original goal', 'plan_execute'),
    ).toThrow('run identity conflict');
    expect(store.getRun('missing-run')).toBeNull();
    expect(() => store.updateRunStatus('missing-run', 'failed')).toThrow(
      'run not found: missing-run',
    );
  });

  it('persists events immediately and loads them back', () => {
    store.createRun('run-2', 'test goal');
    const ev = { seq: 1, type: 'user' as const, timestamp: new Date().toISOString(), data: { text: 'hello' }, hash: 'abc', prev_hash: '' };
    store.appendEvent('run-2', ev);
    const loaded = store.loadEvents('run-2');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.type).toBe('user');
    expect((loaded[0]!.data as { text: string }).text).toBe('hello');
  });

  it('rejects a snapshot bound to a different run identity', () => {
    store.createRun('snapshot-run', 'test');
    expect(store.getLatestSnapshot('snapshot-run')).toBeNull();
    expect(() =>
      store.saveSnapshot('snapshot-run', {
        session_id: 'different-run',
        version: 1,
        last_seq: 0,
        last_hash: '',
        created_at: '2026-07-25T00:00:00.000Z',
        summary: {},
      }),
    ).toThrow('snapshot identity conflict: snapshot-run');
  });

  it('prevents duplicate event insertion (idempotent)', () => {
    store.createRun('run-3', 'test');
    const ev = { seq: 1, type: 'user' as const, timestamp: new Date().toISOString(), data: {}, hash: 'h1', prev_hash: '' };
    store.appendEvent('run-3', ev);
    store.appendEvent('run-3', ev); // same seq, should be ignored
    expect(store.loadEvents('run-3')).toHaveLength(1);
  });

  it('rejects a conflicting event at an existing sequence', () => {
    store.createRun('run-conflict', 'test');
    const event = {
      seq: 1,
      type: 'user' as const,
      timestamp: new Date().toISOString(),
      data: { value: 1 },
      hash: 'hash-1',
      prev_hash: '',
    };
    store.appendEvent('run-conflict', event);
    expect(() =>
      store.appendEvent('run-conflict', {
        ...event,
        data: { value: 2 },
        hash: 'hash-2',
      }),
    ).toThrow('event conflict at run-conflict:1');
    for (const changed of [
      { type: 'assistant' as const },
      { timestamp: '2026-07-25T01:00:00.000Z' },
      { data: { value: 3 } },
      { hash: 'different-hash' },
      { prev_hash: 'different-parent' },
    ]) {
      expect(() =>
        store.appendEvent('run-conflict', { ...event, ...changed }),
      ).toThrow('event conflict at run-conflict:1');
    }
  });

  it('records operations with idempotency key', () => {
    store.createRun('run-4', 'test');
    store.recordOperation({
      operation_id: 'op-1', run_id: 'run-4', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'read_file', idempotency_key: 'idem-1', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    const op = store.getOperation('op-1');
    expect(op).not.toBeNull();
    expect(op!.tool_name).toBe('read_file');
    expect(op!.effect_state).toBe('PRE_DISPATCH');
  });

  it('lists only one run\'s operations as decrypted immutable records', () => {
    store.createRun('run-list', 'test');
    store.createRun('run-list-other', 'test');
    for (const [operation_id, run_id, receipt_json] of [
      ['op-list-b', 'run-list', '{"position":2}'],
      ['op-list-a', 'run-list', '{"position":1}'],
      ['op-list-other', 'run-list-other', '{"position":0}'],
    ] as const) {
      store.recordOperation({
        operation_id,
        run_id,
        step_id: `step-${operation_id}`,
        attempt_id: 'attempt',
        tool_name: 'read_file',
        idempotency_key: `idem-${operation_id}`,
        effect_state: 'PRE_DISPATCH',
        receipt_json,
      });
    }
    const listed = store.listOperations('run-list');
    expect(listed).toHaveLength(2);
    expect(listed.map((operation) => operation.operation_id).sort()).toEqual([
      'op-list-a',
      'op-list-b',
    ]);
    expect(listed.find((operation) => operation.operation_id === 'op-list-a')).toMatchObject({
      receipt_json: '{"position":1}',
    });
    expect(listed.find((operation) => operation.operation_id === 'op-list-b')).toMatchObject({
      receipt_json: '{"position":2}',
    });
    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed.every((operation) => Object.isFrozen(operation))).toBe(true);
  });

  it('requires every new effect journal entry to begin PRE_DISPATCH', () => {
    store.createRun('run-initial-state', 'test');
    expect(() =>
      store.recordOperation({
        operation_id: 'op-invalid-initial',
        run_id: 'run-initial-state',
        step_id: 'step',
        attempt_id: 'attempt',
        tool_name: 'write_file',
        idempotency_key: 'idem-invalid-initial',
        effect_state: 'EFFECT_CONFIRMED',
        receipt_json: null,
      }),
    ).toThrow('new operation must begin PRE_DISPATCH');
  });

  it.each([
    ['run_id', { run_id: 'different-run' }],
    ['step_id', { step_id: 'different-step' }],
    ['tool_name', { tool_name: 'write_file' }],
    ['idempotency_key', { idempotency_key: 'different-key' }],
  ])('rejects mutation of operation identity field %s', (_field, changed) => {
    store.createRun('run-op-identity', 'test');
    const operation = {
      operation_id: 'op-identity',
      run_id: 'run-op-identity',
      step_id: 'step',
      attempt_id: 'attempt',
      tool_name: 'read_file',
      idempotency_key: 'idem-op-identity',
      effect_state: 'PRE_DISPATCH' as const,
      receipt_json: null,
    };
    store.recordOperation(operation);
    expect(() =>
      store.recordOperation({ ...operation, ...changed }),
    ).toThrow('operation identity conflict: op-identity');
  });

  it('rejects an attempt change except after definite no-effect failure', () => {
    store.createRun('run-attempt', 'test');
    const operation = {
      operation_id: 'op-attempt',
      run_id: 'run-attempt',
      step_id: 'step',
      attempt_id: 'attempt-1',
      tool_name: 'read_file',
      idempotency_key: 'idem-attempt',
      effect_state: 'PRE_DISPATCH' as const,
      receipt_json: null,
    };
    store.recordOperation(operation);
    expect(() =>
      store.recordOperation({
        ...operation,
        attempt_id: 'attempt-2',
        effect_state: 'IN_FLIGHT',
      }),
    ).toThrow('operation attempt conflict: op-attempt');
  });

  it('prevents duplicate operations by idempotency key', () => {
    store.createRun('run-5', 'test');
    store.recordOperation({
      operation_id: 'op-2', run_id: 'run-5', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'write_file', idempotency_key: 'idem-2', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    // Attempt to create another op with the same idempotency key should fail
    expect(() => store.recordOperation({
      operation_id: 'op-3', run_id: 'run-5', step_id: 'step-2', attempt_id: 'att-2',
      tool_name: 'write_file', idempotency_key: 'idem-2', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    })).toThrow(
      'idempotency key collision: idem-2 already used by operation op-2',
    );
  });

  it('tracks effect state transitions', () => {
    store.createRun('run-6', 'test');
    store.recordOperation({
      operation_id: 'op-4', run_id: 'run-6', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'execute_command', idempotency_key: 'idem-4', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    store.recordOperation({
      operation_id: 'op-4', run_id: 'run-6', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'execute_command', idempotency_key: 'idem-4', effect_state: 'IN_FLIGHT',
      receipt_json: null,
    });
    store.recordOperation({
      operation_id: 'op-4', run_id: 'run-6', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'execute_command', idempotency_key: 'idem-4', effect_state: 'EFFECT_CONFIRMED',
      receipt_json: '{"success":true}',
    });
    expect(store.isEffectConfirmed('idem-4')).toBe(true);
  });

  it('rejects impossible effect-state transitions', () => {
    store.createRun('run-transition', 'test');
    store.recordOperation({
      operation_id: 'op-transition',
      run_id: 'run-transition',
      step_id: 'step',
      attempt_id: 'attempt',
      tool_name: 'write_file',
      idempotency_key: 'idem-transition',
      effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    expect(() =>
      store.recordOperation({
        operation_id: 'op-transition',
        run_id: 'run-transition',
        step_id: 'step',
        attempt_id: 'attempt',
        tool_name: 'write_file',
        idempotency_key: 'idem-transition',
        effect_state: 'EFFECT_CONFIRMED',
        receipt_json: '{}',
      }),
    ).toThrow('invalid effect transition');
  });

  it('enforces terminal effect transitions and exact idempotent replay', () => {
    store.createRun('run-terminal', 'test');
    const base = {
      operation_id: 'op-terminal',
      run_id: 'run-terminal',
      step_id: 'step',
      attempt_id: 'attempt',
      tool_name: 'write_file',
      idempotency_key: 'idem-terminal',
      receipt_json: null,
    };
    store.recordOperation({ ...base, effect_state: 'PRE_DISPATCH' });
    store.recordOperation({ ...base, effect_state: 'IN_FLIGHT' });
    store.recordOperation({ ...base, effect_state: 'EFFECT_UNKNOWN' });
    expect(() =>
      store.recordOperation({ ...base, effect_state: 'EFFECT_CONFIRMED' }),
    ).toThrow('invalid effect transition: EFFECT_UNKNOWN -> EFFECT_CONFIRMED');
    expect(() =>
      store.recordOperation({ ...base, effect_state: 'PRE_DISPATCH' }),
    ).toThrow('invalid effect transition: EFFECT_UNKNOWN -> PRE_DISPATCH');
    expect(() =>
      store.recordOperation({
        ...base,
        effect_state: 'EFFECT_UNKNOWN',
        receipt_json: '{"changed":true}',
      }),
    ).toThrow('operation state replay conflict: op-terminal');
    expect(() =>
      store.recordOperation({ ...base, effect_state: 'EFFECT_UNKNOWN' }),
    ).not.toThrow();
  });

  it('rejects unknown target states from terminal operations', () => {
    for (const terminal of ['EFFECT_UNKNOWN', 'EFFECT_CONFIRMED'] as const) {
      const suffix = terminal.toLowerCase();
      const base = {
        operation_id: `op-${suffix}`,
        run_id: `run-${suffix}`,
        step_id: 'step',
        attempt_id: 'attempt',
        tool_name: 'write_file',
        idempotency_key: `idem-${suffix}`,
        receipt_json: null,
      };
      store.createRun(base.run_id, 'test');
      store.recordOperation({ ...base, effect_state: 'PRE_DISPATCH' });
      store.recordOperation({ ...base, effect_state: 'IN_FLIGHT' });
      store.recordOperation({ ...base, effect_state: terminal });
      expect(() =>
        store.recordOperation({
          ...base,
          effect_state: 'Stryker was here' as never,
        }),
      ).toThrow(`invalid effect transition: ${terminal} -> Stryker was here`);
    }
  });

  it('allows IN_FLIGHT to record a definite no-effect reconciliation result', () => {
    store.createRun('run-no-effect', 'test');
    const base = {
      operation_id: 'op-no-effect',
      run_id: 'run-no-effect',
      step_id: 'step',
      attempt_id: 'attempt',
      tool_name: 'write_file',
      idempotency_key: 'idem-no-effect',
      receipt_json: null,
    };
    store.recordOperation({ ...base, effect_state: 'PRE_DISPATCH' });
    store.recordOperation({ ...base, effect_state: 'IN_FLIGHT' });
    store.recordOperation({
      ...base,
      effect_state: 'DEFINITELY_FAILED_NO_EFFECT',
      receipt_json: '{"provider_rejected":true}',
    });
    expect(store.getOperation('op-no-effect')).toMatchObject({
      effect_state: 'DEFINITELY_FAILED_NO_EFFECT',
      receipt_json: '{"provider_rejected":true}',
    });
  });

  it('allows a definitely-failed effect to start a new attempt', () => {
    store.createRun('run-retry', 'test');
    const base = {
      operation_id: 'op-retry',
      run_id: 'run-retry',
      step_id: 'step',
      tool_name: 'write_file',
      idempotency_key: 'idem-retry',
      receipt_json: null,
    };
    store.recordOperation({
      ...base,
      attempt_id: 'attempt-1',
      effect_state: 'PRE_DISPATCH',
    });
    store.recordOperation({
      ...base,
      attempt_id: 'attempt-1',
      effect_state: 'DEFINITELY_FAILED_NO_EFFECT',
    });
    store.recordOperation({
      ...base,
      attempt_id: 'attempt-2',
      effect_state: 'PRE_DISPATCH',
    });
    expect(store.getOperation('op-retry')).toMatchObject({
      attempt_id: 'attempt-2',
      effect_state: 'PRE_DISPATCH',
    });
  });

  it('isEffectConfirmed returns false for unknown key', () => {
    expect(store.isEffectConfirmed('nonexistent')).toBe(false);
  });

  it('records receipts linked to operations', () => {
    store.createRun('run-7', 'test');
    store.recordOperation({
      operation_id: 'op-5', run_id: 'run-7', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'read_file', idempotency_key: 'idem-5', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    store.recordOperation({
      operation_id: 'op-5', run_id: 'run-7', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'read_file', idempotency_key: 'idem-5', effect_state: 'IN_FLIGHT',
      receipt_json: null,
    });
    store.recordOperation({
      operation_id: 'op-5', run_id: 'run-7', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'read_file', idempotency_key: 'idem-5', effect_state: 'EFFECT_CONFIRMED',
      receipt_json: '{"ok":true}',
    });
    const receipt = {
      tool_name: 'read_file', success: true, input_hash: 'abc',
      output_hash: 'def', duration_ms: 42, timestamp: '2026-07-25T00:00:00.000Z',
    };
    store.recordReceipt('op-5', receipt);
    expect(store.getReceipt('op-5')).toMatchObject(receipt);
    expect(store.getReceipt('missing-operation')).toBeNull();
    expect(() => store.recordReceipt('op-5', receipt)).not.toThrow();
    for (const changed of [
      { tool_name: 'write_file' },
      { success: false },
      { input_hash: 'different-input' },
      { output_hash: 'different-output' },
      { duration_ms: 43 },
      { timestamp: '2026-07-25T00:00:01.000Z' },
    ]) {
      expect(() =>
        store.recordReceipt('op-5', { ...receipt, ...changed }),
      ).toThrow('receipt conflict for operation: op-5');
    }
  });

  it('round-trips a failed receipt with no output hash', () => {
    store.createRun('run-failed-receipt', 'test');
    store.recordOperation({
      operation_id: 'op-failed-receipt',
      run_id: 'run-failed-receipt',
      step_id: 'step',
      attempt_id: 'attempt',
      tool_name: 'read_file',
      idempotency_key: 'idem-failed-receipt',
      effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    store.recordReceipt('op-failed-receipt', {
      tool_name: 'read_file',
      success: false,
      input_hash: 'input',
      output_hash: null,
      duration_ms: 0,
      timestamp: '2026-07-25T00:00:00.000Z',
    });

    expect(store.getReceipt('op-failed-receipt')).toMatchObject({
      success: false,
      output_hash: null,
      duration_ms: 0,
    });
  });

  it('loads events after simulated crash (new store instance)', () => {
    store.createRun('run-8', 'crash test');
    store.appendEvent('run-8', { seq: 1, type: 'user', timestamp: new Date().toISOString(), data: { t: 1 }, hash: 'h1', prev_hash: '' });
    store.appendEvent('run-8', { seq: 2, type: 'assistant', timestamp: new Date().toISOString(), data: { t: 2 }, hash: 'h2', prev_hash: 'h1' });
    store.close();

    // Simulate crash: open a new store instance on the same DB
    const recovered = new SqliteSessionStore(join(dir, 'session.db'), {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
    const events = recovered.loadEvents('run-8');
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('user');
    expect(events[1]!.type).toBe('assistant');
    recovered.close();
  });

  it('closes exactly once and makes later database access impossible', () => {
    store.createRun('closed-run', 'test');
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => store.getRun('closed-run')).toThrow();
  });
});

describe('Progress Store (atomic writes)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prog-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('writes progress.json atomically', () => {
    const path = writeProgressAtomic(dir, {
      run_id: 'r1', current_step: 'step-1', goal: 'test',
      completed_steps: [], open_tasks: ['task-1'], last_error: null,
      checkpoint_refs: [], last_updated: new Date().toISOString(),
    });
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(dir, 'progress.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['progress.json']);
  });

  it('reads progress.json back', () => {
    writeProgressAtomic(dir, {
      run_id: 'r2', current_step: 'step-2', goal: 'test2',
      completed_steps: ['step-1'], open_tasks: [], last_error: 'none',
      checkpoint_refs: ['ref-1'], last_updated: '2026-01-01T00:00:00Z',
    });
    const p = readProgress(dir);
    expect(p).not.toBeNull();
    expect(p!.run_id).toBe('r2');
    expect(p!.completed_steps).toEqual(['step-1']);
  });

  it('atomically replaces an older progress record', () => {
    const first = {
      run_id: 'r-old', current_step: 1, goal: 'old',
      completed_steps: [], open_tasks: ['old'], last_error: null,
      checkpoint_refs: [], last_updated: '2026-01-01T00:00:00Z',
    };
    const second = {
      ...first,
      run_id: 'r-new',
      current_step: 2,
      goal: 'new',
      open_tasks: ['new'],
      last_updated: '2026-01-01T00:00:01Z',
    };
    writeProgressAtomic(dir, first);
    writeProgressAtomic(dir, second);

    expect(readProgress(dir)).toEqual(second);
    expect(readdirSync(dir)).toEqual(['progress.json']);
  });

  it('cleans its temporary file when publication fails', () => {
    mkdirSync(join(dir, 'progress.json'));
    expect(() =>
      writeProgressAtomic(dir, {
        run_id: 'r-fail', current_step: 1, goal: 'fail',
        completed_steps: [], open_tasks: [], last_error: 'failure',
        checkpoint_refs: [], last_updated: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('returns null when no progress file exists', () => {
    expect(readProgress(dir)).toBeNull();
  });
});
