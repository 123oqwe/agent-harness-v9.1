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
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);

    // Prepare statements
    this._insertRun = this.db.prepare('INSERT OR REPLACE INTO runs (run_id, goal, strategy, status, created_at) VALUES (?, ?, ?, ?, ?)');
    this._insertEvent = this.db.prepare('INSERT OR IGNORE INTO events (seq, run_id, type, timestamp, data_json, hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this._insertSnapshot = this.db.prepare('INSERT OR REPLACE INTO snapshots (run_id, version, last_seq, last_hash, created_at, summary_json) VALUES (?, ?, ?, ?, ?, ?)');
    this._upsertOperation = this.db.prepare(`INSERT INTO operations (operation_id, run_id, step_id, attempt_id, tool_name, idempotency_key, effect_state, receipt_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this._insertReceipt = this.db.prepare('INSERT OR REPLACE INTO receipts (receipt_id, operation_id, tool_name, success, input_hash, output_hash, duration_ms, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this._getEvents = this.db.prepare('SELECT seq, type, timestamp, data_json, hash, prev_hash FROM events WHERE run_id = ? ORDER BY seq ASC');
    this._getOperation = this.db.prepare('SELECT * FROM operations WHERE operation_id = ?');
    this._getOperationByIdem = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?');
    this._updateOperation = this.db.prepare("UPDATE operations SET effect_state = ?, receipt_json = ?, updated_at = ? WHERE operation_id = ?");
  }

  private readonly _insertRun: Database.Statement;
  private readonly _insertEvent: Database.Statement;
  private readonly _insertSnapshot: Database.Statement;
  private readonly _upsertOperation: Database.Statement;
  private readonly _insertReceipt: Database.Statement;
  private readonly _getEvents: Database.Statement;
  private readonly _getOperation: Database.Statement;
  private readonly _getOperationByIdem: Database.Statement;
  private readonly _updateOperation: Database.Statement;

  /** Create a run record. */
  createRun(runId: string, goal: string, strategy?: string): void {
    this._insertRun.run(runId, goal, strategy ?? null, 'running', new Date().toISOString());
  }

  /** Persist a single event immediately (crash-safe). */
  appendEvent(runId: string, ev: SessionEvent): void {
    this._insertEvent.run(ev.seq, runId, ev.type, ev.timestamp, JSON.stringify(ev.data), ev.hash, ev.prev_hash);
  }

  /** Persist a snapshot. */
  saveSnapshot(runId: string, snap: SessionSnapshot): void {
    this._insertSnapshot.run(runId, snap.version, snap.last_seq, snap.last_hash, snap.created_at, JSON.stringify(snap.summary));
  }

 /** Record or update an operation with its effect state. */
 recordOperation(op: Omit<OperationRecord, 'created_at' | 'updated_at'>): void {
   // Check if operation exists by operation_id (update) or idempotency_key (reject duplicate)
   const existing = this._getOperation.get(op.operation_id) as OperationRecord | undefined;
   if (existing) {
     // Update existing operation
     const now = new Date().toISOString();
     this._updateOperation.run(op.effect_state, op.receipt_json, now, op.operation_id);
     return;
   }
   // Check idempotency key collision
   const existingByIdem = this._getOperationByIdem.get(op.idempotency_key) as OperationRecord | undefined;
   if (existingByIdem && existingByIdem.operation_id !== op.operation_id) {
     throw new Error(`idempotency key collision: ${op.idempotency_key} already used by operation ${existingByIdem.operation_id}`);
   }
   const now = new Date().toISOString();
   this._upsertOperation.run(op.operation_id, op.run_id, op.step_id, op.attempt_id, op.tool_name, op.idempotency_key, op.effect_state, op.receipt_json, now, now);
 }

  /** Attach a receipt to an operation. */
  recordReceipt(opId: string, receipt: Omit<ReceiptRecord, 'receipt_id' | 'operation_id'>): void {
    this._insertReceipt.run(randomUUID(), opId, receipt.tool_name, receipt.success ? 1 : 0, receipt.input_hash, receipt.output_hash ?? null, receipt.duration_ms, receipt.timestamp);
  }

  /** Get an operation by ID. */
  getOperation(opId: string): OperationRecord | null {
    const row = this._getOperation.get(opId) as OperationRecord | undefined;
    return row ?? null;
  }

  /** Get an operation by idempotency key (prevents duplicate side effects). */
  getOperationByIdempotencyKey(key: string): OperationRecord | null {
    const row = this._getOperationByIdem.get(key) as OperationRecord | undefined;
    return row ?? null;
  }

  /** Load all events for a run (crash recovery). */
  loadEvents(runId: string): SessionEvent[] {
    const rows = this._getEvents.all(runId) as Array<{ seq: number; type: SessionEventType; timestamp: string; data_json: string; hash: string; prev_hash: string }>;
    return rows.map(r => ({ seq: r.seq, type: r.type, timestamp: r.timestamp, data: JSON.parse(r.data_json), hash: r.hash, prev_hash: r.prev_hash }));
  }

  /** Check if an operation's effect is confirmed (prevents re-execution). */
  isEffectConfirmed(idempotencyKey: string): boolean {
    const op = this.getOperationByIdempotencyKey(idempotencyKey);
    return op?.effect_state === 'EFFECT_CONFIRMED';
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }
}
