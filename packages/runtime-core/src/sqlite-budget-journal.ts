import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  BudgetEvent,
  BudgetJournalPort,
  BudgetScope,
} from "./budget-ledger.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS budget_journal (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  call_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id, session_id, sequence),
  UNIQUE (tenant_id, run_id, session_id, call_id)
);
`;

function requiredId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

function validateScope(scope: BudgetScope): void {
  requiredId("tenant_id", scope?.tenant_id);
  requiredId("run_id", scope?.run_id);
  requiredId("session_id", scope?.session_id);
}

interface StoredBudgetRow {
  readonly sequence: number;
  readonly event_json: string;
}

/** Durable append-only storage for the unique BudgetLedger authority. */
export class SqliteBudgetJournal implements BudgetJournalPort {
  readonly #database: Database.Database;
  readonly #scope: BudgetScope;
  #closed = false;

  constructor(databasePath: string, scope: BudgetScope) {
    requiredId("databasePath", databasePath);
    validateScope(scope);
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    this.#database.exec(SCHEMA);
    this.#scope = Object.freeze({ ...scope });
  }

  read(): readonly BudgetEvent[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT sequence, event_json
           FROM budget_journal
          WHERE tenant_id = ? AND run_id = ? AND session_id = ?
          ORDER BY sequence ASC`,
      )
      .all(
        this.#scope.tenant_id,
        this.#scope.run_id,
        this.#scope.session_id,
      ) as StoredBudgetRow[];
    return rows.map((row) => {
      let event: unknown;
      try {
        event = JSON.parse(row.event_json);
      } catch {
        throw new Error("budget journal contains invalid JSON");
      }
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        throw new Error("budget journal contains an invalid event");
      }
      return Object.freeze(event as BudgetEvent);
    });
  }

  append(event: BudgetEvent): void {
    this.#assertOpen();
    if (
      event.scope.tenant_id !== this.#scope.tenant_id ||
      event.scope.run_id !== this.#scope.run_id ||
      event.scope.session_id !== this.#scope.session_id
    ) {
      throw new Error("budget journal append scope mismatch");
    }
    requiredId("call_id", event.call_id);
    const append = this.#database.transaction(() => {
      const previous = this.#database
        .prepare(
          `SELECT sequence, event_json
             FROM budget_journal
            WHERE tenant_id = ? AND run_id = ? AND session_id = ?
            ORDER BY sequence DESC LIMIT 1`,
        )
        .get(
          this.#scope.tenant_id,
          this.#scope.run_id,
          this.#scope.session_id,
        ) as StoredBudgetRow | undefined;
      const expectedSequence = (previous?.sequence ?? -1) + 1;
      if (event.sequence !== expectedSequence) {
        throw new Error("budget journal stale append rejected");
      }
      if (previous !== undefined) {
        let prior: BudgetEvent;
        try {
          prior = JSON.parse(previous.event_json) as BudgetEvent;
        } catch {
          throw new Error("budget journal contains invalid JSON");
        }
        if (event.previous_hash !== prior.event_hash) {
          throw new Error("budget journal stale hash append rejected");
        }
      }
      this.#database
        .prepare(
          `INSERT INTO budget_journal (
             tenant_id, run_id, session_id, sequence, call_id, event_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#scope.tenant_id,
          this.#scope.run_id,
          this.#scope.session_id,
          event.sequence,
          event.call_id,
          JSON.stringify(event),
        );
    });
    append.immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("budget journal is closed");
  }
}
