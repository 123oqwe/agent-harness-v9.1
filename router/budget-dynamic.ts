/**
 * AH-ROUTER-BUDGET-DYNAMIC-001: dynamic budget allocation across subagents.
 *
 * All budgets are in USD micros (consistent with RunPlan budget_allocation).
 * Invariants:
 *  - Subagent budgets are carved from the parent's REMAINING budget, never the
 *    total — the sum of all allocations can never exceed the parent's total.
 *  - A subagent can never spend past its allocation (no overshoot); a spend
 *    that would exceed it is denied and the subagent stops immediately.
 *  - Reallocation is never silent: it is an explicit request that produces an
 *    approval/denial event for the parent.
 */
export interface ParentBudget {
  total_usd_micros: number;
  /** Already committed to subagents; remaining = total - allocated. */
  allocated_usd_micros: number;
}

export interface SubagentBudgetRequest {
  subagent_id: string;
  /** Profiler estimate of this subagent's cost. */
  estimated_usd_micros: number;
}

/** Spec output: BudgetAllocation (per subagent). */
export interface BudgetAllocation {
  subagent_id: string;
  allocated_usd_micros: number;
  remaining_parent_usd_micros: number;
}

export interface AllocateBudgetOptions {
  parent: ParentBudget;
  subagents: SubagentBudgetRequest[];
}

/**
 * Allocate each subagent a budget from the parent's remaining budget, scaled
 * proportionally to its estimated cost so the total never exceeds the
 * remaining budget. Deterministic (floor allocation, no floating drift).
 */
export function allocateBudget(opts: AllocateBudgetOptions): BudgetAllocation[] {
  const remaining = opts.parent.total_usd_micros - opts.parent.allocated_usd_micros;
  const totalEstimated = opts.subagents.reduce((sum, s) => sum + s.estimated_usd_micros, 0);
  // Scale down only when the remaining budget cannot cover the estimates;
  // otherwise grant each subagent exactly its estimate (never more).
  const scale = totalEstimated <= 0 ? 0 : Math.min(1, remaining / totalEstimated);
  let granted = 0;
  return opts.subagents.map((s) => {
    const amount = Math.floor(s.estimated_usd_micros * scale);
    granted += amount;
    return { subagent_id: s.subagent_id, allocated_usd_micros: amount, remaining_parent_usd_micros: remaining - granted };
  });
}

/** Spec output: reallocation approval event for the parent. */
export type ReallocationEvent =
  | {
      event: 'budget_reallocation_requested';
      subagent_id: string;
      requested_usd_micros: number;
      remaining_parent_usd_micros: number;
    }
  | {
      event: 'budget_reallocation_approved';
      subagent_id: string;
      approved_usd_micros: number;
      remaining_parent_usd_micros: number;
    }
  | {
      event: 'budget_reallocation_denied';
      subagent_id: string;
      requested_usd_micros: number;
      reason: string;
      remaining_parent_usd_micros: number;
    };

export interface ReallocationOutcome {
  approved: boolean;
  approved_usd_micros: number;
  events: ReallocationEvent[];
}

export interface ReallocationRequest {
  subagent_id: string;
  requested_usd_micros: number;
}

/**
 * A subagent requesting more budget must pass an explicit parent-approval
 * event. The request is approved only if it fits in the parent's remaining
 * budget; the events array records the full requested -> approved/denied trail
 * (no silent reallocation).
 */
export function requestReallocation(opts: {
  parent: ParentBudget;
  request: ReallocationRequest;
}): ReallocationOutcome {
  const remaining = opts.parent.total_usd_micros - opts.parent.allocated_usd_micros;
  const requested = opts.request.requested_usd_micros;
  const requestedEvent: ReallocationEvent = {
    event: 'budget_reallocation_requested',
    subagent_id: opts.request.subagent_id,
    requested_usd_micros: requested,
    remaining_parent_usd_micros: remaining,
  };
  if (requested > remaining) {
    const denied: ReallocationEvent = {
      event: 'budget_reallocation_denied',
      subagent_id: opts.request.subagent_id,
      requested_usd_micros: requested,
      reason: 'exceeds parent remaining budget',
      remaining_parent_usd_micros: remaining,
    };
    return { approved: false, approved_usd_micros: 0, events: [requestedEvent, denied] };
  }
  const approved: ReallocationEvent = {
    event: 'budget_reallocation_approved',
    subagent_id: opts.request.subagent_id,
    approved_usd_micros: requested,
    remaining_parent_usd_micros: remaining - requested,
  };
  return { approved: true, approved_usd_micros: requested, events: [requestedEvent, approved] };
}

/** Spec output: spend check with immediate stop on exhaustion. */
export interface SpendOutcome {
  allowed: boolean;
  /** Never negative: a denied spend cannot overshoot the allocation. */
  remaining_usd_micros: number;
  /** True when the budget is exhausted and the subagent must stop. */
  stopped: boolean;
}

export interface TrySpendOptions {
  allocated_usd_micros: number;
  spent_usd_micros: number;
  spend_usd_micros: number;
}

/**
 * Charge a spend against a subagent's allocation. A spend that would exceed
 * the allocation is denied and the subagent stops immediately — the remaining
 * budget can never go below zero (no overshoot).
 */
export function trySpend(opts: TrySpendOptions): SpendOutcome {
  const remaining = opts.allocated_usd_micros - opts.spent_usd_micros;
  if (opts.spend_usd_micros > remaining) {
    return { allowed: false, remaining_usd_micros: Math.max(0, remaining), stopped: true };
  }
  return { allowed: true, remaining_usd_micros: remaining - opts.spend_usd_micros, stopped: false };
}
