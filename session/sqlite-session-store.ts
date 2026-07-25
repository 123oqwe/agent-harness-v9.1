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
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SessionEvent, SessionEventType, SessionSnapshot } from './durable-session.js';

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
}

const ENCRYPTION_PREFIX = 'ahenc:v1';
const KEY_DERIVATION_CONTEXT = 'agent-harness/session-store/v1';

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
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);

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
    if (!existingSalt) {
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
    const salt = Buffer.from(saltRow.value, 'base64');
    if (salt.byteLength !== 32) {
      this.db.close();
      throw new Error('session encryption salt invalid');
    }
    const suppliedKey = Buffer.from(options.masterKey);
    try {
      this.recordKey = Buffer.from(
        hkdfSync(
          'sha256',
          suppliedKey,
          salt,
          KEY_DERIVATION_CONTEXT,
          32,
        ),
      );
    } finally {
      suppliedKey.fill(0);
      salt.fill(0);
    }
    this._insertRun = this.db.prepare('INSERT OR IGNORE INTO runs (run_id, goal, strategy, status, created_at) VALUES (?, ?, ?, ?, ?)');
    this._getRun = this.db.prepare('SELECT * FROM runs WHERE run_id = ?');
    this._updateRunStatus = this.db.prepare('UPDATE runs SET status = ? WHERE run_id = ?');
    this._getEvent = this.db.prepare('SELECT seq, type, timestamp, data_json, hash, prev_hash FROM events WHERE run_id = ? AND seq = ?');
    this._insertEvent = this.db.prepare('INSERT OR IGNORE INTO events (seq, run_id, type, timestamp, data_json, hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
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
  private readonly _insertEvent: Database.Statement;
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
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.recordKey, nonce);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      ENCRYPTION_PREFIX,
      nonce.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  private decryptString(value: string, associatedData: string): string {
    const parts = value.split(':');
    if (
      parts.length !== 5 ||
      `${parts[0]}:${parts[1]}` !== ENCRYPTION_PREFIX
    ) {
      throw new Error('unencrypted session field rejected');
    }
    try {
      const nonce = Buffer.from(parts[2]!, 'base64');
      const tag = Buffer.from(parts[3]!, 'base64');
      const ciphertext = Buffer.from(parts[4]!, 'base64');
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
        throw new Error('invalid encrypted envelope');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.recordKey,
        nonce,
      );
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
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

  getRun(runId: string): RunRecord | null {
    const row = this._getRun.get(runId) as RunRecord | undefined;
    if (!row) return null;
    return {
      ...row,
      goal: this.decryptString(row.goal, `runs:${runId}:goal`),
    };
  }

  updateRunStatus(runId: string, status: string): void {
    if (!this.getRun(runId)) throw new Error(`run not found: ${runId}`);
    this._updateRunStatus.run(status, runId);
  }

  /** Persist a single event immediately (crash-safe). */
  appendEvent(runId: string, ev: SessionEvent): void {
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
    this._insertEvent.run(
      ev.seq,
      runId,
      ev.type,
      ev.timestamp,
      this.encryptString(
        JSON.stringify(ev.data),
        `events:${runId}:${ev.seq}:data_json`,
      ),
      ev.hash,
      ev.prev_hash,
    );
  }

  /** Persist a snapshot. */
  saveSnapshot(runId: string, snap: SessionSnapshot): void {
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
    const row = this._getReceiptByOperation.get(opId) as
      | (Omit<ReceiptRecord, 'success'> & { success: number })
      | undefined;
    return row ? { ...row, success: row.success === 1 } : null;
  }

  /** Get an operation by ID. */
  getOperation(opId: string): OperationRecord | null {
    const row = this._getOperation.get(opId) as OperationRecord | undefined;
    return row ? this.decryptOperation(row) : null;
  }

  /** Get an operation by idempotency key (prevents duplicate side effects). */
  getOperationByIdempotencyKey(key: string): OperationRecord | null {
    const row = this._getOperationByIdem.get(key) as OperationRecord | undefined;
    return row ? this.decryptOperation(row) : null;
  }

  listOperations(runId: string): readonly OperationRecord[] {
    return Object.freeze(
      (this._listOperations.all(runId) as OperationRecord[]).map((row) =>
        Object.freeze(this.decryptOperation(row)),
      ),
    );
  }

  /** Load all events for a run (crash recovery). */
  loadEvents(runId: string): SessionEvent[] {
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
