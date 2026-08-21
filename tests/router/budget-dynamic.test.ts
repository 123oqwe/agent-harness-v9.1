import { describe, it, expect } from 'vitest';
import { allocateBudget, requestReallocation, trySpend } from '../../router/budget-dynamic.js';

describe('AH-ROUTER-BUDGET-DYNAMIC-001 allocation', () => {
  it('carves subagent budgets from the parent remaining budget', () => {
    const parent = { total_usd_micros: 1000, allocated_usd_micros: 400 };
    const r = allocateBudget({
      parent,
      subagents: [{ subagent_id: 'a', estimated_usd_micros: 300 }, { subagent_id: 'b', estimated_usd_micros: 300 }],
    });
    // remaining = 600; both fit, each gets exactly its estimate
    expect(r.map((x) => x.allocated_usd_micros)).toEqual([300, 300]);
    expect(r[0]!.remaining_parent_usd_micros).toBe(300);
    expect(r[1]!.remaining_parent_usd_micros).toBe(0);
  });

  it('never allocates more than the parent remaining budget', () => {
    const parent = { total_usd_micros: 1000, allocated_usd_micros: 400 }; // remaining 600
    const r = allocateBudget({
      parent,
      subagents: [
        { subagent_id: 'a', estimated_usd_micros: 500 },
        { subagent_id: 'b', estimated_usd_micros: 500 },
        { subagent_id: 'c', estimated_usd_micros: 500 },
      ],
    });
    const total = r.reduce((sum, x) => sum + x.allocated_usd_micros, 0);
    expect(total).toBeLessThanOrEqual(600);
    expect(r[r.length - 1]!.remaining_parent_usd_micros).toBeGreaterThanOrEqual(0);
  });

  it('scales down proportionally when the remaining budget cannot cover estimates', () => {
    const parent = { total_usd_micros: 100, allocated_usd_micros: 0 };
    const r = allocateBudget({
      parent,
      subagents: [{ subagent_id: 'a', estimated_usd_micros: 300 }, { subagent_id: 'b', estimated_usd_micros: 300 }],
    });
    // scale = 100/600, each floor(300 * 1/6) = 50
    expect(r.map((x) => x.allocated_usd_micros)).toEqual([50, 50]);
    expect(r.reduce((s, x) => s + x.allocated_usd_micros, 0)).toBe(100);
  });

  it('is deterministic across repeated calls', () => {
    const parent = { total_usd_micros: 100, allocated_usd_micros: 0 };
    const subagents = [{ subagent_id: 'a', estimated_usd_micros: 77 }, { subagent_id: 'b', estimated_usd_micros: 13 }];
    const r1 = allocateBudget({ parent, subagents });
    const r2 = allocateBudget({ parent, subagents });
    expect(r1).toEqual(r2);
  });
});

describe('AH-ROUTER-BUDGET-DYNAMIC-001 reallocation approval', () => {
  it('approves a reallocation that fits in the remaining budget, emitting an approval event', () => {
    const parent = { total_usd_micros: 1000, allocated_usd_micros: 700 }; // remaining 300
    const r = requestReallocation({ parent, request: { subagent_id: 'a', requested_usd_micros: 200 } });
    expect(r.approved).toBe(true);
    expect(r.approved_usd_micros).toBe(200);
    expect(r.events.map((e) => e.event)).toEqual(['budget_reallocation_requested', 'budget_reallocation_approved']);
  });

  it('denies a reallocation beyond the remaining budget, emitting a denial event', () => {
    const parent = { total_usd_micros: 1000, allocated_usd_micros: 700 }; // remaining 300
    const r = requestReallocation({ parent, request: { subagent_id: 'a', requested_usd_micros: 500 } });
    expect(r.approved).toBe(false);
    expect(r.approved_usd_micros).toBe(0);
    expect(r.events.map((e) => e.event)).toEqual(['budget_reallocation_requested', 'budget_reallocation_denied']);
  });
});

describe('AH-ROUTER-BUDGET-DYNAMIC-001 spend enforcement', () => {
  it('charges spends that fit the allocation', () => {
    const r = trySpend({ allocated_usd_micros: 500, spent_usd_micros: 200, spend_usd_micros: 100 });
    expect(r.allowed).toBe(true);
    expect(r.remaining_usd_micros).toBe(200);
    expect(r.stopped).toBe(false);
  });

  it('denies a spend that would exceed the allocation and stops the subagent — no overshoot', () => {
    const r = trySpend({ allocated_usd_micros: 500, spent_usd_micros: 480, spend_usd_micros: 50 });
    expect(r.allowed).toBe(false);
    expect(r.stopped).toBe(true);
    // remaining never goes negative even on an over-budget spend
    expect(r.remaining_usd_micros).toBe(20);
  });

  it('stops the subagent immediately when the allocation is exhausted', () => {
    const r = trySpend({ allocated_usd_micros: 500, spent_usd_micros: 500, spend_usd_micros: 1 });
    expect(r.allowed).toBe(false);
    expect(r.stopped).toBe(true);
    expect(r.remaining_usd_micros).toBe(0);
  });
});
