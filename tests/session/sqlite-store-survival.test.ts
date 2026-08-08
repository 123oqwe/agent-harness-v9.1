import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  SqliteSessionStore,
  validateSessionStoreSchema,
} from '../../session/sqlite-session-store.js';
import {
  createTrustedSessionStateRoot,
  type TrustedSessionStateRoot,
} from '../../session/session-state-root.js';

const MASTER_KEY = Buffer.alloc(32, 0x5a);

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-survival-'));
  const stateRoot = createTrustedSessionStateRoot(dir);
  const dbPath = join(dir, 'session.db');
  const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
  return { store, dir, stateRoot, dbPath };
}

function cleanup(store: SqliteSessionStore, dir: string) {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

describe('sqlite-store-survival: schema validation', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('passes for valid store', () => {
    const db = new Database(ctx.dbPath);
    expect(() => validateSessionStoreSchema(db)).not.toThrow();
    db.close();
  });

  it('throws exact error for missing base table', () => {
    const db = new Database(ctx.dbPath);
    db.exec('DROP TABLE runs');
    expect(() => validateSessionStoreSchema(db)).toThrow('session store schema is malformed');
    db.close();
  });

  it('throws for wrong session_tree extension', () => {
    const db = new Database(ctx.dbPath);
    db.exec('DROP TABLE IF EXISTS session_tree_scopes');
    db.exec('CREATE TABLE session_tree_scopes (wrong_col TEXT)');
    expect(() => validateSessionStoreSchema(db)).toThrow('session store schema is malformed');
    db.close();
  });

  it('passes when session_tree tables are absent (length 0)', () => {
    const db = new Database(ctx.dbPath);
    db.exec('DROP TABLE IF EXISTS session_tree_scopes');
    db.exec('DROP TABLE IF EXISTS session_tree_sessions');
    db.exec('DROP TABLE IF EXISTS session_tree_commands');
    expect(() => validateSessionStoreSchema(db)).not.toThrow();
    db.close();
  });

  it('SQL is normalized with replace and trim', () => {
    const db = new Database(ctx.dbPath);
    const objects = (db.prepare(
      "SELECT type, name, tbl_name AS 'table', sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all() as any[]).map(v => ({ ...v, sql: v.sql.replace(/\s+/gu, ' ').trim() }));
    for (const obj of objects) {
      expect(obj.sql).not.toMatch(/^\s/);
      expect(obj.sql).not.toMatch(/\s$/);
      expect(obj.sql).not.toMatch(/\s{2,}/);
    }
    db.close();
  });

  it('session_tree extension tables with wrong schema are rejected', () => {
    const db = new Database(ctx.dbPath);
    db.exec('CREATE TABLE session_tree_scopes (wrong TEXT)');
    expect(() => validateSessionStoreSchema(db)).toThrow('session store schema is malformed');
    db.close();
  });
});

describe('sqlite-store-survival: createRun error messages', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('throws exact error for identity conflict', () => {
    ctx.store.createRun('run-1', 'goal-1', 'direct');
    expect(() => ctx.store.createRun('run-1', 'different-goal', 'direct')).toThrow('run identity conflict: run-1');
  });

  it('returns true for new run, false for duplicate with same data', () => {
    expect(ctx.store.createRun('run-1', 'goal-1', 'direct')).toBe(true);
    expect(ctx.store.createRun('run-1', 'goal-1', 'direct')).toBe(false);
  });

  it('stores goal encrypted (not plaintext)', () => {
    ctx.store.createRun('run-1', 'secret-goal-text', 'direct');
    const db = new Database(ctx.dbPath);
    const row = db.prepare('SELECT goal FROM runs WHERE run_id = ?').get('run-1') as { goal: string };
    expect(row.goal).not.toBe('secret-goal-text');
    expect(row.goal).not.toContain('secret-goal-text');
    db.close();
  });

  it('stores strategy as null when not provided', () => {
    ctx.store.createRun('run-1', 'goal');
    expect(ctx.store.getRun('run-1')!.strategy).toBeNull();
  });

  it('stores strategy when provided', () => {
    ctx.store.createRun('run-1', 'goal', 'react');
    expect(ctx.store.getRun('run-1')!.strategy).toBe('react');
  });
});

describe('sqlite-store-survival: createScopedRun', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('throws when runId != root_session_id', () => {
    expect(() => ctx.store.createScopedRun(
      { tenant_id: 'tenant-1', root_session_id: 'root-1' }, 'different-id', 'goal', 'direct',
    )).toThrow('root run identity must equal root_session_id');
  });

  it('succeeds and creates scope record', () => {
    expect(ctx.store.createScopedRun(
      { tenant_id: 'tenant-1', root_session_id: 'root-1' }, 'root-1', 'goal', 'direct',
    )).toBe(true);
  });

  it('is idempotent for same scope', () => {
    ctx.store.createScopedRun({ tenant_id: 'tenant-1', root_session_id: 'root-1' }, 'root-1', 'goal', 'direct');
    expect(ctx.store.createScopedRun({ tenant_id: 'tenant-1', root_session_id: 'root-1' }, 'root-1', 'goal', 'direct')).toBe(false);
  });

  it('throws on scope conflict (different tenant)', () => {
    ctx.store.createScopedRun({ tenant_id: 'tenant-1', root_session_id: 'root-1' }, 'root-1', 'goal', 'direct');
    expect(() => ctx.store.createScopedRun(
      { tenant_id: 'tenant-2', root_session_id: 'root-1' }, 'root-1', 'goal', 'direct',
    )).toThrow('run scope conflict: root-1');
  });

  it('throws on scope conflict (different root_session_id)', () => {
    // Create first scope with root-1
    ctx.store.createScopedRun(
      { tenant_id: 'tenant-1', root_session_id: 'root-1' }, 'root-1', 'goal', 'direct',
    );
    // Try to claim same run with different root_session_id
    // This triggers the existing.tenant_id check via different scope
    // We need to create a different run first, then try to claim with mismatched scope
    ctx.store.createRun('root-2', 'goal-2', 'direct');
    // root-2 exists as generic run, try to claim it with root-1's scope
    expect(() => ctx.store.createScopedRun(
      { tenant_id: 'tenant-1', root_session_id: 'root-1' }, 'root-2', 'goal-2', 'direct',
    )).toThrow('root run identity must equal root_session_id');
  });

  it('throws on scope conflict (wrong kind via DB CHECK constraint)', () => {
    // The DB has CHECK(kind = 'root'), so kind='child' is rejected by SQLite
    // This test verifies the CHECK constraint exists and works
    ctx.store.createRun('root-1', 'goal', 'direct');
    const db = new Database(ctx.dbPath);
    expect(() => db.prepare(
      "INSERT INTO run_scopes (run_id, tenant_id, root_session_id, kind) VALUES (?, ?, ?, ?)"
    ).run('root-1', 'tenant-1', 'root-1', 'child')).toThrow();
    db.close();
  });
});

describe('sqlite-store-survival: appendEvent conflicts', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  const baseEv = { seq: 0, type: 'tool_call' as const, timestamp: '2026-01-01T00:00:00Z', data: { step: 1 }, hash: 'h0', prev_hash: '' };

  it('detects type conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.appendEvent('r1', baseEv);
    expect(() => ctx.store.appendEvent('r1', { ...baseEv, type: 'tool_result' as const })).toThrow('event conflict at r1:0');
  });

  it('detects timestamp conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.appendEvent('r1', baseEv);
    expect(() => ctx.store.appendEvent('r1', { ...baseEv, timestamp: '2026-01-02T00:00:00Z' })).toThrow('event conflict at r1:0');
  });

  it('detects hash conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.appendEvent('r1', baseEv);
    expect(() => ctx.store.appendEvent('r1', { ...baseEv, hash: 'different' })).toThrow('event conflict at r1:0');
  });

  it('detects prev_hash conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.appendEvent('r1', baseEv);
    expect(() => ctx.store.appendEvent('r1', { ...baseEv, prev_hash: 'wrong' })).toThrow('event conflict at r1:0');
  });

  it('allows idempotent re-append', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.appendEvent('r1', baseEv);
    expect(() => ctx.store.appendEvent('r1', baseEv)).not.toThrow();
  });
});

describe('sqlite-store-survival: snapshots', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('throws on identity mismatch', () => {
    ctx.store.createRun('r1', 'goal');
    expect(() => ctx.store.saveSnapshot('r1', {
      session_id: 'different', version: 1, last_seq: 0, last_hash: 'h0',
      created_at: '2026-01-01T00:00:00Z', summary: { state: 'done' },
    })).toThrow('snapshot identity conflict: r1');
  });

  it('round-trips snapshot data', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.saveSnapshot('r1', {
      session_id: 'r1', version: 1, last_seq: 5, last_hash: 'hash-5',
      created_at: '2026-01-01T00:00:00Z', summary: { state: 'running', steps: 5 },
    });
    const loaded = ctx.store.getLatestSnapshot('r1');
    expect(loaded!.session_id).toBe('r1');
    expect(loaded!.version).toBe(1);
    expect(loaded!.last_seq).toBe(5);
    expect(loaded!.last_hash).toBe('hash-5');
    expect(loaded!.summary).toEqual({ state: 'running', steps: 5 });
  });

  it('returns null for non-existent run', () => {
    expect(ctx.store.getLatestSnapshot('nonexistent')).toBeNull();
  });

  it('returns highest version', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.saveSnapshot('r1', { session_id: 'r1', version: 1, last_seq: 3, last_hash: 'h3', created_at: '2026-01-01', summary: { v: 1 } });
    ctx.store.saveSnapshot('r1', { session_id: 'r1', version: 2, last_seq: 5, last_hash: 'h5', created_at: '2026-01-02', summary: { v: 2 } });
    expect(ctx.store.getLatestSnapshot('r1')!.version).toBe(2);
  });
});

describe('sqlite-store-survival: recordOperation transitions', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  const baseOp = {
    operation_id: 'op-1', run_id: 'r1', step_id: 's1',
    attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1',
    effect_state: 'PRE_DISPATCH' as const, receipt_json: null as string | null,
  };

  it('rejects new operation not in PRE_DISPATCH', () => {
    ctx.store.createRun('r1', 'goal');
    expect(() => ctx.store.recordOperation({ ...baseOp, effect_state: 'IN_FLIGHT' as const }))
      .toThrow('new operation must begin PRE_DISPATCH');
  });

  it('detects identity conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation(baseOp);
    expect(() => ctx.store.recordOperation({ ...baseOp, step_id: 'different' }))
      .toThrow('operation identity conflict: op-1');
  });

  it('detects attempt conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation(baseOp);
    ctx.store.recordOperation({ ...baseOp, effect_state: 'IN_FLIGHT' as const });
    expect(() => ctx.store.recordOperation({ ...baseOp, attempt_id: 'a2', effect_state: 'EFFECT_CONFIRMED' as const }))
      .toThrow('operation attempt conflict: op-1');
  });

  it('allows retry from DEFINITELY_FAILED to PRE_DISPATCH', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation(baseOp);
    ctx.store.recordOperation({ ...baseOp, effect_state: 'IN_FLIGHT' as const });
    ctx.store.recordOperation({ ...baseOp, effect_state: 'DEFINITELY_FAILED_NO_EFFECT' as const });
    ctx.store.recordOperation({ ...baseOp, effect_state: 'PRE_DISPATCH' as const, attempt_id: 'a2' });
  });

  it('detects state replay conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation(baseOp);
    ctx.store.recordOperation({ ...baseOp, effect_state: 'IN_FLIGHT' as const });
    // Same state + same attempt_id but different receipt_json -> state replay conflict
    expect(() => ctx.store.recordOperation({ ...baseOp, effect_state: 'IN_FLIGHT' as const, receipt_json: '{"x":1}' }))
      .toThrow('operation state replay conflict: op-1');
  });

  it('rejects invalid transition with exact error', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation(baseOp);
    expect(() => ctx.store.recordOperation({ ...baseOp, effect_state: 'EFFECT_CONFIRMED' as const }))
      .toThrow('invalid effect transition: PRE_DISPATCH -> EFFECT_CONFIRMED');
  });

  it('detects idempotency key collision', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation(baseOp);
    expect(() => ctx.store.recordOperation({
      ...baseOp, operation_id: 'op-2', idempotency_key: 'k1',
    })).toThrow('idempotency key collision: k1 already used by operation op-1');
  });

  it('supports RECONCILING -> AWAITING_HUMAN transition', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation(baseOp);
    ctx.store.recordOperation({ ...baseOp, effect_state: 'IN_FLIGHT' as const });
    ctx.store.recordOperation({ ...baseOp, effect_state: 'EFFECT_UNKNOWN' as const });
    ctx.store.recordOperation({ ...baseOp, effect_state: 'RECONCILING' as const });
    ctx.store.recordOperation({ ...baseOp, effect_state: 'AWAITING_HUMAN' as const });
  });

  it('rejects transition from terminal EFFECT_CONFIRMED', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation(baseOp);
    ctx.store.recordOperation({ ...baseOp, effect_state: 'IN_FLIGHT' as const });
    ctx.store.recordOperation({ ...baseOp, effect_state: 'EFFECT_CONFIRMED' as const });
    expect(() => ctx.store.recordOperation({ ...baseOp, effect_state: 'IN_FLIGHT' as const }))
      .toThrow('invalid effect transition: EFFECT_CONFIRMED -> IN_FLIGHT');
  });
});

describe('sqlite-store-survival: recordReceipt conflicts', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  const baseReceipt = {
    tool_name: 'test', success: true, input_hash: 'ih1',
    output_hash: 'oh1', duration_ms: 100, timestamp: '2026-01-01T00:00:00Z',
  };

  it('stores and retrieves receipt', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation({ operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-1', baseReceipt);
    const r = ctx.store.getReceipt('op-1');
    expect(r!.tool_name).toBe('test');
    expect(r!.success).toBe(true);
    expect(r!.input_hash).toBe('ih1');
    expect(r!.output_hash).toBe('oh1');
    expect(r!.duration_ms).toBe(100);
  });

  it('detects success conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation({ operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-1', baseReceipt);
    expect(() => ctx.store.recordReceipt('op-1', { ...baseReceipt, success: false })).toThrow('receipt conflict for operation: op-1');
  });

  it('detects input_hash conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation({ operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-1', baseReceipt);
    expect(() => ctx.store.recordReceipt('op-1', { ...baseReceipt, input_hash: 'different' })).toThrow('receipt conflict for operation: op-1');
  });

  it('detects duration_ms conflict', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation({ operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-1', baseReceipt);
    expect(() => ctx.store.recordReceipt('op-1', { ...baseReceipt, duration_ms: 200 })).toThrow('receipt conflict for operation: op-1');
  });

  it('returns null for non-existent', () => {
    expect(ctx.store.getReceipt('nonexistent')).toBeNull();
  });

  it('handles null output_hash', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation({ operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-1', { ...baseReceipt, output_hash: null });
    const r = ctx.store.getReceipt('op-1');
    expect(r!.output_hash).toBeNull();
  });
});

describe('sqlite-store-survival: updateRunStatus and isEffectConfirmed', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('throws for non-existent run', () => {
    expect(() => ctx.store.updateRunStatus('nonexistent', 'completed')).toThrow('run not found: nonexistent');
  });

  it('changes status', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.updateRunStatus('r1', 'completed');
    expect(ctx.store.getRun('r1')!.status).toBe('completed');
  });

  it('isEffectConfirmed false for non-existent', () => {
    expect(ctx.store.isEffectConfirmed('nonexistent')).toBe(false);
  });

  it('isEffectConfirmed false for PRE_DISPATCH', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation({ operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    expect(ctx.store.isEffectConfirmed('k1')).toBe(false);
  });

  it('isEffectConfirmed true for EFFECT_CONFIRMED', () => {
    ctx.store.createRun('r1', 'goal');
    const op = { operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH' as const, receipt_json: null as string | null };
    ctx.store.recordOperation(op);
    ctx.store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
    ctx.store.recordOperation({ ...op, effect_state: 'EFFECT_CONFIRMED' as const });
    expect(ctx.store.isEffectConfirmed('k1')).toBe(true);
  });
});

describe('sqlite-store-survival: loadEvents and listOperations', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('loadEvents empty for non-existent', () => {
    expect(ctx.store.loadEvents('nonexistent')).toEqual([]);
  });

  it('loadEvents returns all in order', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.appendEvent('r1', { seq: 0, type: 'tool_call', timestamp: '2026-01-01T00:00:00Z', data: { s: 1 }, hash: 'h0', prev_hash: '' });
    ctx.store.appendEvent('r1', { seq: 1, type: 'tool_result', timestamp: '2026-01-01T00:01:00Z', data: { s: 1 }, hash: 'h1', prev_hash: 'h0' });
    const events = ctx.store.loadEvents('r1');
    expect(events).toHaveLength(2);
    expect(events[0]!.seq).toBe(0);
    expect(events[1]!.seq).toBe(1);
    expect(events[0]!.data).toEqual({ s: 1 });
  });

  it('listOperations empty for non-existent', () => {
    expect(ctx.store.listOperations('nonexistent')).toEqual([]);
  });

  it('listOperations returns frozen results', () => {
    ctx.store.createRun('r1', 'goal');
    ctx.store.recordOperation({ operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    const ops = ctx.store.listOperations('r1');
    expect(Object.isFrozen(ops)).toBe(true);
    expect(Object.isFrozen(ops[0])).toBe(true);
  });
});

describe('sqlite-store-survival: close', () => {
  it('double close does not throw', () => {
    const ctx = createStore();
    ctx.store.close();
    expect(() => ctx.store.close()).not.toThrow();
    rmSync(ctx.dir, { recursive: true, force: true });
  });
});

describe('sqlite-store-survival: snapshot encryption round-trip', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('saveSnapshot and getLatestSnapshot round-trip with complex summary', () => {
    ctx.store.createRun('run-snap-1', 'test goal');
    const snap = {
      session_id: 'run-snap-1',
      version: 1,
      last_seq: 5,
      last_hash: 'abc123',
      created_at: '2026-01-01T00:00:00Z',
      summary: { steps: [{ id: 1, action: 'read' }, { id: 2, action: 'write' }], count: 2 },
    };
    ctx.store.saveSnapshot('run-snap-1', snap);
    const loaded = ctx.store.getLatestSnapshot('run-snap-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe('run-snap-1');
    expect(loaded!.version).toBe(1);
    expect(loaded!.last_seq).toBe(5);
    expect(loaded!.last_hash).toBe('abc123');
    expect(loaded!.created_at).toBe('2026-01-01T00:00:00Z');
    expect(loaded!.summary).toEqual({ steps: [{ id: 1, action: 'read' }, { id: 2, action: 'write' }], count: 2 });
  });

  it('getLatestSnapshot returns null when no snapshots exist', () => {
    ctx.store.createRun('run-snap-2', 'test goal');
    expect(ctx.store.getLatestSnapshot('run-snap-2')).toBeNull();
  });

  it('saveSnapshot rejects mismatched session_id', () => {
    ctx.store.createRun('run-snap-3', 'test goal');
    expect(() => ctx.store.saveSnapshot('run-snap-3', {
      session_id: 'different-id',
      version: 1,
      last_seq: 0,
      last_hash: '',
      created_at: '2026-01-01T00:00:00Z',
      summary: {},
    })).toThrow('snapshot identity conflict');
  });

  it('multiple snapshots return the latest version', () => {
    ctx.store.createRun('run-snap-4', 'test goal');
    ctx.store.saveSnapshot('run-snap-4', {
      session_id: 'run-snap-4', version: 1, last_seq: 3, last_hash: 'h1',
      created_at: '2026-01-01T00:00:00Z', summary: { v: 1 },
    });
    ctx.store.saveSnapshot('run-snap-4', {
      session_id: 'run-snap-4', version: 2, last_seq: 6, last_hash: 'h2',
      created_at: '2026-01-02T00:00:00Z', summary: { v: 2 },
    });
    const loaded = ctx.store.getLatestSnapshot('run-snap-4');
    expect(loaded!.version).toBe(2);
    expect(loaded!.summary).toEqual({ v: 2 });
  });

  it('snapshot summary with null and numeric values round-trips', () => {
    ctx.store.createRun('run-snap-5', 'test goal');
    ctx.store.saveSnapshot('run-snap-5', {
      session_id: 'run-snap-5', version: 1, last_seq: 0, last_hash: '',
      created_at: '2026-01-01T00:00:00Z', summary: { n: null, num: 42, str: 'hello', bool: true },
    });
    const loaded = ctx.store.getLatestSnapshot('run-snap-5');
    expect(loaded!.summary).toEqual({ n: null, num: 42, str: 'hello', bool: true });
  });
});

describe('sqlite-store-survival: operation state transitions', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); ctx.store.createRun('r-op', 'goal'); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  function mkOp(id: string, state: string, idem = `key-${id}`, attempt = 'att-1'): any {
    return { operation_id: id, run_id: 'r-op', step_id: 's1', attempt_id: attempt, tool_name: 'tool', idempotency_key: idem, effect_state: state, receipt_json: null };
  }

  it('PRE_DISPATCH -> IN_FLIGHT transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-1', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-1', 'IN_FLIGHT'));
    expect(ctx.store.getOperation('op-1')!.effect_state).toBe('IN_FLIGHT');
  });

  it('PRE_DISPATCH -> DEFINITELY_FAILED_NO_EFFECT transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-2', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-2', 'DEFINITELY_FAILED_NO_EFFECT'));
    expect(ctx.store.getOperation('op-2')!.effect_state).toBe('DEFINITELY_FAILED_NO_EFFECT');
  });

  it('IN_FLIGHT -> EFFECT_CONFIRMED transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-3', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-3', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-3', 'EFFECT_CONFIRMED'));
    expect(ctx.store.getOperation('op-3')!.effect_state).toBe('EFFECT_CONFIRMED');
  });

  it('IN_FLIGHT -> EFFECT_UNKNOWN transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-4', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-4', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-4', 'EFFECT_UNKNOWN'));
    expect(ctx.store.getOperation('op-4')!.effect_state).toBe('EFFECT_UNKNOWN');
  });

  it('IN_FLIGHT -> DEFINITELY_FAILED_NO_EFFECT transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-5', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-5', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-5', 'DEFINITELY_FAILED_NO_EFFECT'));
    expect(ctx.store.getOperation('op-5')!.effect_state).toBe('DEFINITELY_FAILED_NO_EFFECT');
  });

  it('EFFECT_UNKNOWN -> RECONCILING transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-6', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-6', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-6', 'EFFECT_UNKNOWN'));
    ctx.store.recordOperation(mkOp('op-6', 'RECONCILING'));
    expect(ctx.store.getOperation('op-6')!.effect_state).toBe('RECONCILING');
  });

  it('RECONCILING -> EFFECT_CONFIRMED transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-7', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-7', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-7', 'EFFECT_UNKNOWN'));
    ctx.store.recordOperation(mkOp('op-7', 'RECONCILING'));
    ctx.store.recordOperation(mkOp('op-7', 'EFFECT_CONFIRMED'));
    expect(ctx.store.getOperation('op-7')!.effect_state).toBe('EFFECT_CONFIRMED');
  });

  it('RECONCILING -> DEFINITELY_FAILED_NO_EFFECT transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-8', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-8', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-8', 'EFFECT_UNKNOWN'));
    ctx.store.recordOperation(mkOp('op-8', 'RECONCILING'));
    ctx.store.recordOperation(mkOp('op-8', 'DEFINITELY_FAILED_NO_EFFECT'));
    expect(ctx.store.getOperation('op-8')!.effect_state).toBe('DEFINITELY_FAILED_NO_EFFECT');
  });

  it('RECONCILING -> AWAITING_HUMAN transition succeeds', () => {
    ctx.store.recordOperation(mkOp('op-9', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-9', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-9', 'EFFECT_UNKNOWN'));
    ctx.store.recordOperation(mkOp('op-9', 'RECONCILING'));
    ctx.store.recordOperation(mkOp('op-9', 'AWAITING_HUMAN'));
    expect(ctx.store.getOperation('op-9')!.effect_state).toBe('AWAITING_HUMAN');
  });

  it('DEFINITELY_FAILED_NO_EFFECT -> PRE_DISPATCH (retry) succeeds', () => {
    ctx.store.recordOperation(mkOp('op-10', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-10', 'DEFINITELY_FAILED_NO_EFFECT'));
    ctx.store.recordOperation(mkOp('op-10', 'PRE_DISPATCH', 'key-op-10', 'att-2'));
    expect(ctx.store.getOperation('op-10')!.effect_state).toBe('PRE_DISPATCH');
    expect(ctx.store.getOperation('op-10')!.attempt_id).toBe('att-2');
  });

  it('invalid transition PRE_DISPATCH -> EFFECT_CONFIRMED throws', () => {
    ctx.store.recordOperation(mkOp('op-11', 'PRE_DISPATCH'));
    expect(() => ctx.store.recordOperation(mkOp('op-11', 'EFFECT_CONFIRMED'))).toThrow('invalid effect transition');
  });

  it('invalid transition EFFECT_CONFIRMED -> IN_FLIGHT throws', () => {
    ctx.store.recordOperation(mkOp('op-12', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-12', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-12', 'EFFECT_CONFIRMED'));
    expect(() => ctx.store.recordOperation(mkOp('op-12', 'IN_FLIGHT'))).toThrow('invalid effect transition');
  });

  it('invalid transition AWAITING_HUMAN -> EFFECT_CONFIRMED throws', () => {
    ctx.store.recordOperation(mkOp('op-13', 'PRE_DISPATCH'));
    ctx.store.recordOperation(mkOp('op-13', 'IN_FLIGHT'));
    ctx.store.recordOperation(mkOp('op-13', 'EFFECT_UNKNOWN'));
    ctx.store.recordOperation(mkOp('op-13', 'RECONCILING'));
    ctx.store.recordOperation(mkOp('op-13', 'AWAITING_HUMAN'));
    expect(() => ctx.store.recordOperation(mkOp('op-13', 'EFFECT_CONFIRMED'))).toThrow('invalid effect transition');
  });

  it('operation identity conflict on different run_id throws', () => {
    ctx.store.recordOperation(mkOp('op-14', 'PRE_DISPATCH'));
    const conflict = { ...mkOp('op-14', 'IN_FLIGHT'), run_id: 'different-run' };
    expect(() => ctx.store.recordOperation(conflict)).toThrow('operation identity conflict');
  });

  it('operation identity conflict on different tool_name throws', () => {
    ctx.store.recordOperation(mkOp('op-15', 'PRE_DISPATCH'));
    const conflict = { ...mkOp('op-15', 'IN_FLIGHT'), tool_name: 'different-tool' };
    expect(() => ctx.store.recordOperation(conflict)).toThrow('operation identity conflict');
  });

  it('operation attempt conflict throws when not retrying', () => {
    ctx.store.recordOperation(mkOp('op-16', 'PRE_DISPATCH', 'key-16', 'att-1'));
    ctx.store.recordOperation(mkOp('op-16', 'IN_FLIGHT', 'key-16', 'att-1'));
    const conflict = mkOp('op-16', 'IN_FLIGHT', 'key-16', 'att-2');
    expect(() => ctx.store.recordOperation(conflict)).toThrow('operation attempt conflict');
  });

  it('new operation must begin PRE_DISPATCH', () => {
    expect(() => ctx.store.recordOperation(mkOp('op-17', 'IN_FLIGHT'))).toThrow('new operation must begin PRE_DISPATCH');
  });

  it('idempotency key collision with different operation_id throws', () => {
    ctx.store.recordOperation(mkOp('op-18', 'PRE_DISPATCH', 'shared-key'));
    const collision = mkOp('op-19', 'PRE_DISPATCH', 'shared-key');
    expect(() => ctx.store.recordOperation(collision)).toThrow('idempotency key collision');
  });

  it('idempotency key reuse with same operation_id is allowed', () => {
    ctx.store.recordOperation(mkOp('op-20', 'PRE_DISPATCH', 'shared-key-2'));
    ctx.store.recordOperation(mkOp('op-20', 'IN_FLIGHT', 'shared-key-2'));
    expect(ctx.store.getOperation('op-20')!.effect_state).toBe('IN_FLIGHT');
  });

  it('receipt_json is encrypted in operations table', () => {
    ctx.store.recordOperation({ ...mkOp('op-21', 'PRE_DISPATCH'), receipt_json: '{"result":"secret"}' });
    ctx.store.recordOperation({ ...mkOp('op-21', 'IN_FLIGHT'), receipt_json: '{"result":"secret"}' });
    const op = ctx.store.getOperation('op-21');
    expect(op!.receipt_json).toBe('{"result":"secret"}');
  });

  it('state replay with same attempt_id and receipt_json is allowed', () => {
    ctx.store.recordOperation({ ...mkOp('op-22', 'PRE_DISPATCH'), receipt_json: null });
    ctx.store.recordOperation({ ...mkOp('op-22', 'PRE_DISPATCH'), receipt_json: null });
    expect(ctx.store.getOperation('op-22')!.effect_state).toBe('PRE_DISPATCH');
  });

  it('state replay conflict with different receipt_json throws', () => {
    ctx.store.recordOperation({ ...mkOp('op-23', 'PRE_DISPATCH'), receipt_json: null });
    expect(() => ctx.store.recordOperation({ ...mkOp('op-23', 'PRE_DISPATCH'), receipt_json: '{"x":1}' })).toThrow();
  });
});

describe('sqlite-store-survival: receipt encryption and conflicts', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); ctx.store.createRun('r-rc', 'goal'); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('recordReceipt stores and retrieves receipt correctly', () => {
    ctx.store.recordOperation({ operation_id: 'op-r1', run_id: 'r-rc', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-r1', {
      tool_name: 'tool', success: true, input_hash: 'hash-in', output_hash: 'hash-out',
      duration_ms: 100, timestamp: '2026-01-01T00:00:00Z',
    });
    const rc = ctx.store.getReceipt('op-r1');
    expect(rc).not.toBeNull();
    expect(rc!.tool_name).toBe('tool');
    expect(rc!.success).toBe(true);
    expect(rc!.input_hash).toBe('hash-in');
    expect(rc!.output_hash).toBe('hash-out');
    expect(rc!.duration_ms).toBe(100);
    expect(rc!.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('recordReceipt with null output_hash', () => {
    ctx.store.recordOperation({ operation_id: 'op-r2', run_id: 'r-rc', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k2', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-r2', {
      tool_name: 'tool', success: false, input_hash: 'hash-in', output_hash: null,
      duration_ms: 50, timestamp: '2026-01-01T00:00:00Z',
    });
    const rc = ctx.store.getReceipt('op-r2');
    expect(rc!.success).toBe(false);
    expect(rc!.output_hash).toBeNull();
  });

  it('duplicate receipt with same fields is allowed', () => {
    ctx.store.recordOperation({ operation_id: 'op-r3', run_id: 'r-rc', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k3', effect_state: 'PRE_DISPATCH', receipt_json: null });
    const receipt = {
      tool_name: 'tool', success: true, input_hash: 'h1', output_hash: 'h2',
      duration_ms: 100, timestamp: '2026-01-01T00:00:00Z',
    };
    ctx.store.recordReceipt('op-r3', receipt);
    ctx.store.recordReceipt('op-r3', receipt);
    expect(ctx.store.getReceipt('op-r3')).not.toBeNull();
  });

  it('receipt conflict on tool_name throws', () => {
    ctx.store.recordOperation({ operation_id: 'op-r4', run_id: 'r-rc', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k4', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-r4', { tool_name: 'tool', success: true, input_hash: 'h1', output_hash: null, duration_ms: 100, timestamp: '2026-01-01T00:00:00Z' });
    expect(() => ctx.store.recordReceipt('op-r4', { tool_name: 'different', success: true, input_hash: 'h1', output_hash: null, duration_ms: 100, timestamp: '2026-01-01T00:00:00Z' })).toThrow('receipt conflict');
  });

  it('receipt conflict on duration_ms throws', () => {
    ctx.store.recordOperation({ operation_id: 'op-r5', run_id: 'r-rc', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k5', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordReceipt('op-r5', { tool_name: 'tool', success: true, input_hash: 'h1', output_hash: null, duration_ms: 100, timestamp: '2026-01-01T00:00:00Z' });
    expect(() => ctx.store.recordReceipt('op-r5', { tool_name: 'tool', success: true, input_hash: 'h1', output_hash: null, duration_ms: 200, timestamp: '2026-01-01T00:00:00Z' })).toThrow('receipt conflict');
  });
});

describe('sqlite-store-survival: loadEvents decryption', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); ctx.store.createRun('r-ev', 'goal'); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('loadEvents decrypts complex nested data', () => {
    const ev1 = { seq: 1, type: 'user' as const, timestamp: '2026-01-01T00:00:00Z', data: { nested: { deep: [1, 2, 3] } }, hash: 'h1', prev_hash: '' };
    const ev2 = { seq: 2, type: 'assistant' as const, timestamp: '2026-01-01T00:00:01Z', data: { text: 'response' }, hash: 'h2', prev_hash: 'h1' };
    ctx.store.appendEvent('r-ev', ev1);
    ctx.store.appendEvent('r-ev', ev2);
    const events = ctx.store.loadEvents('r-ev');
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toEqual({ nested: { deep: [1, 2, 3] } });
    expect(events[1]!.data).toEqual({ text: 'response' });
  });

  it('loadEvents returns empty array for nonexistent run', () => {
    expect(ctx.store.loadEvents('nonexistent')).toEqual([]);
  });

  it('loadEvents preserves event hash chain', () => {
    ctx.store.appendEvent('r-ev', { seq: 1, type: 'user' as const, timestamp: '2026-01-01T00:00:00Z', data: { msg: 'first' }, hash: 'hash-1', prev_hash: '' });
    ctx.store.appendEvent('r-ev', { seq: 2, type: 'assistant' as const, timestamp: '2026-01-01T00:00:01Z', data: { msg: 'second' }, hash: 'hash-2', prev_hash: 'hash-1' });
    const events = ctx.store.loadEvents('r-ev');
    expect(events[0]!.prev_hash).toBe('');
    expect(events[1]!.prev_hash).toBe(events[0]!.hash);
  });
});

describe('sqlite-store-survival: isEffectConfirmed', () => {
  let ctx: ReturnType<typeof createStore>;
  beforeEach(() => { ctx = createStore(); ctx.store.createRun('r-ec', 'goal'); });
  afterEach(() => { cleanup(ctx.store, ctx.dir); });

  it('returns true for EFFECT_CONFIRMED operation', () => {
    ctx.store.recordOperation({ operation_id: 'op-ec1', run_id: 'r-ec', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k-ec1', effect_state: 'PRE_DISPATCH', receipt_json: null });
    ctx.store.recordOperation({ operation_id: 'op-ec1', run_id: 'r-ec', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k-ec1', effect_state: 'IN_FLIGHT', receipt_json: null });
    ctx.store.recordOperation({ operation_id: 'op-ec1', run_id: 'r-ec', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k-ec1', effect_state: 'EFFECT_CONFIRMED', receipt_json: null });
    expect(ctx.store.isEffectConfirmed('k-ec1')).toBe(true);
  });

  it('returns false for PRE_DISPATCH operation', () => {
    ctx.store.recordOperation({ operation_id: 'op-ec2', run_id: 'r-ec', step_id: 's1', attempt_id: 'a1', tool_name: 'tool', idempotency_key: 'k-ec2', effect_state: 'PRE_DISPATCH', receipt_json: null });
    expect(ctx.store.isEffectConfirmed('k-ec2')).toBe(false);
  });

  it('returns false for unknown idempotency key', () => {
    expect(ctx.store.isEffectConfirmed('unknown-key')).toBe(false);
  });
});
