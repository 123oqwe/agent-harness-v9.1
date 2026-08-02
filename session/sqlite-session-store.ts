/**
 * AH-RUNTIME-SESSION-001: SQLite-backed durable session store.
 *
 * Provides immediate per-event persistence to a SQLite database so that a
 * process crash mid-run loses zero confirmed effects. Tables: runs, events,
 * snapshots, operations, receipts. WAL mode + foreign keys + busy_timeout.
 *
 * The DurableSession class remains the in-memory authority; this store is the
 * durable backend that writes each event as it happens.
 */
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync } from 'node:fs';

import type { SessionEvent, SessionEventType, SessionSnapshot } from './durable-session.js';
import { launchTrustedPythonHost } from './trusted-python-host.js';
import {
  assertTrustedSessionStateRoot,
  resolveSessionDatabaseLocation,
  SessionStateRootError,
  type TrustedSessionStateRoot,
} from './session-state-root.js';
import {
  decryptSessionString,
  deriveSessionRecordKey,
  deriveSessionRecordKeyFromSalt,
  authenticateSessionRecordMaterial,
  ensureSessionRecordKeyCheck,
  encryptSessionString,
  hasSessionEncryptionEnvelope,
  insertCanonicalSessionEvent,
  validateDurableIdentifier,
} from './sqlite-authority-internals.js';

export interface OperationRecord {
  operation_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  tool_name: string;
  idempotency_key: string;
  effect_state: 'PRE_DISPATCH' | 'IN_FLIGHT' | 'EFFECT_UNKNOWN' | 'EFFECT_CONFIRMED' | 'DEFINITELY_FAILED_NO_EFFECT';
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceiptRecord {
  receipt_id: string;
  operation_id: string;
  tool_name: string;
  success: boolean;
  input_hash: string;
  output_hash: string | null;
  duration_ms: number;
  timestamp: string;
}

export interface RunRecord {
  run_id: string;
  goal: string;
  strategy: string | null;
  status: string;
  created_at: string;
}

export interface SqliteSessionStoreOptions {
  /** Caller-custodied device/master key. It is derived and never persisted. */
  masterKey: Uint8Array;
  /** Issued by the trusted composition root; agent-selected paths are invalid. */
  state_root: TrustedSessionStateRoot;
  /** @internal failure-only key-disposal test seam. */
  _test_after_record_key_derived?: () => void;
  /** @internal exposes only whether the disposed key is all-zero. */
  _test_on_record_key_disposed?: (allZero: boolean) => void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS metadata (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  goal          TEXT NOT NULL,
  strategy      TEXT,
  status        TEXT DEFAULT 'running',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_scopes (
  run_id        TEXT PRIMARY KEY REFERENCES runs(run_id),
  tenant_id     TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind = 'root'),
  UNIQUE (tenant_id, root_session_id, kind)
);

CREATE TABLE IF NOT EXISTS events (
  seq           INTEGER NOT NULL,
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  type          TEXT NOT NULL,
  timestamp     TEXT NOT NULL,
  data_json     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  prev_hash     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS snapshots (
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  version       INTEGER NOT NULL,
  last_seq      INTEGER NOT NULL,
  last_hash     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  summary_json  TEXT,
  PRIMARY KEY (run_id, version)
);

CREATE TABLE IF NOT EXISTS operations (
  operation_id  TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  step_id       TEXT NOT NULL,
  attempt_id    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  effect_state  TEXT NOT NULL DEFAULT 'PRE_DISPATCH',
  receipt_json  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id    TEXT PRIMARY KEY,
  operation_id  TEXT NOT NULL REFERENCES operations(operation_id),
  tool_name     TEXT NOT NULL,
  success       INTEGER NOT NULL,
  input_hash    TEXT NOT NULL,
  output_hash   TEXT,
  duration_ms   INTEGER,
  timestamp     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_operations_run ON operations(run_id);
CREATE INDEX IF NOT EXISTS idx_receipts_op ON receipts(operation_id);
`;

type SchemaObject = Readonly<{
  type: string;
  name: string;
  table: string;
  sql: string;
}>;

interface ExistingSessionPreflight {
  readonly parent_identity: Readonly<{ dev: number; ino: number }>;
  readonly main_identity: Readonly<{ dev: number; ino: number }>;
  readonly created: false;
  readonly schema: SchemaObject[];
  readonly salt: string;
  readonly sentinel: string | null;
  readonly legacy: Readonly<{ run_id: string; goal: string }> | null;
}

const SESSION_TREE_SCHEMA_FOR_PREFLIGHT = `
CREATE TABLE session_tree_scopes (
  tenant_id TEXT NOT NULL, root_session_id TEXT NOT NULL,
  tree_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id), created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, root_session_id)
);
CREATE TABLE session_tree_sessions (
  tenant_id TEXT NOT NULL, root_session_id TEXT NOT NULL, session_id TEXT NOT NULL,
  storage_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id), parent_session_id TEXT,
  depth INTEGER NOT NULL, security_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, root_session_id, session_id),
  FOREIGN KEY (tenant_id, root_session_id) REFERENCES session_tree_scopes(tenant_id, root_session_id)
);
CREATE TABLE session_tree_commands (
  tenant_id TEXT NOT NULL, root_session_id TEXT NOT NULL, command_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, event_seq INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, root_session_id, command_id),
  UNIQUE (tenant_id, root_session_id, child_session_id),
  FOREIGN KEY (tenant_id, root_session_id) REFERENCES session_tree_scopes(tenant_id, root_session_id)
);`;

function schemaObjects(db: Database.Database): SchemaObject[] {
  return (db
    .prepare(
      "SELECT type, name, tbl_name AS 'table', sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as SchemaObject[]).map((value) => ({
      ...value,
      sql: value.sql.replace(/\s+/gu, ' ').trim(),
    }));
}

let canonicalSchemaObjects: SchemaObject[] | undefined;
let canonicalSessionTreeObjects: SchemaObject[] | undefined;

function expectedSchemaObjects(): SchemaObject[] {
  if (canonicalSchemaObjects) return canonicalSchemaObjects;
  const canonical = new Database(':memory:');
  try {
    canonical.exec(SCHEMA);
    canonicalSchemaObjects = schemaObjects(canonical);
    return canonicalSchemaObjects;
  } finally {
    canonical.close();
  }
}

function expectedSessionTreeObjects(): SchemaObject[] {
  if (canonicalSessionTreeObjects) return canonicalSessionTreeObjects;
  const canonical = new Database(':memory:');
  try {
    canonical.exec('CREATE TABLE runs (run_id TEXT PRIMARY KEY)');
    canonical.exec(SESSION_TREE_SCHEMA_FOR_PREFLIGHT);
    canonicalSessionTreeObjects = schemaObjects(canonical).filter(
      (value) => value.name.startsWith('session_tree_') || value.table.startsWith('session_tree_'),
    );
    return canonicalSessionTreeObjects;
  } finally {
    canonical.close();
  }
}

export function validateSessionStoreSchema(db: Database.Database): void {
  validateSessionStoreSchemaObjects(schemaObjects(db));
}

function validateSessionStoreSchemaObjects(objects: readonly SchemaObject[]): void {
  const baseObjects = objects.map((value) => ({
    ...value,
    sql: value.sql.replace(/\s+/gu, ' ').trim(),
  })).filter(
    (value) => !value.name.startsWith('session_tree_'),
  );
  if (JSON.stringify(baseObjects) !== JSON.stringify(expectedSchemaObjects())) {
    throw new Error('session store schema is malformed');
  }
  const extensionObjects = objects
    .map((value) => ({ ...value, sql: value.sql.replace(/\s+/gu, ' ').trim() }))
    .filter(
      (value) => value.name.startsWith('session_tree_') || value.table.startsWith('session_tree_'),
    );
  if (
    extensionObjects.length > 0 &&
    JSON.stringify(extensionObjects) !== JSON.stringify(expectedSessionTreeObjects())
  ) {
    throw new Error('session store schema is malformed');
  }
}

export function preflightExistingSessionDatabase(
  dbPath: string,
  masterKey: Uint8Array,
  stateRoot: TrustedSessionStateRoot,
): ExistingSessionPreflight {
  const location = resolveSessionDatabaseLocation(dbPath, stateRoot);
  const value = launchTrustedPythonHost('sqlite_preflight', {
    request: {
      command: 'preflight',
      root: stateRoot.path,
      root_identity: stateRoot.identity,
      name: location.name,
    },
    requestKeys: ['command', 'root', 'root_identity', 'name'],
    responseKeys: [
      'ok', 'parent_identity', 'main_identity', 'created',
      'schema', 'salt', 'sentinel', 'legacy',
    ],
    timeoutMs: 15_000,
    maxOutputBytes: 4 * 1024 * 1024,
  }) as unknown as ExistingSessionPreflight & { ok: true };
  validateSessionStoreSchemaObjects(value.schema);
  const key = deriveSessionRecordKeyFromSalt(value.salt, masterKey);
  try {
    authenticateSessionRecordMaterial(key, value);
  } finally {
    key.fill(0);
  }
  return value;
}

function createSessionDatabaseFile(
  dbPath: string,
  stateRoot: TrustedSessionStateRoot,
): Readonly<{
  parent_identity: Readonly<{ dev: number; ino: number }>;
  main_identity: Readonly<{ dev: number; ino: number }>;
  created: true;
}> {
  const location = resolveSessionDatabaseLocation(dbPath, stateRoot);
  return launchTrustedPythonHost('sqlite_preflight', {
    request: {
      command: 'create',
      root: stateRoot.path,
      root_identity: stateRoot.identity,
      name: location.name,
    },
    requestKeys: ['command', 'root', 'root_identity', 'name'],
    responseKeys: ['ok', 'parent_identity', 'main_identity', 'created'],
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  }) as unknown as Readonly<{
    parent_identity: Readonly<{ dev: number; ino: number }>;
    main_identity: Readonly<{ dev: number; ino: number }>;
    created: true;
  }>;
}

export function assertSessionDatabaseIdentity(
  dbPath: string,
  stateRoot: TrustedSessionStateRoot,
  expected: Readonly<{
    parent_identity: Readonly<{ dev: number; ino: number }>;
    main_identity: Readonly<{ dev: number; ino: number }>;
  }>,
): void {
  assertTrustedSessionStateRoot(stateRoot);
  const current = lstatSync(dbPath);
  if (
    stateRoot.identity.dev !== expected.parent_identity.dev ||
    stateRoot.identity.ino !== expected.parent_identity.ino ||
    !current.isFile() ||
    current.dev !== expected.main_identity.dev ||
    current.ino !== expected.main_identity.ino
  ) {
    throw new SessionStateRootError(
      'DATABASE_IDENTITY_CHANGED',
      'session database identity changed before SQLite initialization',
    );
  }
}

export class SqliteSessionStore {
  private readonly db: Database.Database;
  private readonly recordKey: Buffer;

  constructor(dbPath: string, options: SqliteSessionStoreOptions) {
    if (
      options?.masterKey === undefined ||
      options.masterKey.byteLength !== 32
    ) {
      throw new Error('32-byte masterKey is required');
    }
    assertTrustedSessionStateRoot(options.state_root);
    const location = resolveSessionDatabaseLocation(dbPath, options.state_root);
    const existingDatabase = existsSync(location.path);
    const expectedIdentity = existingDatabase
      ? preflightExistingSessionDatabase(location.path, options.masterKey, options.state_root)
      : createSessionDatabaseFile(location.path, options.state_root);
    this.db = new Database(location.path);
    // This is deliberately the first operation after the pathname-only SQLite
    // open. No chmod, pragma, schema, WAL, or metadata write precedes it.
    try {
      assertSessionDatabaseIdentity(location.path, options.state_root, expectedIdentity);
    } catch (error) {
      this.db.close();
      throw error;
    }
    chmodSync(location.path, 0o600);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const isNewDatabase = !existingDatabase;
    if (isNewDatabase) {
      this.db.exec(SCHEMA);
    }

    // Prepare statements
    this._getMetadata = this.db.prepare(
      'SELECT value FROM metadata WHERE key = ?',
    );
    this._insertMetadata = this.db.prepare(
      'INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)',
    );
    const existingSalt = this._getMetadata.get('encryption_salt') as
      | { value: string }
      | undefined;
    if (!existingSalt && isNewDatabase) {
      this._insertMetadata.run(
        'encryption_salt',
        randomBytes(32).toString('base64'),
      );
    }
    const saltRow = this._getMetadata.get('encryption_salt') as
      | { value: string }
      | undefined;
    if (!saltRow) {
      this.db.close();
      throw new Error('session encryption salt unavailable');
    }
    let derivedRecordKey: Buffer | undefined;
    try {
      derivedRecordKey = deriveSessionRecordKey(this.db, options.masterKey);
      options._test_after_record_key_derived?.();
      ensureSessionRecordKeyCheck(this.db, derivedRecordKey);
      validateSessionStoreSchema(this.db);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('wal_checkpoint(PASSIVE)');
      this.recordKey = derivedRecordKey;
      derivedRecordKey = undefined;
    } catch (error) {
      if (derivedRecordKey) {
        derivedRecordKey.fill(0);
        options._test_on_record_key_disposed?.(
          derivedRecordKey.every((value) => value === 0),
        );
      }
      this.db.close();
      throw error;
    }
    this._insertRun = this.db.prepare('INSERT OR IGNORE INTO runs (run_id, goal, strategy, status, created_at) VALUES (?, ?, ?, ?, ?)');
    this._getRun = this.db.prepare('SELECT * FROM runs WHERE run_id = ?');
    this._updateRunStatus = this.db.prepare('UPDATE runs SET status = ? WHERE run_id = ?');
    this._getEvent = this.db.prepare('SELECT seq, type, timestamp, data_json, hash, prev_hash FROM events WHERE run_id = ? AND seq = ?');
    this._insertSnapshot = this.db.prepare('INSERT OR REPLACE INTO snapshots (run_id, version, last_seq, last_hash, created_at, summary_json) VALUES (?, ?, ?, ?, ?, ?)');
    this._getLatestSnapshot = this.db.prepare(
      'SELECT run_id AS session_id, version, last_seq, last_hash, created_at, summary_json FROM snapshots WHERE run_id = ? ORDER BY version DESC LIMIT 1',
    );
    this._upsertOperation = this.db.prepare(`INSERT INTO operations (operation_id, run_id, step_id, attempt_id, tool_name, idempotency_key, effect_state, receipt_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this._insertReceipt = this.db.prepare('INSERT INTO receipts (receipt_id, operation_id, tool_name, success, input_hash, output_hash, duration_ms, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this._getReceiptByOperation = this.db.prepare('SELECT * FROM receipts WHERE operation_id = ? ORDER BY timestamp DESC LIMIT 1');
    this._getEvents = this.db.prepare('SELECT seq, type, timestamp, data_json, hash, prev_hash FROM events WHERE run_id = ? ORDER BY seq ASC');
    this._getOperation = this.db.prepare('SELECT * FROM operations WHERE operation_id = ?');
    this._getOperationByIdem = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?');
    this._listOperations = this.db.prepare(
      'SELECT * FROM operations WHERE run_id = ? ORDER BY created_at, operation_id',
    );
    this._updateOperation = this.db.prepare("UPDATE operations SET attempt_id = ?, effect_state = ?, receipt_json = ?, updated_at = ? WHERE operation_id = ?");
  }

  private readonly _getMetadata: Database.Statement;
  private readonly _insertMetadata: Database.Statement;
  private readonly _insertRun: Database.Statement;
  private readonly _getRun: Database.Statement;
  private readonly _updateRunStatus: Database.Statement;
  private readonly _getEvent: Database.Statement;
  private readonly _insertSnapshot: Database.Statement;
  private readonly _getLatestSnapshot: Database.Statement;
  private readonly _upsertOperation: Database.Statement;
  private readonly _insertReceipt: Database.Statement;
  private readonly _getReceiptByOperation: Database.Statement;
  private readonly _getEvents: Database.Statement;
  private readonly _getOperation: Database.Statement;
  private readonly _getOperationByIdem: Database.Statement;
  private readonly _listOperations: Database.Statement;
  private readonly _updateOperation: Database.Statement;
  private closed = false;

  private encryptString(value: string, associatedData: string): string {
    return encryptSessionString(this.recordKey, value, associatedData);
  }

  private decryptString(value: string, associatedData: string): string {
    if (!hasSessionEncryptionEnvelope(value)) {
      throw new Error('unencrypted session field rejected');
    }
    try {
      return decryptSessionString(this.recordKey, value, associatedData);
    } catch {
      throw new Error('session field authentication failed');
    }
  }

  private decryptOperation(row: OperationRecord): OperationRecord {
    return {
      ...row,
      receipt_json:
        row.receipt_json === null
          ? null
          : this.decryptString(
              row.receipt_json,
              `operations:${row.operation_id}:receipt_json`,
            ),
    };
  }

  /** Create a run record. */
  createRun(runId: string, goal: string, strategy?: string): boolean {
    validateDurableIdentifier('run_id', runId);
    const result = this._insertRun.run(
      runId,
      this.encryptString(goal, `runs:${runId}:goal`),
      strategy ?? null,
      'running',
      new Date().toISOString(),
    );
    const existing = this.getRun(runId);
    if (
      !existing ||
      existing.goal !== goal ||
      existing.strategy !== (strategy ?? null)
    ) {
      throw new Error(`run identity conflict: ${runId}`);
    }
    return result.changes === 1;
  }

  /**
   * Create a root run and its tenant/root ownership in one transaction.
   * Generic createRun() intentionally does not grant SessionTree bind rights.
   */
  createScopedRun(
    scope: Readonly<{ tenant_id: string; root_session_id: string }>,
    runId: string,
    goal: string,
    strategy?: string,
  ): boolean {
    if (
      !scope ||
      scope.tenant_id.trim().length === 0 ||
      scope.root_session_id.trim().length === 0
    ) {
      throw new Error('run scope is required');
    }
    validateDurableIdentifier('tenant_id', scope.tenant_id);
    validateDurableIdentifier('root_session_id', scope.root_session_id);
    validateDurableIdentifier('run_id', runId);
    if (runId !== scope.root_session_id) {
      throw new Error('root run identity must equal root_session_id');
    }
    return this.db.transaction(() => {
      const created = this.createRun(runId, goal, strategy);
      const existing = this.db
        .prepare(
          'SELECT tenant_id, root_session_id, kind FROM run_scopes WHERE run_id = ?',
        )
        .get(runId) as
        | { tenant_id: string; root_session_id: string; kind: string }
        | undefined;
      if (existing) {
        if (
          existing.tenant_id !== scope.tenant_id ||
          existing.root_session_id !== scope.root_session_id ||
          existing.kind !== 'root'
        ) {
          throw new Error(`run scope conflict: ${runId}`);
        }
        return created;
      }
      if (!created) {
        throw new Error('pre-existing generic run cannot be claimed');
      }
      this.db
        .prepare(
          "INSERT INTO run_scopes (run_id, tenant_id, root_session_id, kind) VALUES (?, ?, ?, 'root')",
        )
        .run(runId, scope.tenant_id, scope.root_session_id);
      return created;
    })();
  }

  getRun(runId: string): RunRecord | null {
    validateDurableIdentifier('run_id', runId);
    const row = this._getRun.get(runId) as RunRecord | undefined;
    if (!row) return null;
    return {
      ...row,
      goal: this.decryptString(row.goal, `runs:${runId}:goal`),
    };
  }

  updateRunStatus(runId: string, status: string): void {
    validateDurableIdentifier('run_id', runId);
    if (!this.getRun(runId)) throw new Error(`run not found: ${runId}`);
    this._updateRunStatus.run(status, runId);
  }

  /** Persist a single event immediately (crash-safe). */
  appendEvent(runId: string, ev: SessionEvent): void {
    validateDurableIdentifier('run_id', runId);
    const existing = this._getEvent.get(runId, ev.seq) as
      | {
          seq: number;
          type: SessionEventType;
          timestamp: string;
          data_json: string;
          hash: string;
          prev_hash: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.type !== ev.type ||
        existing.timestamp !== ev.timestamp ||
        this.decryptString(
          existing.data_json,
          `events:${runId}:${ev.seq}:data_json`,
        ) !== JSON.stringify(ev.data) ||
        existing.hash !== ev.hash ||
        existing.prev_hash !== ev.prev_hash
      ) {
        throw new Error(`event conflict at ${runId}:${ev.seq}`);
      }
      return;
    }
    insertCanonicalSessionEvent(this.db, this.recordKey, runId, ev);
  }

  /** Persist a snapshot. */
  saveSnapshot(runId: string, snap: SessionSnapshot): void {
    validateDurableIdentifier('run_id', runId);
    if (snap.session_id !== runId) {
      throw new Error(`snapshot identity conflict: ${runId}`);
    }
    this._insertSnapshot.run(
      runId,
      snap.version,
      snap.last_seq,
      snap.last_hash,
      snap.created_at,
      this.encryptString(
        JSON.stringify(snap.summary),
        `snapshots:${runId}:${snap.version}:summary_json`,
      ),
    );
  }

  getLatestSnapshot(runId: string): SessionSnapshot | null {
    validateDurableIdentifier('run_id', runId);
    const row = this._getLatestSnapshot.get(runId) as
      | (Omit<SessionSnapshot, 'summary'> & { summary_json: string })
      | undefined;
    if (!row) return null;
    return {
      session_id: row.session_id,
      version: row.version,
      last_seq: row.last_seq,
      last_hash: row.last_hash,
      created_at: row.created_at,
      summary: JSON.parse(
        this.decryptString(
          row.summary_json,
          `snapshots:${runId}:${row.version}:summary_json`,
        ),
      ),
    };
  }

 /** Record or update an operation with its effect state. */
 recordOperation(op: Omit<OperationRecord, 'created_at' | 'updated_at'>): void {
   validateDurableIdentifier('operation_id', op.operation_id);
   validateDurableIdentifier('run_id', op.run_id);
   validateDurableIdentifier('step_id', op.step_id);
   validateDurableIdentifier('attempt_id', op.attempt_id);
   validateDurableIdentifier('tool_name', op.tool_name);
   validateDurableIdentifier('idempotency_key', op.idempotency_key);
   // Check if operation exists by operation_id (update) or idempotency_key (reject duplicate)
   const existing = this.getOperation(op.operation_id);
   if (existing) {
     if (
       existing.run_id !== op.run_id ||
       existing.step_id !== op.step_id ||
       existing.tool_name !== op.tool_name ||
       existing.idempotency_key !== op.idempotency_key
     ) {
       throw new Error(`operation identity conflict: ${op.operation_id}`);
     }
     const retrying =
       existing.effect_state === 'DEFINITELY_FAILED_NO_EFFECT' &&
       op.effect_state === 'PRE_DISPATCH';
     if (existing.attempt_id !== op.attempt_id && !retrying) {
       throw new Error(`operation attempt conflict: ${op.operation_id}`);
     }
     if (existing.effect_state === op.effect_state) {
       if (
         existing.attempt_id !== op.attempt_id ||
         existing.receipt_json !== op.receipt_json
       ) {
         throw new Error(`operation state replay conflict: ${op.operation_id}`);
       }
       return;
     }
     const allowed: Record<OperationRecord['effect_state'], readonly OperationRecord['effect_state'][]> = {
       PRE_DISPATCH: ['IN_FLIGHT', 'DEFINITELY_FAILED_NO_EFFECT'],
       IN_FLIGHT: ['EFFECT_CONFIRMED', 'EFFECT_UNKNOWN', 'DEFINITELY_FAILED_NO_EFFECT'],
       EFFECT_UNKNOWN: [],
       EFFECT_CONFIRMED: [],
       DEFINITELY_FAILED_NO_EFFECT: ['PRE_DISPATCH'],
     };
     if (
       existing.effect_state !== op.effect_state &&
       !allowed[existing.effect_state].includes(op.effect_state)
     ) {
       throw new Error(
         `invalid effect transition: ${existing.effect_state} -> ${op.effect_state}`,
       );
     }
     const now = new Date().toISOString();
     this._updateOperation.run(
       op.attempt_id,
       op.effect_state,
       op.receipt_json === null
         ? null
         : this.encryptString(
             op.receipt_json,
             `operations:${op.operation_id}:receipt_json`,
           ),
       now,
       op.operation_id,
     );
     return;
   }
   if (op.effect_state !== 'PRE_DISPATCH') {
     throw new Error('new operation must begin PRE_DISPATCH');
   }
   // Check idempotency key collision
   const existingByIdem = this.getOperationByIdempotencyKey(op.idempotency_key);
   if (existingByIdem && existingByIdem.operation_id !== op.operation_id) {
     throw new Error(`idempotency key collision: ${op.idempotency_key} already used by operation ${existingByIdem.operation_id}`);
   }
   const now = new Date().toISOString();
   this._upsertOperation.run(
     op.operation_id,
     op.run_id,
     op.step_id,
     op.attempt_id,
     op.tool_name,
     op.idempotency_key,
     op.effect_state,
     op.receipt_json === null
       ? null
       : this.encryptString(
           op.receipt_json,
           `operations:${op.operation_id}:receipt_json`,
         ),
     now,
     now,
   );
 }

  /** Attach a receipt to an operation. */
  recordReceipt(opId: string, receipt: Omit<ReceiptRecord, 'receipt_id' | 'operation_id'>): void {
    validateDurableIdentifier('operation_id', opId);
    const existing = this.getReceipt(opId);
    if (existing) {
      if (
        existing.tool_name !== receipt.tool_name ||
        existing.success !== receipt.success ||
        existing.input_hash !== receipt.input_hash ||
        existing.output_hash !== (receipt.output_hash ?? null) ||
        existing.duration_ms !== receipt.duration_ms ||
        existing.timestamp !== receipt.timestamp
      ) {
        throw new Error(`receipt conflict for operation: ${opId}`);
      }
      return;
    }
    this._insertReceipt.run(randomUUID(), opId, receipt.tool_name, receipt.success ? 1 : 0, receipt.input_hash, receipt.output_hash ?? null, receipt.duration_ms, receipt.timestamp);
  }

  getReceipt(opId: string): ReceiptRecord | null {
    validateDurableIdentifier('operation_id', opId);
    const row = this._getReceiptByOperation.get(opId) as
      | (Omit<ReceiptRecord, 'success'> & { success: number })
      | undefined;
    return row ? { ...row, success: row.success === 1 } : null;
  }

  /** Get an operation by ID. */
  getOperation(opId: string): OperationRecord | null {
    validateDurableIdentifier('operation_id', opId);
    const row = this._getOperation.get(opId) as OperationRecord | undefined;
    return row ? this.decryptOperation(row) : null;
  }

  /** Get an operation by idempotency key (prevents duplicate side effects). */
  getOperationByIdempotencyKey(key: string): OperationRecord | null {
    validateDurableIdentifier('idempotency_key', key);
    const row = this._getOperationByIdem.get(key) as OperationRecord | undefined;
    return row ? this.decryptOperation(row) : null;
  }

  listOperations(runId: string): readonly OperationRecord[] {
    validateDurableIdentifier('run_id', runId);
    return Object.freeze(
      (this._listOperations.all(runId) as OperationRecord[]).map((row) =>
        Object.freeze(this.decryptOperation(row)),
      ),
    );
  }

  /** Load all events for a run (crash recovery). */
  loadEvents(runId: string): SessionEvent[] {
    validateDurableIdentifier('run_id', runId);
    const rows = this._getEvents.all(runId) as Array<{ seq: number; type: SessionEventType; timestamp: string; data_json: string; hash: string; prev_hash: string }>;
    return rows.map(r => ({
      seq: r.seq,
      type: r.type,
      timestamp: r.timestamp,
      data: JSON.parse(
        this.decryptString(
          r.data_json,
          `events:${runId}:${r.seq}:data_json`,
        ),
      ),
      hash: r.hash,
      prev_hash: r.prev_hash,
    }));
  }

  /** Check if an operation's effect is confirmed (prevents re-execution). */
  isEffectConfirmed(idempotencyKey: string): boolean {
    const op = this.getOperationByIdempotencyKey(idempotencyKey);
    return op?.effect_state === 'EFFECT_CONFIRMED';
  }

  /** Close the database. */
  close(): void {
    if (this.closed) return;
    try {
      this.db.close();
    } finally {
      this.recordKey.fill(0);
      this.closed = true;
    }
  }
}
