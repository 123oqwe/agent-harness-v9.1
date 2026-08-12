import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, lstatSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  SqliteSessionStore,
  validateSessionStoreSchema,
  assertSessionDatabaseIdentity,
  type RunRecord,
} from '../../session/sqlite-session-store.js';
import {
  createTrustedSessionStateRoot,
  type TrustedSessionStateRoot,
  SessionStateRootError,
} from '../../session/session-state-root.js';

const MASTER_KEY = Buffer.alloc(32, 0x5a);

describe('validateSessionStoreSchema', () => {
  let dir: string;
  let stateRoot: TrustedSessionStateRoot;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ah-schema-'));
    stateRoot = createTrustedSessionStateRoot(dir);
    store = new SqliteSessionStore(join(dir, 'session.db'), {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes for a freshly created store database', () => {
    const db = new Database(join(dir, 'session.db'));
    expect(() => validateSessionStoreSchema(db)).not.toThrow();
    db.close();
  });

  it('throws when a base table is missing', () => {
    const db = new Database(join(dir, 'session.db'));
    db.exec('DROP TABLE operations');
    expect(() => validateSessionStoreSchema(db)).toThrow('session store schema is malformed');
    db.close();
  });

  it('throws when a base table has wrong sql', () => {
    const db = new Database(join(dir, 'session.db'));
    db.exec('DROP TABLE operations');
    db.exec('CREATE TABLE operations (wrong_column TEXT)');
    expect(() => validateSessionStoreSchema(db)).toThrow('session store schema is malformed');
    db.close();
  });

  it('throws when an index is missing', () => {
    const db = new Database(join(dir, 'session.db'));
    db.exec('DROP INDEX idx_operations_run');
    expect(() => validateSessionStoreSchema(db)).toThrow('session store schema is malformed');
    db.close();
  });

  it('throws when session_tree extension tables have wrong schema', () => {
    const db = new Database(join(dir, 'session.db'));
    db.exec('CREATE TABLE session_tree_scopes (wrong_schema TEXT)');
    expect(() => validateSessionStoreSchema(db)).toThrow('session store schema is malformed');
    db.close();
  });
});

describe('assertSessionDatabaseIdentity', () => {
  let dir: string;
  let stateRoot: TrustedSessionStateRoot;
  let store: SqliteSessionStore;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ah-identity-'));
    stateRoot = createTrustedSessionStateRoot(dir);
    dbPath = join(dir, 'session.db');
    store = new SqliteSessionStore(dbPath, {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when identity matches', () => {
    const stat = lstatSync(dbPath);
    expect(() => assertSessionDatabaseIdentity(dbPath, stateRoot, {
      parent_identity: stateRoot.identity,
      main_identity: { dev: stat.dev, ino: stat.ino },
    })).not.toThrow();
  });

  it('throws DATABASE_IDENTITY_CHANGED when main dev differs', () => {
    const stat = lstatSync(dbPath);
    const fn = () => assertSessionDatabaseIdentity(dbPath, stateRoot, {
      parent_identity: stateRoot.identity,
      main_identity: { dev: stat.dev + 1, ino: stat.ino },
    });
    expect(fn).toThrow(SessionStateRootError);
    try { fn(); } catch (e) {
      expect((e as SessionStateRootError).code).toBe('DATABASE_IDENTITY_CHANGED');
      expect((e as Error).message).toBe('session database identity changed before SQLite initialization');
    }
  });

  it('throws DATABASE_IDENTITY_CHANGED when main ino differs', () => {
    const stat = lstatSync(dbPath);
    const fn2 = () => assertSessionDatabaseIdentity(dbPath, stateRoot, {
      parent_identity: stateRoot.identity,
      main_identity: { dev: stat.dev, ino: stat.ino + 1 },
    });
    expect(fn2).toThrow(SessionStateRootError);
    try { fn2(); } catch (e) {
      expect((e as SessionStateRootError).code).toBe('DATABASE_IDENTITY_CHANGED');
      expect((e as Error).message).toBe('session database identity changed before SQLite initialization');
    }
  });

  it('throws DATABASE_IDENTITY_CHANGED when parent dev differs', () => {
    const stat = lstatSync(dbPath);
    expect(() => assertSessionDatabaseIdentity(dbPath, stateRoot, {
      parent_identity: { dev: stateRoot.identity.dev + 1, ino: stateRoot.identity.ino },
      main_identity: { dev: stat.dev, ino: stat.ino },
    })).toThrow(SessionStateRootError);
  });

  it('throws DATABASE_IDENTITY_CHANGED when parent ino differs', () => {
    const stat = lstatSync(dbPath);
    expect(() => assertSessionDatabaseIdentity(dbPath, stateRoot, {
      parent_identity: { dev: stateRoot.identity.dev, ino: stateRoot.identity.ino + 1 },
      main_identity: { dev: stat.dev, ino: stat.ino },
    })).toThrow(SessionStateRootError);
  });

  it('throws when database is not a file', () => {
    // Pass a directory path as dbPath
    expect(() => assertSessionDatabaseIdentity(dir, stateRoot, {
      parent_identity: stateRoot.identity,
      main_identity: stateRoot.identity,
    })).toThrow(SessionStateRootError);
  });
});

describe('SqliteSessionStore additional state transitions', () => {
  let dir: string;
  let stateRoot: TrustedSessionStateRoot;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ah-state-'));
    stateRoot = createTrustedSessionStateRoot(dir);
    store = new SqliteSessionStore(join(dir, 'session.db'), {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('createScopedRun with whitespace-only tenant_id throws', () => {
    expect(() => store.createScopedRun(
      { tenant_id: '   ', root_session_id: 'run-1' } as any,
      'run-1', 'goal', 'direct',
    )).toThrow('run scope is required');
  });

  it('createScopedRun with whitespace-only root_session_id throws', () => {
    expect(() => store.createScopedRun(
      { tenant_id: 'tenant-1', root_session_id: '  ' } as any,
      'run-1', 'goal', 'direct',
    )).toThrow('run scope is required');
  });

  it('createScopedRun with null scope throws', () => {
    expect(() => store.createScopedRun(null as any, 'run-1', 'goal', 'direct')).toThrow();
  });

  it('upsertOperation transitions from PRE_DISPATCH to DISPATCHING', () => {
    store.createRun('r1', 'goal', 'direct');
    const op = {
      operation_id: 'op-1', run_id: 'r1', step_id: 's1',
      attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1',
      effect_state: 'PRE_DISPATCH' as const, receipt_json: null,
    };
    store.recordOperation(op);
    store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
    // Should not throw — valid transition
  });

  it('upsertOperation rejects invalid state transition', () => {
    store.createRun('r1', 'goal', 'direct');
    const op = {
      operation_id: 'op-1', run_id: 'r1', step_id: 's1',
      attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1',
      effect_state: 'PRE_DISPATCH' as const, receipt_json: null,
    };
    store.recordOperation(op);
    // Try invalid transition: PRE_DISPATCH → EFFECT_CONFIRMED (skipping IN_FLIGHT)
    expect(() => store.recordOperation({
      ...op, effect_state: 'EFFECT_CONFIRMED' as const,
    })).toThrow();
  });

  it('recordReceipt stores receipt and allows idempotent re-record', () => {
    store.createRun('r1', 'goal', 'direct');
    store.recordOperation({
      operation_id: 'op-1', run_id: 'r1', step_id: 's1',
      attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1',
      effect_state: 'PRE_DISPATCH' as const, receipt_json: null,
    });
    const receipt = {
      tool_name: 'test', success: true, input_hash: 'h1',
      output_hash: 'oh1', duration_ms: 100, timestamp: '2026-01-01T00:00:00Z',
    };
    store.recordReceipt('op-1', receipt);
    // Idempotent re-record with same data should not throw
    store.recordReceipt('op-1', receipt);
  });

  it('recordReceipt throws on conflicting receipt data', () => {
    store.createRun('r1', 'goal', 'direct');
    store.recordOperation({
      operation_id: 'op-1', run_id: 'r1', step_id: 's1',
      attempt_id: 'a1', tool_name: 'test', idempotency_key: 'k1',
      effect_state: 'PRE_DISPATCH' as const, receipt_json: null,
    });
    const receipt = {
      tool_name: 'test', success: true, input_hash: 'h1',
      output_hash: 'oh1', duration_ms: 100, timestamp: '2026-01-01T00:00:00Z',
    };
    store.recordReceipt('op-1', receipt);
    // Conflicting receipt
    expect(() => store.recordReceipt('op-1', { ...receipt, tool_name: 'different' })).toThrow('receipt conflict');
  });

  it('getRun returns null for non-existent run', () => {
    expect(store.getRun('nonexistent-run')).toBeNull();
  });

  it('createRun creates a new run record', () => {
    store.createRun('test-run', 'test goal', 'direct');
    const run = store.getRun('test-run');
    expect(run).not.toBeNull();
    expect(run!.run_id).toBe('test-run');
    expect(run!.goal).toBe('test goal');
    expect(run!.status).toBe('running');
  });

  it('updateRunStatus changes status', () => {
    store.createRun('test-run', 'goal', 'direct');
    store.updateRunStatus('test-run', 'completed');
    const run = store.getRun('test-run');
    expect(run!.status).toBe('completed');
  });
});
