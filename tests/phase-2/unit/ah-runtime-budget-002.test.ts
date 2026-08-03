import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BudgetLedger,
  type BudgetEvent,
  type BudgetJournalPort,
} from "../../../packages/runtime-core/src/index.js";

const journal = (): BudgetJournalPort & { readonly events: BudgetEvent[] } => {
  const events: BudgetEvent[] = [];
  return { events, read: () => events, append: (event) => events.push(event) };
};

const rehashEvent = (
  event: BudgetEvent,
  patch: Partial<BudgetEvent>,
): BudgetEvent => {
  const { event_hash: _discarded, ...payload } = { ...event, ...patch };
  return {
    ...payload,
    event_hash: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  } as BudgetEvent;
};

describe("AH-RUNTIME-BUDGET-002 full budget ledger", () => {
  it("prices uncached input at the configured tenfold cache-miss cost", () => {
    const events = journal();
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
    });
    const pricing = {
      cached_input_micros_per_million: 1_000,
      uncached_input_micros_per_million: 10_000,
      output_micros_per_million: 20_000,
    };

    expect(
      ledger.projectModelCall({
        cached_input_tokens: 1_000,
        uncached_input_tokens: 0,
        output_tokens: 0,
        pricing,
      }).projected_usd_micros,
    ).toBe(1);
    expect(
      ledger.projectModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 1_000,
        output_tokens: 0,
        pricing,
      }).projected_usd_micros,
    ).toBe(10);
  });

  it("rebuilds committed spend from an append-only hash chain", () => {
    const events = journal();
    const options = {
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
    } as const;
    const ledger = new BudgetLedger(options);

    const recorded = ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1_000,
      output_tokens: 500,
      pricing: {
        cached_input_micros_per_million: 1_000,
        uncached_input_micros_per_million: 10_000,
        output_micros_per_million: 20_000,
      },
    });

    expect(recorded).toMatchObject({ replayed: false, spent_usd_micros: 20 });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      schema_version: "budget-event/v1",
      sequence: 0,
      previous_hash: "0".repeat(64),
      call_id: "call-1",
      usd_micros: 20,
    });
    expect(events.events[0]?.event_hash).toMatch(/^[a-f0-9]{64}$/u);

    const rebuilt = new BudgetLedger(options);
    expect(rebuilt.snapshot()).toMatchObject({ spent_usd_micros: 20 });
    expect(rebuilt.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1_000,
      output_tokens: 500,
      pricing: {
        cached_input_micros_per_million: 1_000,
        uncached_input_micros_per_million: 10_000,
        output_micros_per_million: 20_000,
      },
    })).toMatchObject({ replayed: true, spent_usd_micros: 20 });
    expect(events.events).toHaveLength(1);
  });

  it("fails closed when persisted budget usage is altered", () => {
    const events = journal();
    const options = {
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
    } as const;
    const ledger = new BudgetLedger(options);
    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1_000,
      output_tokens: 0,
      pricing: {
        cached_input_micros_per_million: 1_000,
        uncached_input_micros_per_million: 10_000,
        output_micros_per_million: 20_000,
      },
    });
    events.events[0] = { ...events.events[0]!, usd_micros: 0 };

    expect(() => new BudgetLedger(options)).toThrow(
      "budget journal hash chain is invalid",
    );
  });

  it("denies a projected model call that would exhaust the ceiling", () => {
    const events = journal();
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 20 },
      journal: events,
    });
    const pricing = {
      cached_input_micros_per_million: 1_000,
      uncached_input_micros_per_million: 10_000,
      output_micros_per_million: 20_000,
    };
    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 1_000,
      output_tokens: 0,
      pricing,
    });

    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 1_000,
        output_tokens: 1,
        pricing,
        agent_override: "allow",
      } as Parameters<BudgetLedger["authorizeModelCall"]>[0] & {
        agent_override: string;
      }),
    ).toEqual({
      allowed: false,
      action: "stop",
      reason: "budget_exhausted",
      projected_usd_micros: 11,
      remaining_usd_micros: 10,
      all_miss_budget_risk: false,
    });
    expect(events.events).toHaveLength(1);
  });

  it("flags a multi-node all-miss projection as a budget risk", () => {
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 1_000 },
      journal: journal(),
    });

    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 10_000,
        output_tokens: 0,
        dag_node_count: 4,
        pricing: {
          cached_input_micros_per_million: 1_000,
          uncached_input_micros_per_million: 10_000,
          output_micros_per_million: 20_000,
        },
      }).all_miss_budget_risk,
    ).toBe(true);
  });

  it("enforces the configured degradation matrix before provider dispatch", () => {
    const events = journal();
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
      degradation_matrix: [
        {
          remaining_ratio_at_or_below: 0.5,
          action: "reduce_output",
          max_output_tokens: 128,
        },
      ],
    });
    const pricing = {
      cached_input_micros_per_million: 1_000,
      uncached_input_micros_per_million: 10_000,
      output_micros_per_million: 20_000,
    };
    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 0,
      uncached_input_tokens: 6_000,
      output_tokens: 0,
      pricing,
    });

    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 1,
        uncached_input_tokens: 0,
        output_tokens: 1,
        requested_max_output_tokens: 4_096,
        pricing,
      }),
    ).toMatchObject({
      allowed: true,
      action: "reduce_output",
      max_output_tokens: 128,
      remaining_usd_micros: 40,
    });
    expect(events.events).toHaveLength(1);
  });

  it("rejects reuse of a call id with different accounting data", () => {
    const events = journal();
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
    });
    const first = {
      call_id: "call-1",
      cached_input_tokens: 1_000,
      uncached_input_tokens: 0,
      output_tokens: 0,
      pricing: {
        cached_input_micros_per_million: 1_000,
        uncached_input_micros_per_million: 10_000,
        output_micros_per_million: 20_000,
      },
    } as const;
    ledger.recordModelCall(first);

    expect(() =>
      ledger.recordModelCall({ ...first, uncached_input_tokens: 1 }),
    ).toThrow("budget call id collision");
    expect(events.events).toHaveLength(1);
  });

  it("rejects unsafe token and pricing values before accounting", () => {
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: journal(),
    });
    const valid = {
      cached_input_tokens: 1,
      uncached_input_tokens: 1,
      output_tokens: 1,
      pricing: {
        cached_input_micros_per_million: 1,
        uncached_input_micros_per_million: 10,
        output_micros_per_million: 20,
      },
    };

    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      for (const [label, candidate] of [
        ["cached_input_tokens", { ...valid, cached_input_tokens: invalid }],
        ["uncached_input_tokens", { ...valid, uncached_input_tokens: invalid }],
        ["output_tokens", { ...valid, output_tokens: invalid }],
        [
          "cached_input_micros_per_million",
          {
            ...valid,
            pricing: {
              ...valid.pricing,
              cached_input_micros_per_million: invalid,
            },
          },
        ],
        [
          "uncached_input_micros_per_million",
          {
            ...valid,
            pricing: {
              ...valid.pricing,
              uncached_input_micros_per_million: invalid,
            },
          },
        ],
        [
          "output_micros_per_million",
          {
            ...valid,
            pricing: {
              ...valid.pricing,
              output_micros_per_million: invalid,
            },
          },
        ],
      ] as const) {
        expect(() => ledger.projectModelCall(candidate)).toThrow(
          `${label} must be a non-negative safe integer`,
        );
      }
    }
  });

  it("rejects a persisted ledger from another tenant or run", () => {
    const events = journal();
    const first = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
    });
    first.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 1,
      uncached_input_tokens: 0,
      output_tokens: 0,
      pricing: {
        cached_input_micros_per_million: 1,
        uncached_input_micros_per_million: 10,
        output_micros_per_million: 20,
      },
    });

    expect(
      () =>
        new BudgetLedger({
          scope: {
            tenant_id: "tenant-b",
            run_id: "run-a",
            session_id: "session-a",
          },
          ceiling: { usd_micros: 100 },
          journal: events,
        }),
    ).toThrow("budget journal scope mismatch");
  });

  it("rejects invalid scope, ceiling, and degradation configuration", () => {
    const base = {
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: journal(),
    } as const;

    expect(
      () => new BudgetLedger({ ...base, scope: { ...base.scope, tenant_id: "" } }),
    ).toThrow("tenant_id is required");
    expect(
      () => new BudgetLedger({ ...base, ceiling: { usd_micros: -1 } }),
    ).toThrow("ceiling.usd_micros must be a non-negative safe integer");
    expect(
      () =>
        new BudgetLedger({
          ...base,
          degradation_matrix: [
            {
              remaining_ratio_at_or_below: 2,
              action: "reduce_output",
              max_output_tokens: 1,
            },
          ],
        }),
    ).toThrow("remaining_ratio_at_or_below must be between 0 and 1");
    expect(
      () =>
        new BudgetLedger({
          ...base,
          degradation_matrix: [
            {
              remaining_ratio_at_or_below: 0.5,
              action: "reduce_output",
              max_output_tokens: 0,
            },
          ],
        }),
    ).toThrow("max_output_tokens must be a positive safe integer");
  });

  it("rejects projected cost overflow instead of rounding an unsafe amount", () => {
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: Number.MAX_SAFE_INTEGER },
      journal: journal(),
    });

    expect(() =>
      ledger.projectModelCall({
        cached_input_tokens: Number.MAX_SAFE_INTEGER,
        uncached_input_tokens: 0,
        output_tokens: 0,
        pricing: {
          cached_input_micros_per_million: Number.MAX_SAFE_INTEGER,
          uncached_input_micros_per_million: 0,
          output_micros_per_million: 0,
        },
      }),
    ).toThrow("projected_usd_micros must be a non-negative safe integer");
  });

  it("rejects a validly rehashed persisted duplicate call id", () => {
    const events = journal();
    const options = {
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
    } as const;
    const ledger = new BudgetLedger(options);
    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 1,
      uncached_input_tokens: 0,
      output_tokens: 0,
      pricing: {
        cached_input_micros_per_million: 1,
        uncached_input_micros_per_million: 10,
        output_micros_per_million: 20,
      },
    });
    const first = events.events[0]!;
    const duplicatePayload = {
      schema_version: "budget-event/v1" as const,
      scope: first.scope,
      sequence: 1,
      previous_hash: first.event_hash,
      call_id: first.call_id,
      input_hash: first.input_hash,
      cached_input_tokens: first.cached_input_tokens,
      uncached_input_tokens: first.uncached_input_tokens,
      output_tokens: first.output_tokens,
      usd_micros: first.usd_micros,
    };
    events.events.push({
      ...duplicatePayload,
      event_hash: createHash("sha256")
        .update(JSON.stringify(duplicatePayload))
        .digest("hex"),
    });

    expect(() => new BudgetLedger(options)).toThrow(
      "budget journal contains a duplicate call id",
    );
  });

  it("freezes ledger scope before hashing persisted events", () => {
    const events = journal();
    const scope = {
      tenant_id: "tenant-a",
      run_id: "run-a",
      session_id: "session-a",
    };
    const ledger = new BudgetLedger({
      scope,
      ceiling: { usd_micros: 100 },
      journal: events,
    });
    scope.tenant_id = "tenant-b";

    ledger.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 1,
      uncached_input_tokens: 0,
      output_tokens: 0,
      pricing: {
        cached_input_micros_per_million: 1,
        uncached_input_micros_per_million: 10,
        output_micros_per_million: 20,
      },
    });

    expect(events.events[0]?.scope).toEqual({
      tenant_id: "tenant-a",
      run_id: "run-a",
      session_id: "session-a",
    });
  });

  it("fails closed for every malformed constructor authority input", () => {
    const valid = {
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: journal(),
    } as const;
    for (const [scopePatch, message] of [
      [{ tenant_id: " " }, "tenant_id is required"],
      [{ run_id: "" }, "run_id is required"],
      [{ session_id: 1 }, "session_id is required"],
    ] as const) {
      expect(
        () =>
          new BudgetLedger({
            ...valid,
            scope: { ...valid.scope, ...scopePatch } as never,
          }),
      ).toThrow(message);
    }
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new BudgetLedger({
            ...valid,
            ceiling: { usd_micros: invalid },
          }),
      ).toThrow("ceiling.usd_micros must be a non-negative safe integer");
    }
    for (const invalidJournal of [
      undefined,
      { append: () => undefined },
      { read: () => [] },
    ]) {
      expect(
        () =>
          new BudgetLedger({ ...valid, journal: invalidJournal } as never),
      ).toThrow("budget journal is required");
    }
    for (const invalidRatio of [Number.NaN, -0.1, 1.1]) {
      expect(
        () =>
          new BudgetLedger({
            ...valid,
            degradation_matrix: [
              {
                remaining_ratio_at_or_below: invalidRatio,
                action: "reduce_output",
                max_output_tokens: 1,
              },
            ],
          }),
      ).toThrow("remaining_ratio_at_or_below must be between 0 and 1");
    }
    for (const invalidMax of [-1, 0, 1.5]) {
      expect(
        () =>
          new BudgetLedger({
            ...valid,
            degradation_matrix: [
              {
                remaining_ratio_at_or_below: 0.5,
                action: "reduce_output",
                max_output_tokens: invalidMax,
              },
            ],
          }),
      ).toThrow("max_output_tokens must be a positive safe integer");
    }
    expect(
      () =>
        new BudgetLedger({
          ...valid,
          degradation_matrix: [
            {
              remaining_ratio_at_or_below: 0.5,
              action: "stop" as never,
              max_output_tokens: 1,
            },
          ],
        }),
    ).toThrow("unsupported budget degradation action");
    expect(
      () =>
        new BudgetLedger({
          ...valid,
          degradation_matrix: [
            {
              remaining_ratio_at_or_below: 0,
              action: "reduce_output",
              max_output_tokens: 1,
            },
            {
              remaining_ratio_at_or_below: 1,
              action: "reduce_output",
              max_output_tokens: 2,
            },
          ],
        }),
    ).not.toThrow();
  });

  it("validates every persisted event field before trusting spend", () => {
    const seed = journal();
    const options = {
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: Number.MAX_SAFE_INTEGER },
    } as const;
    const writer = new BudgetLedger({ ...options, journal: seed });
    writer.recordModelCall({
      call_id: "call-1",
      cached_input_tokens: 1,
      uncached_input_tokens: 2,
      output_tokens: 3,
      pricing: {
        cached_input_micros_per_million: 1_000_000,
        uncached_input_micros_per_million: 1_000_000,
        output_micros_per_million: 1_000_000,
      },
    });
    const first = seed.events[0]!;
    const rejects = (event: BudgetEvent, message: string) => {
      const events = journal();
      events.events.push(event);
      expect(
        () => new BudgetLedger({ ...options, journal: events }),
      ).toThrow(message);
    };
    rejects(
      rehashEvent(first, { schema_version: "wrong" as never }),
      "budget journal schema version is invalid",
    );
    rejects(
      rehashEvent(first, { call_id: "" }),
      "budget event call_id is required",
    );
    for (const [field, message] of [
      ["sequence", "budget event sequence must be a non-negative safe integer"],
      [
        "cached_input_tokens",
        "budget event cached_input_tokens must be a non-negative safe integer",
      ],
      [
        "uncached_input_tokens",
        "budget event uncached_input_tokens must be a non-negative safe integer",
      ],
      [
        "output_tokens",
        "budget event output_tokens must be a non-negative safe integer",
      ],
      ["usd_micros", "budget event usd_micros must be a non-negative safe integer"],
    ] as const) {
      rejects(rehashEvent(first, { [field]: -1 }), message);
    }
    for (const field of ["tenant_id", "run_id", "session_id"] as const) {
      rejects(
        rehashEvent(first, {
          scope: { ...first.scope, [field]: `wrong-${field}` },
        }),
        "budget journal scope mismatch",
      );
    }
    rejects(
      rehashEvent(first, { sequence: 1 }),
      "budget journal hash chain is invalid",
    );
    rejects(
      rehashEvent(first, { previous_hash: "f".repeat(64) }),
      "budget journal hash chain is invalid",
    );
    rejects(
      { ...first, event_hash: "f".repeat(64) },
      "budget journal hash chain is invalid",
    );

    const overflow = journal();
    const huge = rehashEvent(first, {
      usd_micros: Number.MAX_SAFE_INTEGER,
    });
    const secondSeed = {
      ...first,
      sequence: 1,
      previous_hash: huge.event_hash,
      call_id: "call-2",
      usd_micros: 1,
    };
    overflow.events.push(huge, rehashEvent(secondSeed, {}));
    expect(
      () => new BudgetLedger({ ...options, journal: overflow }),
    ).toThrow(
      "budget journal spent_usd_micros must be a non-negative safe integer",
    );
  });

  it("enforces exact ceiling, degradation, and all-miss boundaries", () => {
    const events = journal();
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 100 },
      journal: events,
      degradation_matrix: [
        {
          remaining_ratio_at_or_below: 0.75,
          action: "reduce_output",
          max_output_tokens: 75,
        },
        {
          remaining_ratio_at_or_below: 0.25,
          action: "reduce_output",
          max_output_tokens: 25,
        },
        {
          remaining_ratio_at_or_below: 0.5,
          action: "reduce_output",
          max_output_tokens: 50,
        },
      ],
    });
    const pricing = {
      cached_input_micros_per_million: 1_000_000,
      uncached_input_micros_per_million: 1_000_000,
      output_micros_per_million: 1_000_000,
    };
    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 0,
        output_tokens: 100,
        pricing,
      }),
    ).toMatchObject({ allowed: true, reason: "within_budget" });
    ledger.recordModelCall({
      call_id: "spent-50",
      cached_input_tokens: 0,
      uncached_input_tokens: 50,
      output_tokens: 0,
      pricing,
    });
    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 0,
        output_tokens: 0,
        requested_max_output_tokens: 0,
        pricing,
      }),
    ).toMatchObject({
      allowed: true,
      action: "reduce_output",
      reason: "within_budget",
      max_output_tokens: 0,
      all_miss_budget_risk: false,
    });
    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 1,
        output_tokens: 0,
        dag_node_count: 2,
        pricing,
      }).all_miss_budget_risk,
    ).toBe(true);
    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 1,
        uncached_input_tokens: 1,
        output_tokens: 0,
        dag_node_count: 2,
        pricing,
      }).all_miss_budget_risk,
    ).toBe(false);
    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 0,
        output_tokens: 0,
        dag_node_count: 2,
        pricing,
      }).all_miss_budget_risk,
    ).toBe(false);
    expect(
      ledger.authorizeModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 1,
        output_tokens: 0,
        dag_node_count: 1,
        pricing,
      }).all_miss_budget_risk,
    ).toBe(false);

    const zero = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-zero",
        session_id: "session-zero",
      },
      ceiling: { usd_micros: 0 },
      journal: journal(),
      degradation_matrix: [
        {
          remaining_ratio_at_or_below: 0,
          action: "reduce_output",
          max_output_tokens: 1,
        },
      ],
    });
    expect(
      zero.authorizeModelCall({
        cached_input_tokens: 0,
        uncached_input_tokens: 0,
        output_tokens: 0,
        pricing,
      }),
    ).toMatchObject({ allowed: true, action: "reduce_output" });
  });

  it("persists exact multi-event lineage and clamps overspend snapshots", () => {
    const events = journal();
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-a",
        session_id: "session-a",
      },
      ceiling: { usd_micros: 1 },
      journal: events,
    });
    const call = {
      cached_input_tokens: 0,
      uncached_input_tokens: 1,
      output_tokens: 0,
      pricing: {
        cached_input_micros_per_million: 1_000_000,
        uncached_input_micros_per_million: 1_000_000,
        output_micros_per_million: 1_000_000,
      },
    } as const;
    expect(() => ledger.recordModelCall({ ...call, call_id: " " })).toThrow(
      "call_id is required",
    );
    ledger.recordModelCall({ ...call, call_id: "call-1" });
    ledger.recordModelCall({ ...call, call_id: "call-2" });
    expect(events.events[1]).toMatchObject({
      sequence: 1,
      previous_hash: events.events[0]?.event_hash,
    });
    expect(ledger.snapshot()).toEqual({
      spent_usd_micros: 2,
      remaining_usd_micros: 0,
    });
  });

  it("accepts the exact largest safe projected amount", () => {
    const ledger = new BudgetLedger({
      scope: {
        tenant_id: "tenant-a",
        run_id: "run-safe",
        session_id: "session-safe",
      },
      ceiling: { usd_micros: Number.MAX_SAFE_INTEGER },
      journal: journal(),
    });
    expect(
      ledger.projectModelCall({
        cached_input_tokens: 1_000_000,
        uncached_input_tokens: 0,
        output_tokens: 0,
        pricing: {
          cached_input_micros_per_million: Number.MAX_SAFE_INTEGER,
          uncached_input_micros_per_million: 0,
          output_micros_per_million: 0,
        },
      }).projected_usd_micros,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
