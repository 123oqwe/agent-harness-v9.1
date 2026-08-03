import { describe, expect, it, vi } from "vitest";

import {
  BudgetLedger,
  type BudgetEvent,
  type BudgetJournalPort,
} from "../../../packages/runtime-core/src/index.js";
import { BudgetLedgerRuntimeAdapter } from "../../../runtime/budget-port.js";
import { LoopEngine } from "../../../runtime/loop.js";
import { DurableSession } from "../../../session/durable-session.js";

const journal = (): BudgetJournalPort & { readonly events: BudgetEvent[] } => {
  const events: BudgetEvent[] = [];
  return { events, read: () => events, append: (event) => events.push(event) };
};

const pricing = {
  cached_input_micros_per_million: 1_000,
  uncached_input_micros_per_million: 1_000_000,
  output_micros_per_million: 1_000_000,
} as const;

describe("AH-RUNTIME-BUDGET-002 LoopEngine integration", () => {
  it("enforces BudgetGuard before a provider call", async () => {
    const modelCall = vi.fn(async () => ({
      content: "must not run",
      decision_summary: "must not run",
    }));
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: "run-budget-denied",
        goal: "stay within budget",
      },
      {
        session: new DurableSession("session-budget-denied"),
        modelCall,
        budgetGuard: {
          beforeModelCall: () => ({
            allowed: false,
            reason: "budget_exhausted",
            max_output_tokens: 0,
          }),
          afterModelCall: () => undefined,
        },
      },
    );

    const result = await loop.run();

    expect(result.termination_reason).toBe("budget_exhausted");
    expect(modelCall).not.toHaveBeenCalled();
  });

  it("attenuates the provider ceiling and records actual usage", async () => {
    const afterModelCall = vi.fn();
    const observedBudgets: unknown[] = [];
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: "run-budget-attenuated",
        goal: "stay within budget",
        max_output_tokens_per_call: 100,
      },
      {
        session: new DurableSession("session-budget-attenuated"),
        modelCall: async (_messages, _attempt, budget) => {
          observedBudgets.push(budget);
          return {
            content: "done",
            decision_summary: "done",
            usage: { input_tokens: 3, output_tokens: 2 },
          };
        },
        budgetGuard: {
          beforeModelCall: () => ({
            allowed: true,
            reason: "within_budget",
            max_output_tokens: 2,
          }),
          afterModelCall,
        },
      },
    );

    await expect(loop.run()).resolves.toMatchObject({
      termination_reason: "completed",
    });
    expect(observedBudgets).toEqual([
      { remaining_tokens: Number.MAX_SAFE_INTEGER, max_output_tokens: 2 },
    ]);
    expect(afterModelCall).toHaveBeenCalledWith({
      run_id: "run-budget-attenuated",
      iteration: 1,
      attempt: 1,
      input_tokens: 3,
      output_tokens: 2,
    });
  });

  it("uses the unique BudgetLedger authority to deny before provider dispatch", async () => {
    const events = journal();
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-real-budget-denied",
        session_id: "run-real-budget-denied",
      },
      ceiling: { usd_micros: 5 },
      journal: events,
    });
    const budgetGuard = new BudgetLedgerRuntimeAdapter({
      ledger,
      pricing,
      estimator: {
        estimate: () => ({
          cached_input_tokens: 0,
          uncached_input_tokens: 3,
          dag_node_count: 1,
        }),
      },
    });
    const modelCall = vi.fn(async () => ({
      content: "must not run",
      decision_summary: "must not run",
    }));
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: "run-real-budget-denied",
        goal: "stay within budget",
        max_output_tokens_per_call: 3,
      },
      {
        session: new DurableSession("run-real-budget-denied"),
        modelCall,
        budgetGuard,
      },
    );

    await expect(loop.run()).resolves.toMatchObject({
      termination_reason: "budget_exhausted",
    });
    expect(modelCall).not.toHaveBeenCalled();
    expect(events.events).toHaveLength(0);
  });

  it("commits actual provider usage through the unique BudgetLedger authority", async () => {
    const events = journal();
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-real-budget-record",
        session_id: "run-real-budget-record",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
    });
    const budgetGuard = new BudgetLedgerRuntimeAdapter({
      ledger,
      pricing,
      estimator: {
        estimate: () => ({
          cached_input_tokens: 2,
          uncached_input_tokens: 1,
          dag_node_count: 1,
        }),
      },
    });
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: "run-real-budget-record",
        goal: "stay within budget",
        max_output_tokens_per_call: 3,
      },
      {
        session: new DurableSession("run-real-budget-record"),
        modelCall: async () => ({
          content: "done",
          decision_summary: "done",
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
        budgetGuard,
      },
    );

    await expect(loop.run()).resolves.toMatchObject({
      termination_reason: "completed",
    });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      call_id: "run-real-budget-record:1:1",
      cached_input_tokens: 0,
      uncached_input_tokens: 3,
      output_tokens: 2,
      usd_micros: 5,
    });
  });

  it("defaults preflight accounting to a conservative all-cache-miss estimate", async () => {
    const events = journal();
    const budgetGuard = new BudgetLedgerRuntimeAdapter({
      ledger: new BudgetLedger({
        scope: {
          tenant_id: "tenant-a",
          run_id: "run-default-estimate",
          session_id: "run-default-estimate",
        },
        ceiling: { usd_micros: 1_000 },
        journal: events,
      }),
      pricing,
    });
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: "run-default-estimate",
        goal: "non-empty budget input",
        max_output_tokens_per_call: 1,
      },
      {
        session: new DurableSession("run-default-estimate"),
        modelCall: async () => ({
          content: "done",
          decision_summary: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        budgetGuard,
      },
    );

    await expect(loop.run()).resolves.toMatchObject({
      termination_reason: "completed",
    });
    expect(events.events).toHaveLength(1);
  });

  it("fails closed across the adapter pending-call state machine", () => {
    const events = journal();
    const adapter = new BudgetLedgerRuntimeAdapter({
      ledger: new BudgetLedger({
        scope: {
          tenant_id: "tenant-a",
          run_id: "run-adapter-state",
          session_id: "run-adapter-state",
        },
        ceiling: { usd_micros: 100 },
        journal: events,
      }),
      pricing,
    });
    const preflight = {
      run_id: "run-adapter-state",
      iteration: 1,
      attempt: 1,
      remaining_tokens: 100,
      requested_max_output_tokens: 2,
      estimated_input_tokens: 3,
    } as const;

    expect(adapter.beforeModelCall(preflight)).toEqual({
      allowed: true,
      reason: "within_budget",
      max_output_tokens: 2,
    });
    expect(() => adapter.beforeModelCall(preflight)).toThrow(
      "budget call is already pending",
    );
    adapter.afterModelCall({
      run_id: preflight.run_id,
      iteration: 1,
      attempt: 1,
      input_tokens: 3,
      output_tokens: 2,
    });
    expect(() =>
      adapter.afterModelCall({
        run_id: preflight.run_id,
        iteration: 1,
        attempt: 1,
        input_tokens: 3,
        output_tokens: 2,
      }),
    ).toThrow("budget usage has no authorized pending call");
    expect(events.events[0]).toMatchObject({
      call_id: "run-adapter-state:1:1",
      cached_input_tokens: 0,
      uncached_input_tokens: 3,
      output_tokens: 2,
      usd_micros: 5,
    });
  });

  it("returns exact deny and degradation decisions without granting authority", () => {
    const deny = new BudgetLedgerRuntimeAdapter({
      ledger: new BudgetLedger({
        scope: {
          tenant_id: "tenant-a",
          run_id: "run-adapter-deny",
          session_id: "run-adapter-deny",
        },
        ceiling: { usd_micros: 0 },
        journal: journal(),
      }),
      pricing,
    });
    const denied = {
      run_id: "run-adapter-deny",
      iteration: 1,
      attempt: 1,
      remaining_tokens: 100,
      requested_max_output_tokens: 1,
      estimated_input_tokens: 1,
    } as const;
    expect(deny.beforeModelCall(denied)).toEqual({
      allowed: false,
      reason: "budget_exhausted",
      max_output_tokens: 0,
    });
    expect(deny.beforeModelCall(denied)).toEqual({
      allowed: false,
      reason: "budget_exhausted",
      max_output_tokens: 0,
    });

    const attenuated = new BudgetLedgerRuntimeAdapter({
      ledger: new BudgetLedger({
        scope: {
          tenant_id: "tenant-a",
          run_id: "run-adapter-attenuate",
          session_id: "run-adapter-attenuate",
        },
        ceiling: { usd_micros: 100 },
        journal: journal(),
        degradation_matrix: [
          {
            remaining_ratio_at_or_below: 1,
            action: "reduce_output",
            max_output_tokens: 2,
          },
        ],
      }),
      pricing,
      estimator: {
        estimate: () => ({
          cached_input_tokens: 1,
          uncached_input_tokens: 0,
        }),
      },
    });
    expect(
      attenuated.beforeModelCall({
        run_id: "run-adapter-attenuate",
        iteration: 1,
        attempt: 1,
        remaining_tokens: 100,
        requested_max_output_tokens: 5,
        estimated_input_tokens: 99,
      }),
    ).toEqual({
      allowed: true,
      reason: "within_budget",
      max_output_tokens: 2,
    });
  });
});
