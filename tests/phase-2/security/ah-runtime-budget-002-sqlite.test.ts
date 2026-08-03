import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createHmac, hkdfSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  BudgetLedger,
  SqliteBudgetJournal,
  type BudgetEvent,
  type BudgetScope,
} from "../../../packages/runtime-core/src/index.js";

const roots: string[] = [];
const scope = {
  tenant_id: "tenant-a",
  run_id: "run-a",
  session_id: "session-a",
} as const;
const pricing = {
  cached_input_micros_per_million: 1_000,
  uncached_input_micros_per_million: 10_000,
  output_micros_per_million: 20_000,
} as const;
const MASTER_KEY = Buffer.alloc(32, 0x6b);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "budget-journal-"));
  roots.push(root);
  return join(root, "budget.sqlite");
}

function eventFor(
  eventScope: BudgetScope = scope,
  callId = "call-1",
): BudgetEvent {
  const events: BudgetEvent[] = [];
  const ledger = new BudgetLedger({
    scope: eventScope,
    ceiling: { usd_micros: 100 },
    journal: {
      read: () => events,
      append: (event) => events.push(event),
    },
  });
  ledger.recordModelCall({
    call_id: callId,
    cached_input_tokens: 0,
    uncached_input_tokens: 1,
    output_tokens: 0,
    pricing,
  });
  return events[0]!;
}

function storedHmac(
  database: Database.Database,
  eventScope: BudgetScope,
  sequence: number,
  callId: string,
  eventJson: string,
): string {
  const row = database
    .prepare("SELECT value FROM budget_journal_metadata WHERE key = 'hmac_salt'")
    .get() as { readonly value: string };
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      MASTER_KEY,
      Buffer.from(row.value, "base64"),
      "agent-harness/budget-journal/v1",
      32,
    ),
  );
  try {
    return createHmac("sha256", key)
      .update(
        JSON.stringify([
          eventScope.tenant_id,
          eventScope.run_id,
          eventScope.session_id,
          sequence,
          callId,
          eventJson,
        ]),
      )
      .digest("hex");
  } finally {
    key.fill(0);
  }
}

describe("AH-RUNTIME-BUDGET-002 SQLite journal", () => {
  it("rebuilds exact spend after close and restart", () => {
    const path = fixture();
    const firstJournal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const first = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal: firstJournal,
    });
    first.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1_000,
      output_tokens: 500,
      pricing,
    });
    firstJournal.close();

    const restartedJournal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const restarted = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal: restartedJournal,
    });
    expect(restarted.snapshot()).toEqual({
      spent_usd_micros: 20,
      remaining_usd_micros: 80,
    });
    restartedJournal.close();
  });

  it("requires the exact journal key before trusting or changing persisted usage", () => {
    const path = fixture();
    expect(
      () => new SqliteBudgetJournal(path, scope, Buffer.alloc(0)),
    ).toThrow("32-byte Budget journal masterKey is required");
    expect(
      () => new SqliteBudgetJournal(path, scope, undefined as never),
    ).toThrow("32-byte Budget journal masterKey is required");
    const first = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const ledger = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal: first,
    });
    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1,
      output_tokens: 0,
      pricing,
    });
    first.close();

    expect(
      () =>
        new SqliteBudgetJournal(path, scope, Buffer.alloc(32, 0x6c)),
    ).toThrow("Budget journal master key rejected");
    const database = new Database(path, { readonly: true });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM budget_journal").get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("binds the persisted key check to the documented journal context", () => {
    const path = fixture();
    const journal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    journal.close();
    const database = new Database(path);
    const metadata = database
      .prepare("SELECT key, value FROM budget_journal_metadata")
      .all() as Array<{ readonly key: string; readonly value: string }>;
    const values = new Map(metadata.map((row) => [row.key, row.value]));
    const derived = Buffer.from(
      hkdfSync(
        "sha256",
        MASTER_KEY,
        Buffer.from(values.get("hmac_salt")!, "base64"),
        "agent-harness/budget-journal/v1",
        32,
      ),
    );
    try {
      expect(values.get("hmac_key_check")).toBe(
        createHmac("sha256", derived)
          .update("agent-harness/budget-journal/key-check/v1")
          .digest("hex"),
      );
    } finally {
      derived.fill(0);
      database.close();
    }
  });

  it("rejects a missing salt and a non-empty journal without key-check metadata", () => {
    const missingSaltPath = fixture();
    const bootstrap = new Database(missingSaltPath);
    bootstrap.exec(`
      CREATE TABLE budget_journal_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TRIGGER ignore_budget_metadata
      BEFORE INSERT ON budget_journal_metadata
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    bootstrap.close();
    expect(
      () => new SqliteBudgetJournal(missingSaltPath, scope, MASTER_KEY),
    ).toThrow("Budget journal HMAC salt invalid");

    const legacyPath = fixture();
    const journal = new SqliteBudgetJournal(legacyPath, scope, MASTER_KEY);
    const ledger = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal,
    });
    ledger.recordModelCall({
      call_id: "legacy-call",
      cached_input_tokens: 0,
      uncached_input_tokens: 1,
      output_tokens: 0,
      pricing,
    });
    journal.close();
    const legacy = new Database(legacyPath);
    legacy
      .prepare("DELETE FROM budget_journal_metadata WHERE key = 'hmac_key_check'")
      .run();
    legacy.close();
    expect(
      () => new SqliteBudgetJournal(legacyPath, scope, MASTER_KEY),
    ).toThrow("Budget journal key-check migration requires an empty journal");
  });

  it("authenticates event bytes before JSON parsing", () => {
    const path = fixture();
    const journal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const ledger = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal,
    });
    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1,
      output_tokens: 0,
      pricing,
    });
    journal.close();

    const database = new Database(path);
    database
      .prepare("UPDATE budget_journal SET event_hmac = ?")
      .run("0".repeat(64));
    database.close();
    const reopened = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    expect(() => reopened.read()).toThrow(
      "budget journal event authentication failed",
    );
    reopened.close();
  });

  it("rejects malformed authentication encodings with a controlled error", () => {
    const path = fixture();
    const journal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    journal.append(eventFor());
    journal.close();
    const database = new Database(path);
    database.prepare("UPDATE budget_journal SET event_hmac = '0'").run();
    database.close();
    const reopened = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    expect(() => reopened.read()).toThrow(
      "budget journal event authentication failed",
    );
    reopened.close();
  });

  it("fails one stale concurrent writer instead of losing or double counting usage", () => {
    const path = fixture();
    const journalA = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const journalB = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const ledgerA = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal: journalA,
    });
    const ledgerB = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal: journalB,
    });
    const call = {
      cached_input_tokens: 0,
      uncached_input_tokens: 1_000,
      output_tokens: 0,
      pricing,
    } as const;

    ledgerA.recordModelCall({ ...call, call_id: "call-a" });
    expect(() => ledgerB.recordModelCall({ ...call, call_id: "call-b" })).toThrow();
    journalA.close();
    journalB.close();

    const reopenedJournal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const reopened = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal: reopenedJournal,
    });
    expect(reopened.snapshot().spent_usd_micros).toBe(10);
    reopenedJournal.close();
  });

  it("detects out-of-band event tampering on restart", () => {
    const path = fixture();
    const journal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const ledger = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal,
    });
    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1_000,
      output_tokens: 0,
      pricing,
    });
    journal.close();

    const database = new Database(path);
    database.prepare("UPDATE budget_journal SET event_json = ?").run(
      JSON.stringify({ corrupted: true }),
    );
    database.close();

    const reopened = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    expect(
      () =>
        new BudgetLedger({
          scope,
          ceiling: { usd_micros: 100 },
          journal: reopened,
        }),
    ).toThrow();
    reopened.close();
  });

  it("rejects every invalid database path and scope field", () => {
    expect(() => new SqliteBudgetJournal("", scope, MASTER_KEY)).toThrow(
      "databasePath is required",
    );
    for (const [patch, message] of [
      [{ tenant_id: " " }, "tenant_id is required"],
      [{ run_id: "" }, "run_id is required"],
      [{ session_id: 1 }, "session_id is required"],
    ] as const) {
      expect(
        () =>
          new SqliteBudgetJournal(
            fixture(),
            { ...scope, ...patch } as never,
            MASTER_KEY,
          ),
      ).toThrow(message);
    }
    const path = fixture();
    const journal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    journal.close();
  });

  it("fails closed for malformed persisted JSON and event shapes", () => {
    for (const [stored, message] of [
      ["{", "budget journal contains invalid JSON"],
      ["null", "budget journal contains an invalid event"],
      ["1", "budget journal contains an invalid event"],
      ["[]", "budget journal contains an invalid event"],
    ] as const) {
      const path = fixture();
      const initialized = new SqliteBudgetJournal(path, scope, MASTER_KEY);
      initialized.close();
      const database = new Database(path);
      database
        .prepare(
          `INSERT INTO budget_journal
            (tenant_id, run_id, session_id, sequence, call_id, event_json,
             event_hmac)
           VALUES (?, ?, ?, 0, 'malformed', ?, ?)`,
        )
        .run(
          scope.tenant_id,
          scope.run_id,
          scope.session_id,
          stored,
          storedHmac(database, scope, 0, "malformed", stored),
        );
      database.close();
      const reopened = new SqliteBudgetJournal(path, scope, MASTER_KEY);
      expect(() => reopened.read()).toThrow(message);
      reopened.close();
    }
  });

  it("rejects each append identity violation without writing a row", () => {
    const path = fixture();
    const journal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const valid = eventFor();
    for (const field of ["tenant_id", "run_id", "session_id"] as const) {
      expect(() =>
        journal.append({
          ...valid,
          scope: { ...valid.scope, [field]: `wrong-${field}` },
        }),
      ).toThrow("budget journal append scope mismatch");
    }
    expect(() => journal.append({ ...valid, call_id: " " })).toThrow(
      "call_id is required",
    );
    expect(journal.read()).toEqual([]);
    journal.close();
  });

  it("distinguishes stale sequence, corrupt prior JSON, and stale hash", () => {
    const path = fixture();
    const journal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const ledger = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal,
    });
    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1,
      output_tokens: 0,
      pricing,
    });
    const first = journal.read()[0]!;
    expect(() =>
      journal.append({ ...first, call_id: "stale-sequence" }),
    ).toThrow("budget journal stale append rejected");
    expect(() =>
      journal.append({
        ...first,
        sequence: 1,
        call_id: "stale-hash",
        previous_hash: "f".repeat(64),
      }),
    ).toThrow("budget journal stale hash append rejected");
    expect(journal.read()).toHaveLength(1);

    const database = new Database(path);
    database
      .prepare("UPDATE budget_journal SET event_json = ?")
      .run("{");
    database.close();
    expect(() =>
      journal.append({
        ...first,
        sequence: 1,
        call_id: "corrupt-prior",
        previous_hash: first.event_hash,
      }),
    ).toThrow("budget journal event authentication failed");
    journal.close();
  });

  it("rejects authenticated invalid prior JSON before following its hash", () => {
    const path = fixture();
    const journal = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    journal.append(eventFor());
    const database = new Database(path);
    database
      .prepare("UPDATE budget_journal SET event_json = ?, event_hmac = ?")
      .run("{", storedHmac(database, scope, 0, "call-1", "{"));
    database.close();
    expect(() =>
      journal.append({
        ...eventFor(scope, "call-2"),
        sequence: 1,
        previous_hash: "f".repeat(64),
      }),
    ).toThrow("budget journal contains invalid JSON");
    journal.close();
  });

  it("is idempotently closeable and fails closed after close", () => {
    const journal = new SqliteBudgetJournal(fixture(), scope, MASTER_KEY);
    journal.close();
    expect(() => journal.close()).not.toThrow();
    expect(() => journal.read()).toThrow("budget journal is closed");
    expect(() => journal.append(eventFor())).toThrow(
      "budget journal is closed",
    );
  });

  it("isolates scopes and returns each scope in append order", () => {
    const path = fixture();
    const scopeB = {
      tenant_id: "tenant-b",
      run_id: "run-b",
      session_id: "session-b",
    } as const;
    const journalA = new SqliteBudgetJournal(path, scope, MASTER_KEY);
    const journalB = new SqliteBudgetJournal(path, scopeB, MASTER_KEY);
    const ledgerA = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal: journalA,
    });
    const ledgerB = new BudgetLedger({
      scope: scopeB,
      ceiling: { usd_micros: 100 },
      journal: journalB,
    });
    const record = (ledger: BudgetLedger, call_id: string) =>
      ledger.recordModelCall({
        call_id,
        cached_input_tokens: 0,
        uncached_input_tokens: 1,
        output_tokens: 0,
        pricing,
      });
    record(ledgerA, "a-1");
    record(ledgerA, "a-2");
    record(ledgerB, "b-1");

    expect(journalA.read().map((event) => event.call_id)).toEqual([
      "a-1",
      "a-2",
    ]);
    expect(journalB.read().map((event) => event.call_id)).toEqual(["b-1"]);
    expect(Object.isFrozen(journalA.read()[0])).toBe(true);
    journalA.close();
    journalB.close();
  });
});
