import type {
  BudgetLedger,
  BudgetPricing,
} from "../packages/runtime-core/src/index.js";

export interface RuntimeBudgetPreflight {
  readonly run_id: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly remaining_tokens: number;
  readonly requested_max_output_tokens: number;
  readonly estimated_input_tokens: number;
}

export interface RuntimeBudgetDecision {
  readonly allowed: boolean;
  readonly reason: "within_budget" | "budget_exhausted";
  readonly max_output_tokens: number;
}

export interface RuntimeBudgetUsage {
  readonly run_id: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface RuntimeBudgetPort {
  beforeModelCall(input: RuntimeBudgetPreflight): RuntimeBudgetDecision;
  afterModelCall(input: RuntimeBudgetUsage): void;
}

export interface RuntimeBudgetScope {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
}

export interface RuntimeBudgetFactoryPort {
  bind(input: { readonly scope: RuntimeBudgetScope }): RuntimeBudgetPort;
}

export interface RuntimeBudgetEstimate {
  readonly cached_input_tokens: number;
  readonly uncached_input_tokens: number;
  readonly dag_node_count?: number;
}

export interface RuntimeBudgetEstimatorPort {
  estimate(input: RuntimeBudgetPreflight): RuntimeBudgetEstimate;
}

export interface BudgetLedgerRuntimeAdapterOptions {
  readonly ledger: BudgetLedger;
  readonly pricing: BudgetPricing;
  readonly estimator?: RuntimeBudgetEstimatorPort;
}

interface PendingBudgetCall {
  readonly call_id: string;
}

/**
 * Root integration adapter for the unique runtime-core BudgetLedger authority.
 * Actual usage is conservatively charged as uncached until the provider usage
 * contract carries an independently measured cache-hit count.
 */
export class BudgetLedgerRuntimeAdapter implements RuntimeBudgetPort {
  readonly #ledger: BudgetLedger;
  readonly #pricing: BudgetPricing;
  readonly #estimator: RuntimeBudgetEstimatorPort | undefined;
  readonly #pending = new Map<string, PendingBudgetCall>();

  constructor(options: BudgetLedgerRuntimeAdapterOptions) {
    this.#ledger = options.ledger;
    this.#pricing = options.pricing;
    this.#estimator = options.estimator;
  }

  beforeModelCall(input: RuntimeBudgetPreflight): RuntimeBudgetDecision {
    const callId = this.#callId(input);
    if (this.#pending.has(callId)) {
      throw new Error("budget call is already pending");
    }
    const estimate = this.#estimator?.estimate(input) ?? {
      cached_input_tokens: 0,
      uncached_input_tokens: input.estimated_input_tokens,
      dag_node_count: 1,
    };
    const authorization = this.#ledger.authorizeModelCall({
      cached_input_tokens: estimate.cached_input_tokens,
      uncached_input_tokens: estimate.uncached_input_tokens,
      output_tokens: input.requested_max_output_tokens,
      pricing: this.#pricing,
      requested_max_output_tokens: input.requested_max_output_tokens,
      ...(estimate.dag_node_count === undefined
        ? {}
        : { dag_node_count: estimate.dag_node_count }),
    });
    if (!authorization.allowed) {
      return {
        allowed: false,
        reason: "budget_exhausted",
        max_output_tokens: 0,
      };
    }
    this.#pending.set(callId, { call_id: callId });
    return {
      allowed: true,
      reason: "within_budget",
      max_output_tokens:
        authorization.max_output_tokens ?? input.requested_max_output_tokens,
    };
  }

  afterModelCall(input: RuntimeBudgetUsage): void {
    const callId = this.#callId(input);
    const pending = this.#pending.get(callId);
    if (pending === undefined) {
      throw new Error("budget usage has no authorized pending call");
    }
    this.#ledger.recordModelCall({
      call_id: pending.call_id,
      cached_input_tokens: 0,
      uncached_input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      pricing: this.#pricing,
    });
    this.#pending.delete(callId);
  }

  #callId(input: {
    readonly run_id: string;
    readonly iteration: number;
    readonly attempt: number;
  }): string {
    return `${input.run_id}:${input.iteration}:${input.attempt}`;
  }
}
