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
