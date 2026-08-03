import { createHash } from "node:crypto";

export interface BudgetScope {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
}

export interface BudgetCeiling {
  readonly usd_micros: number;
}

export interface BudgetPricing {
  readonly cached_input_micros_per_million: number;
  readonly uncached_input_micros_per_million: number;
  readonly output_micros_per_million: number;
}

export interface ModelCallBudgetProjection {
  readonly cached_input_tokens: number;
  readonly uncached_input_tokens: number;
  readonly output_tokens: number;
  readonly pricing: BudgetPricing;
}

export interface BudgetProjection {
  readonly projected_usd_micros: number;
}

export interface BudgetAuthorization extends BudgetProjection {
  readonly allowed: boolean;
  readonly action: "allow" | "reduce_output" | "stop";
  readonly reason: "within_budget" | "budget_exhausted";
  readonly remaining_usd_micros: number;
  readonly all_miss_budget_risk: boolean;
  readonly max_output_tokens?: number;
}

export interface BudgetDegradationRule {
  readonly remaining_ratio_at_or_below: number;
  readonly action: "reduce_output";
  readonly max_output_tokens: number;
}

export interface BudgetLedgerOptions {
  readonly scope: BudgetScope;
  readonly ceiling: BudgetCeiling;
  readonly journal: BudgetJournalPort;
  readonly degradation_matrix?: readonly BudgetDegradationRule[];
}

export interface BudgetEvent {
  readonly schema_version: "budget-event/v1";
  readonly scope: BudgetScope;
  readonly sequence: number;
  readonly previous_hash: string;
  readonly event_hash: string;
  readonly call_id: string;
  readonly input_hash: string;
  readonly cached_input_tokens: number;
  readonly uncached_input_tokens: number;
  readonly output_tokens: number;
  readonly usd_micros: number;
}

export interface BudgetJournalPort {
  read(): readonly BudgetEvent[];
  append(event: BudgetEvent): void;
}

export interface BudgetRecordResult {
  readonly replayed: boolean;
  readonly spent_usd_micros: number;
}

export interface BudgetSnapshot {
  readonly spent_usd_micros: number;
  readonly remaining_usd_micros: number;
}

const pricedMicros = (tokens: number, microsPerMillion: number): number => {
  const value =
    (BigInt(tokens) * BigInt(microsPerMillion) + 999_999n) / 1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("projected_usd_micros must be a non-negative safe integer");
  }
  return Number(value);
};

function nonNegativeSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
}

function requiredId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

const hashEvent = (event: Omit<BudgetEvent, "event_hash">): string =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");

const hashRecordInput = (
  input: ModelCallBudgetProjection & { readonly call_id: string },
): string => createHash("sha256").update(JSON.stringify(input)).digest("hex");

export class BudgetLedger {
  readonly #scope: BudgetScope;
  readonly #ceiling: BudgetCeiling;
  readonly #journal: BudgetJournalPort;
  readonly #degradationMatrix: readonly BudgetDegradationRule[];
  readonly #events = new Map<string, BudgetEvent>();
  #spent = 0;

  constructor(options: BudgetLedgerOptions) {
    requiredId("tenant_id", options.scope.tenant_id);
    requiredId("run_id", options.scope.run_id);
    requiredId("session_id", options.scope.session_id);
    nonNegativeSafeInteger("ceiling.usd_micros", options.ceiling.usd_micros);
    if (
      options.journal === undefined ||
      typeof options.journal.read !== "function" ||
      typeof options.journal.append !== "function"
    ) {
      throw new Error("budget journal is required");
    }
    for (const rule of options.degradation_matrix ?? []) {
      if (
        !Number.isFinite(rule.remaining_ratio_at_or_below) ||
        rule.remaining_ratio_at_or_below < 0 ||
        rule.remaining_ratio_at_or_below > 1
      ) {
        throw new Error("remaining_ratio_at_or_below must be between 0 and 1");
      }
      if (
        !Number.isSafeInteger(rule.max_output_tokens) ||
        rule.max_output_tokens <= 0
      ) {
        throw new Error("max_output_tokens must be a positive safe integer");
      }
      if (rule.action !== "reduce_output") {
        throw new Error("unsupported budget degradation action");
      }
    }
    this.#scope = Object.freeze({ ...options.scope });
    this.#ceiling = Object.freeze({ ...options.ceiling });
    this.#journal = options.journal;
    this.#degradationMatrix = Object.freeze(
      (options.degradation_matrix ?? []).map((rule) =>
        Object.freeze({ ...rule }),
      ),
    );
    let previousHash = "0".repeat(64);
    for (const [sequence, event] of options.journal.read().entries()) {
      const { event_hash: eventHash, ...payload } = event;
      if (event.schema_version !== "budget-event/v1") {
        throw new Error("budget journal schema version is invalid");
      }
      requiredId("budget event call_id", event.call_id);
      nonNegativeSafeInteger("budget event sequence", event.sequence);
      nonNegativeSafeInteger("budget event cached_input_tokens", event.cached_input_tokens);
      nonNegativeSafeInteger("budget event uncached_input_tokens", event.uncached_input_tokens);
      nonNegativeSafeInteger("budget event output_tokens", event.output_tokens);
      nonNegativeSafeInteger("budget event usd_micros", event.usd_micros);
      if (
        event.scope.tenant_id !== this.#scope.tenant_id ||
        event.scope.run_id !== this.#scope.run_id ||
        event.scope.session_id !== this.#scope.session_id
      ) {
        throw new Error("budget journal scope mismatch");
      }
      if (
        event.sequence !== sequence ||
        event.previous_hash !== previousHash ||
        hashEvent(payload) !== eventHash
      ) {
        throw new Error("budget journal hash chain is invalid");
      }
      if (this.#events.has(event.call_id)) {
        throw new Error("budget journal contains a duplicate call id");
      }
      this.#events.set(event.call_id, event);
      this.#spent += event.usd_micros;
      nonNegativeSafeInteger("budget journal spent_usd_micros", this.#spent);
      previousHash = eventHash;
    }
  }

  projectModelCall(input: ModelCallBudgetProjection): BudgetProjection {
    nonNegativeSafeInteger("cached_input_tokens", input.cached_input_tokens);
    nonNegativeSafeInteger("uncached_input_tokens", input.uncached_input_tokens);
    nonNegativeSafeInteger("output_tokens", input.output_tokens);
    nonNegativeSafeInteger(
      "cached_input_micros_per_million",
      input.pricing.cached_input_micros_per_million,
    );
    nonNegativeSafeInteger(
      "uncached_input_micros_per_million",
      input.pricing.uncached_input_micros_per_million,
    );
    nonNegativeSafeInteger(
      "output_micros_per_million",
      input.pricing.output_micros_per_million,
    );
    const projected =
        pricedMicros(
          input.cached_input_tokens,
          input.pricing.cached_input_micros_per_million,
        ) +
        pricedMicros(
          input.uncached_input_tokens,
          input.pricing.uncached_input_micros_per_million,
        ) +
        pricedMicros(
          input.output_tokens,
          input.pricing.output_micros_per_million,
        );
    nonNegativeSafeInteger("projected_usd_micros", projected);
    return { projected_usd_micros: projected };
  }

  authorizeModelCall(
    input: ModelCallBudgetProjection & {
      readonly dag_node_count?: number;
      readonly requested_max_output_tokens?: number;
    },
  ): BudgetAuthorization {
    const projection = this.projectModelCall(input);
    const remaining = this.snapshot().remaining_usd_micros;
    const allowed = projection.projected_usd_micros <= remaining;
    const ratio =
      this.#ceiling.usd_micros === 0
        ? 0
        : remaining / this.#ceiling.usd_micros;
    const degradation = this.#degradationMatrix
      .filter((rule) => ratio <= rule.remaining_ratio_at_or_below)
      .sort(
        (a, b) =>
          a.remaining_ratio_at_or_below - b.remaining_ratio_at_or_below,
      )[0];
    return {
      ...projection,
      allowed,
      action: allowed ? (degradation?.action ?? "allow") : "stop",
      reason: allowed ? "within_budget" : "budget_exhausted",
      remaining_usd_micros: remaining,
      all_miss_budget_risk:
        (input.dag_node_count ?? 1) > 1 &&
        input.uncached_input_tokens > 0 &&
        input.cached_input_tokens === 0,
      ...(allowed && degradation
        ? {
            max_output_tokens: Math.min(
              input.requested_max_output_tokens ?? degradation.max_output_tokens,
              degradation.max_output_tokens,
            ),
          }
        : {}),
    };
  }

  recordModelCall(
    input: ModelCallBudgetProjection & { readonly call_id: string },
  ): BudgetRecordResult {
    requiredId("call_id", input.call_id);
    const inputHash = hashRecordInput(input);
    const existing = this.#events.get(input.call_id);
    if (existing) {
      if (existing.input_hash !== inputHash)
        throw new Error("budget call id collision");
      return { replayed: true, spent_usd_micros: this.#spent };
    }
    const projection = this.projectModelCall(input);
    const previous = [...this.#events.values()].at(-1);
    const payload: Omit<BudgetEvent, "event_hash"> = {
      schema_version: "budget-event/v1",
      scope: this.#scope,
      sequence: this.#events.size,
      previous_hash: previous?.event_hash ?? "0".repeat(64),
      call_id: input.call_id,
      input_hash: inputHash,
      cached_input_tokens: input.cached_input_tokens,
      uncached_input_tokens: input.uncached_input_tokens,
      output_tokens: input.output_tokens,
      usd_micros: projection.projected_usd_micros,
    };
    const event = Object.freeze({ ...payload, event_hash: hashEvent(payload) });
    this.#journal.append(event);
    this.#events.set(event.call_id, event);
    this.#spent += event.usd_micros;
    return { replayed: false, spent_usd_micros: this.#spent };
  }

  snapshot(): BudgetSnapshot {
    return {
      spent_usd_micros: this.#spent,
      remaining_usd_micros: Math.max(
        0,
        this.#ceiling.usd_micros - this.#spent,
      ),
    };
  }
}
