import Database from "better-sqlite3";
import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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

CREATE TABLE IF NOT EXISTS budget_journal_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_journal (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  call_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  event_hmac TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id, session_id, sequence),
  UNIQUE (tenant_id, run_id, session_id, call_id)
);
`;
const KEY_CONTEXT = "agent-harness/budget-journal/v1";
const KEY_CHECK_CONTEXT = "agent-harness/budget-journal/key-check/v1";
const SHA256 = /^[a-f0-9]{64}$/u;

function requiredId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

function validateScope(scope: BudgetScope): void {
  requiredId("tenant_id", scope.tenant_id);
  requiredId("run_id", scope.run_id);
  requiredId("session_id", scope.session_id);
}

interface StoredBudgetRow {
  readonly sequence: number;
  readonly call_id: string;
  readonly event_json: string;
  readonly event_hmac: string;
}

/** Durable append-only storage for the unique BudgetLedger authority. */
export class SqliteBudgetJournal implements BudgetJournalPort {
  readonly #database: Database.Database;
  readonly #scope: BudgetScope;
  readonly #hmacKey: Buffer;
  #closed = false;

  constructor(databasePath: string, scope: BudgetScope, masterKey: Uint8Array) {
    requiredId("databasePath", databasePath);
    validateScope(scope);
    if (masterKey?.byteLength !== 32) {
      throw new TypeError("32-byte Budget journal masterKey is required");
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    this.#database.exec(SCHEMA);
    this.#scope = Object.freeze({ ...scope });
    const getMetadata = this.#database.prepare(
      "SELECT value FROM budget_journal_metadata WHERE key = ?",
    );
    const insertMetadata = this.#database.prepare(
      "INSERT OR IGNORE INTO budget_journal_metadata (key, value) VALUES (?, ?)",
    );
    insertMetadata.run("hmac_salt", randomBytes(32).toString("base64"));
    const saltRow = getMetadata.get("hmac_salt") as
      | { readonly value: string }
      | undefined;
    const salt = Buffer.from(saltRow?.value ?? "", "base64");
    if (salt.byteLength !== 32) {
      this.#database.close();
      throw new Error("Budget journal HMAC salt invalid");
    }
    const suppliedKey = Buffer.from(masterKey);
    let hmacKey: Buffer;
    try {
      hmacKey = Buffer.from(
        hkdfSync("sha256", suppliedKey, salt, KEY_CONTEXT, 32),
      );
    } finally {
      suppliedKey.fill(0);
      salt.fill(0);
    }
    const expectedKeyCheck = createHmac("sha256", hmacKey)
      .update(KEY_CHECK_CONTEXT)
      .digest();
    try {
      const keyCheckRow = getMetadata.get("hmac_key_check") as
        | { readonly value: string }
        | undefined;
      if (keyCheckRow === undefined) {
        const rowCount = this.#database
          .prepare("SELECT COUNT(*) AS count FROM budget_journal")
          .get() as { readonly count: number };
        if (rowCount.count !== 0) {
          throw new Error(
            "Budget journal key-check migration requires an empty journal",
          );
        }
        insertMetadata.run("hmac_key_check", expectedKeyCheck.toString("hex"));
      } else {
        const actualKeyCheck = SHA256.test(keyCheckRow.value)
          ? Buffer.from(keyCheckRow.value, "hex")
          : Buffer.alloc(0);
        try {
          if (
            actualKeyCheck.byteLength !== expectedKeyCheck.byteLength ||
            !timingSafeEqual(actualKeyCheck, expectedKeyCheck)
          ) {
            throw new Error("Budget journal master key rejected");
          }
        } finally {
          actualKeyCheck.fill(0);
        }
      }
      this.#hmacKey = hmacKey;
    } catch (error) {
      hmacKey.fill(0);
      this.#database.close();
      throw error;
    } finally {
      expectedKeyCheck.fill(0);
    }
  }

  read(): readonly BudgetEvent[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT sequence, call_id, event_json, event_hmac
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
      this.#authenticate(row);
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
          `SELECT sequence, call_id, event_json, event_hmac
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
        this.#authenticate(previous);
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
             tenant_id, run_id, session_id, sequence, call_id, event_json,
             event_hmac
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#scope.tenant_id,
          this.#scope.run_id,
          this.#scope.session_id,
          event.sequence,
          event.call_id,
          JSON.stringify(event),
          this.#eventHmac(event.sequence, event.call_id, JSON.stringify(event)),
        );
    });
    append.immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#hmacKey.fill(0);
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("budget journal is closed");
  }

  #eventHmac(sequence: number, callId: string, eventJson: string): string {
    return createHmac("sha256", this.#hmacKey)
      .update(
        JSON.stringify([
          this.#scope.tenant_id,
          this.#scope.run_id,
          this.#scope.session_id,
          sequence,
          callId,
          eventJson,
        ]),
      )
      .digest("hex");
  }

  #authenticate(row: StoredBudgetRow): void {
    const expected = Buffer.from(
      this.#eventHmac(row.sequence, row.call_id, row.event_json),
      "hex",
    );
    const actual = SHA256.test(row.event_hmac)
      ? Buffer.from(row.event_hmac, "hex")
      : Buffer.alloc(0);
    try {
      if (
        actual.byteLength !== expected.byteLength ||
        !timingSafeEqual(actual, expected)
      ) {
        throw new Error("budget journal event authentication failed");
      }
    } finally {
      actual.fill(0);
      expected.fill(0);
    }
  }
}
