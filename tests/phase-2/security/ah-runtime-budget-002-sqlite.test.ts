import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  BudgetLedger,
  SqliteBudgetJournal,
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "budget-journal-"));
  roots.push(root);
  return join(root, "budget.sqlite");
}

describe("AH-RUNTIME-BUDGET-002 SQLite journal", () => {
  it("rebuilds exact spend after close and restart", () => {
    const path = fixture();
    const firstJournal = new SqliteBudgetJournal(path, scope);
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

    const restartedJournal = new SqliteBudgetJournal(path, scope);
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

  it("fails one stale concurrent writer instead of losing or double counting usage", () => {
    const path = fixture();
    const journalA = new SqliteBudgetJournal(path, scope);
    const journalB = new SqliteBudgetJournal(path, scope);
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

    const reopenedJournal = new SqliteBudgetJournal(path, scope);
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
    const journal = new SqliteBudgetJournal(path, scope);
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

    const reopened = new SqliteBudgetJournal(path, scope);
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
});
