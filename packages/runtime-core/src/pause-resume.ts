export type PauseResumeEffectState =
  | "PRE_DISPATCH"
  | "IN_FLIGHT"
  | "EFFECT_UNKNOWN"
  | "RECONCILING"
  | "EFFECT_CONFIRMED"
  | "DEFINITELY_FAILED_NO_EFFECT"
  | "AWAITING_HUMAN";

/**
 * GLM fix: Valid state transitions for PauseResumeEffectState.
 * Derived from spec/state-machines/external-effect.machine.json.
 * Prevents arbitrary state-to-state transitions.
 */
const VALID_TRANSITIONS: Readonly<Record<PauseResumeEffectState, readonly PauseResumeEffectState[]>> = Object.freeze({
  PRE_DISPATCH: ["DEFINITELY_FAILED_NO_EFFECT"],
  IN_FLIGHT: ["EFFECT_CONFIRMED", "EFFECT_UNKNOWN", "DEFINITELY_FAILED_NO_EFFECT"],
  EFFECT_UNKNOWN: ["RECONCILING"],
  RECONCILING: ["EFFECT_CONFIRMED", "AWAITING_HUMAN", "DEFINITELY_FAILED_NO_EFFECT"],
  EFFECT_CONFIRMED: [], // terminal
  DEFINITELY_FAILED_NO_EFFECT: [], // terminal
  AWAITING_HUMAN: ["EFFECT_CONFIRMED", "DEFINITELY_FAILED_NO_EFFECT"],
});

function assertValidTransition(from: PauseResumeEffectState, to: PauseResumeEffectState): void {
  if (from === to) return; // idempotent re-recording is allowed
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(
      `invalid pause/resume state transition: ${from} -> ${to}`,
    );
  }
}

/** Maximum size for stored_outcome_json to prevent memory exhaustion. */
const MAX_STORED_OUTCOME_BYTES = 1024 * 1024; // 1 MiB

export interface PauseResumeEffectRecord {
  readonly operation_id: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly attempt_id: string;
  readonly tool_name: string;
  readonly idempotency_key: string;
  readonly effect_state: PauseResumeEffectState;
  readonly receipt_json: string | null;
}

export interface PauseResumeJournalPort {
  getOperation(operationId: string): PauseResumeEffectRecord | null;
  recordOperation(record: PauseResumeEffectRecord): void;
}

export type EffectResolution =
  | { readonly status: "confirmed"; readonly stored_outcome_json: string }
  | { readonly status: "no_effect" }
  | { readonly status: "indeterminate" };

export interface EffectReadBackPort {
  query(operation: PauseResumeEffectRecord): Promise<EffectResolution>;
}

export interface EffectReconciliationPort {
  reconcile(operation: PauseResumeEffectRecord): Promise<EffectResolution>;
}

export type PauseResumeAction =
  | { readonly action: "continue_next_step"; readonly operation_id: string }
  | {
      readonly action: "retry_new_attempt";
      readonly operation_id: string;
      readonly previous_attempt_id: string;
      readonly requires_new_capability: true;
      readonly restart_pipeline_at: "schema";
    }
  | {
      readonly action: "await_human";
      readonly operation_id: string;
      readonly reason: "effect_state_indeterminate";
    };

export interface PauseResumeControllerOptions {
  readonly journal: PauseResumeJournalPort;
  readonly readBack: EffectReadBackPort;
  readonly reconciliation: EffectReconciliationPort;
}

function requiredId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

/**
 * Effect-state-aware resume authority. It never executes an action or issues a
 * Capability; retries are returned to the existing Action Control pipeline.
 */
export class PauseResumeController {
  readonly #journal: PauseResumeJournalPort;
  readonly #readBack: EffectReadBackPort;
  readonly #reconciliation: EffectReconciliationPort;

  constructor(options: PauseResumeControllerOptions) {
    if (
      options?.journal === undefined ||
      typeof options.journal.getOperation !== "function" ||
      typeof options.journal.recordOperation !== "function"
    ) {
      throw new TypeError("pause/resume journal is required");
    }
    if (typeof options.readBack?.query !== "function") {
      throw new TypeError("pause/resume read-back port is required");
    }
    if (typeof options.reconciliation?.reconcile !== "function") {
      throw new TypeError("pause/resume reconciliation port is required");
    }
    this.#journal = options.journal;
    this.#readBack = options.readBack;
    this.#reconciliation = options.reconciliation;
  }

  async resume(input: {
    readonly run_id: string;
    readonly operation_id: string;
  }): Promise<PauseResumeAction> {
    requiredId("run_id", input?.run_id);
    requiredId("operation_id", input?.operation_id);
    const operation = this.#journal.getOperation(input.operation_id);
    if (operation === null) throw new Error("pause/resume operation not found");
    if (operation.run_id !== input.run_id) {
      throw new Error("pause/resume operation scope mismatch");
    }

    switch (operation.effect_state) {
      case "PRE_DISPATCH":
        // PRE_DISPATCH means the dispatch was initiated but never confirmed
        // as IN_FLIGHT. By design, we treat this as "definitely failed, no
        // effect" because the dispatch boundary requires a confirmed
        // IN_FLIGHT journal entry before an effect is considered possibly
        // committed. This is validated by the test suite.
        this.#transition(operation, "DEFINITELY_FAILED_NO_EFFECT");
        return this.#retry(operation);
      case "IN_FLIGHT":
        return this.#resolveReadBack(operation);
      case "EFFECT_UNKNOWN": {
        const reconciling = this.#transition(operation, "RECONCILING");
        return this.#reconcile(reconciling);
      }
      case "RECONCILING":
        return this.#reconcile(operation);
      case "EFFECT_CONFIRMED":
        return this.#continue(operation);
      case "DEFINITELY_FAILED_NO_EFFECT":
        return this.#retry(operation);
      case "AWAITING_HUMAN":
        return this.#awaitHuman(operation);
      default:
        throw new Error("unsupported pause/resume effect state");
    }
  }

  async #resolveReadBack(
    operation: PauseResumeEffectRecord,
  ): Promise<PauseResumeAction> {
    let resolution: EffectResolution;
    try {
      resolution = await this.#readBack.query(operation);
    } catch {
      const unknown = this.#transition(operation, "EFFECT_UNKNOWN");
      const reconciling = this.#transition(unknown, "RECONCILING");
      return this.#reconcile(reconciling);
    }
    if (resolution.status === "confirmed") {
      this.#confirmed(operation, resolution.stored_outcome_json);
      return this.#continue(operation);
    }
    if (resolution.status === "no_effect") {
      this.#transition(operation, "DEFINITELY_FAILED_NO_EFFECT");
      return this.#retry(operation);
    }
    const unknown = this.#transition(operation, "EFFECT_UNKNOWN");
    const reconciling = this.#transition(unknown, "RECONCILING");
    return this.#reconcile(reconciling);
  }

  async #reconcile(
    operation: PauseResumeEffectRecord,
  ): Promise<PauseResumeAction> {
    let resolution: EffectResolution;
    try {
      resolution = await this.#reconciliation.reconcile(operation);
    } catch {
      this.#transition(operation, "AWAITING_HUMAN");
      return this.#awaitHuman(operation);
    }
    if (resolution.status === "confirmed") {
      this.#confirmed(operation, resolution.stored_outcome_json);
      return this.#continue(operation);
    }
    if (resolution.status === "no_effect") {
      this.#transition(operation, "DEFINITELY_FAILED_NO_EFFECT");
      return this.#retry(operation);
    }
    this.#transition(operation, "AWAITING_HUMAN");
    return this.#awaitHuman(operation);
  }

  #confirmed(
    operation: PauseResumeEffectRecord,
    storedOutcomeJson: string,
  ): PauseResumeEffectRecord {
    requiredId("stored_outcome_json", storedOutcomeJson);
    // GLM fix: enforce size limit on stored_outcome_json
    if (Buffer.byteLength(storedOutcomeJson, "utf8") > MAX_STORED_OUTCOME_BYTES) {
      throw new Error(
        `stored_outcome_json exceeds maximum size of ${MAX_STORED_OUTCOME_BYTES} bytes`,
      );
    }
    try {
      JSON.parse(storedOutcomeJson);
    } catch {
      throw new Error("confirmed effect outcome must be valid JSON");
    }
    return this.#transition(
      operation,
      "EFFECT_CONFIRMED",
      storedOutcomeJson,
    );
  }

  #transition(
    operation: PauseResumeEffectRecord,
    effectState: PauseResumeEffectState,
    receiptJson: string | null = operation.receipt_json,
  ): PauseResumeEffectRecord {
    // GLM fix: validate state transition before recording
    assertValidTransition(operation.effect_state, effectState);
    const next = Object.freeze({
      ...operation,
      effect_state: effectState,
      receipt_json: receiptJson,
    });
    this.#journal.recordOperation(next);
    return next;
  }

  #continue(operation: PauseResumeEffectRecord): PauseResumeAction {
    return Object.freeze({
      action: "continue_next_step",
      operation_id: operation.operation_id,
    });
  }

  #retry(operation: PauseResumeEffectRecord): PauseResumeAction {
    return Object.freeze({
      action: "retry_new_attempt",
      operation_id: operation.operation_id,
      previous_attempt_id: operation.attempt_id,
      requires_new_capability: true,
      restart_pipeline_at: "schema",
    });
  }

  #awaitHuman(operation: PauseResumeEffectRecord): PauseResumeAction {
    return Object.freeze({
      action: "await_human",
      operation_id: operation.operation_id,
      reason: "effect_state_indeterminate",
    });
  }
}
