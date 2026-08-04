import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const HOOK_EVENTS = Object.freeze([
  "user_prompt_submit",
  "session_start",
  "before_provider_request",
  "pre_turn",
  "pre_tool_use",
  "post_tool_use",
  "after_response",
  "post_turn",
  "session_before_compact",
  "stop",
  "session_end",
] as const);

export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookTrust = "hash_reviewed" | "managed" | "user";

export interface HookScope {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly operation_id?: string;
  readonly attempt_id?: string;
}

export interface HookInvocationRequest {
  readonly event: HookEvent;
  readonly invocation_id: string;
  readonly idempotency_key: string;
  readonly scope: HookScope;
  readonly payload: unknown;
  readonly signal?: AbortSignal;
}

export interface HookHandlerInput {
  readonly hook_id: string;
  readonly event: HookEvent;
  readonly trust: HookTrust;
  readonly invocation_id: string;
  readonly scope: HookScope;
  readonly payload: unknown;
}

export type HookHandlerResult =
  | { readonly action: "continue" }
  | {
      readonly action: "deny" | "skip" | "force_prompt";
      readonly reason_code: string;
    }
  | { readonly action: "attenuate"; readonly payload: unknown }
  | { readonly action: "observe"; readonly follow_up?: unknown };

export interface HookHandler {
  handle(
    input: HookHandlerInput,
    signal: AbortSignal,
  ): HookHandlerResult | Promise<HookHandlerResult>;
}

interface HookRegistrationBase {
  readonly id: string;
  readonly event: HookEvent;
  readonly trust: HookTrust;
  readonly priority: number;
  readonly timeout_ms: number;
  readonly content_hash?: string;
}

export interface ManagedHookRegistration extends HookRegistrationBase {
  readonly trust: "managed";
  readonly handler: HookHandler;
  readonly execution?: never;
}

export interface ExternalHookExecution {
  readonly executable_path: string;
  readonly argv: readonly string[];
  readonly source_path: string;
}

export interface ExternalHookRegistration extends HookRegistrationBase {
  readonly trust: "hash_reviewed" | "user";
  readonly execution: ExternalHookExecution;
  readonly handler?: never;
}

export type HookRegistration =
  ManagedHookRegistration | ExternalHookRegistration;

export interface HookExecutionPort {
  execute(
    registration: ExternalHookRegistration,
    input: HookHandlerInput,
    signal: AbortSignal,
  ): Promise<HookHandlerResult>;
}

export type HookAttenuationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason_code: string };

export interface HookAttenuationPolicy {
  validate(input: {
    readonly event: HookEvent;
    readonly scope: HookScope;
    readonly original_payload: unknown;
    readonly candidate_payload: unknown;
  }): HookAttenuationDecision;
}

export interface HookDispatchOutcome {
  readonly event: HookEvent;
  readonly action: "continue" | "deny" | "skip" | "force_prompt";
  readonly payload: unknown;
  readonly reason_code?: string;
  readonly follow_ups: readonly unknown[];
  readonly replayed: boolean;
}

export interface HookJournalRecord {
  readonly scope: HookScope;
  readonly idempotency_key: string;
  readonly event: HookEvent;
  readonly input_hash: string;
  readonly outcome: HookDispatchOutcome;
}

export type HookJournalClaim =
  | { readonly status: "claimed"; readonly claim_token: string }
  | { readonly status: "replay"; readonly record: HookJournalRecord }
  | {
      readonly status: "reconciliation";
      readonly reason_code: "hook_claim_in_flight" | "hook_claim_abandoned";
    };

export interface HookJournalPort {
  /** Atomically claims a key or waits for and returns its committed record. */
  claim(input: {
    readonly scope: HookScope;
    readonly idempotency_key: string;
    readonly event: HookEvent;
    readonly input_hash: string;
  }): Promise<HookJournalClaim>;
  commit(claimToken: string, record: HookJournalRecord): Promise<void>;
  reconcile(claimToken: string): Promise<void>;
  release(claimToken: string): Promise<void>;
}

export interface HookAuditEntry {
  readonly hook_id: string;
  readonly event: HookEvent;
  readonly trust: HookTrust;
  readonly outcome:
    | "continued"
    | "attenuated"
    | "denied"
    | "skipped"
    | "forced_prompt"
    | "observed"
    | "ignored_invalid_observation";
  readonly reason_code?: string;
  readonly input_hash: string;
  readonly output_hash: string;
  readonly timestamp: string;
  readonly duration_ms: number;
}

export interface HookAuditPort {
  record(entry: HookAuditEntry): Promise<void>;
}

export interface HookSystemOptions {
  readonly journal?: HookJournalPort | undefined;
  readonly audit?: HookAuditPort | undefined;
  readonly attenuationPolicy?: HookAttenuationPolicy | undefined;
  readonly executionPort?: HookExecutionPort | undefined;
  readonly now?: (() => string) | undefined;
  readonly monotonicNow?: (() => number) | undefined;
}

const DECISION_EVENTS = new Set<HookEvent>([
  "user_prompt_submit",
  "before_provider_request",
  "pre_turn",
  "pre_tool_use",
  "session_before_compact",
]);

const TRUST_LEVELS = new Set<HookTrust>(["hash_reviewed", "managed", "user"]);
const SHA256 = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T, label: string): T {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  if (encoded === undefined)
    throw new TypeError(`${label} must be JSON-serializable`);
  return JSON.parse(encoded) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => typeof key === "string" && allowed.includes(key)) &&
    allowed
      .filter((key) => key !== "follow_up")
      .every((key) => Object.hasOwn(value, key))
  );
}

function validReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableOutcome(
  event: HookEvent,
  action: HookDispatchOutcome["action"],
  payload: unknown,
  replayed: boolean,
  options: {
    reason_code?: string;
    follow_ups?: readonly unknown[];
  } = {},
): HookDispatchOutcome {
  return deepFreeze({
    event,
    action,
    payload: cloneJson(payload, "hook outcome payload"),
    ...(options.reason_code === undefined
      ? {}
      : { reason_code: options.reason_code }),
    follow_ups: cloneJson(options.follow_ups ?? [], "hook follow-ups"),
    replayed,
  });
}

type HandlerExecution =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

export class HookSystem {
  readonly #registrations: ReadonlyMap<HookEvent, readonly HookRegistration[]>;
  readonly #journal: HookJournalPort | undefined;
  readonly #audit: HookAuditPort | undefined;
  readonly #attenuationPolicy: HookAttenuationPolicy | undefined;
  readonly #executionPort: HookExecutionPort | undefined;
  readonly #now: () => string;
  readonly #monotonicNow: () => number;
  readonly #callChain = new AsyncLocalStorage<boolean>();
  readonly #inFlight = new Map<
    string,
    {
      readonly event: HookEvent;
      readonly input_hash: string;
      readonly outcome: Promise<HookDispatchOutcome>;
    }
  >();

  constructor(
    registrations: readonly HookRegistration[],
    options: HookSystemOptions = {},
  ) {
    const ids = new Set<string>();
    const grouped = new Map<
      HookEvent,
      Array<HookRegistration & { ordinal: number }>
    >();
    registrations.forEach((registration, ordinal) => {
      this.#validateRegistration(registration, ids);
      ids.add(registration.id);
      const frozen = Object.freeze(
        registration.trust === "managed"
          ? {
              ...registration,
              handler: Object.freeze({
                handle: registration.handler.handle,
              }),
              ordinal,
            }
          : {
              ...registration,
              execution: Object.freeze({
                executable_path: registration.execution.executable_path,
                argv: Object.freeze([...registration.execution.argv]),
                source_path: registration.execution.source_path,
              }),
              ordinal,
            },
      );
      const entries = grouped.get(registration.event) ?? [];
      entries.push(frozen);
      grouped.set(registration.event, entries);
    });
    this.#registrations = new Map(
      HOOK_EVENTS.map((event) => [
        event,
        Object.freeze(
          [...(grouped.get(event) ?? [])]
            .sort(
              (left, right) =>
                left.priority - right.priority ||
                left.ordinal - right.ordinal ||
                (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
            )
            .map(({ ordinal: _ordinal, ...entry }) => Object.freeze(entry)),
        ),
      ]),
    );
    this.#journal = options.journal;
    this.#audit = options.audit;
    this.#attenuationPolicy = options.attenuationPolicy;
    this.#executionPort = options.executionPort;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async dispatch(request: HookInvocationRequest): Promise<HookDispatchOutcome> {
    this.#validateRequest(request);
    const inputPayload = deepFreeze(
      cloneJson(request.payload, "hook input payload"),
    );
    const normalizedScope = deepFreeze(cloneJson(request.scope, "hook scope"));
    const normalizedRequest = Object.freeze({
      ...request,
      scope: normalizedScope,
      payload: inputPayload,
    });
    const inputHash = hash({
      scope: normalizedScope,
      payload: inputPayload,
    });
    const flightKey = hash({
      scope: normalizedScope,
      idempotency_key: request.idempotency_key,
    });
    if (this.#callChain.getStore() === true) {
      const decisionCapable = DECISION_EVENTS.has(request.event);
      return immutableOutcome(
        request.event,
        decisionCapable ? "deny" : "continue",
        inputPayload,
        false,
        decisionCapable ? { reason_code: "recursive_hook_dispatch" } : {},
      );
    }
    const existing = this.#inFlight.get(flightKey);
    if (existing) {
      if (
        existing.event !== request.event ||
        existing.input_hash !== inputHash
      ) {
        throw new Error("hook idempotency key collision");
      }
      const outcome = await existing.outcome;
      return immutableOutcome(
        outcome.event,
        outcome.action,
        outcome.payload,
        true,
        {
          ...(outcome.reason_code === undefined
            ? {}
            : { reason_code: outcome.reason_code }),
          follow_ups: outcome.follow_ups,
        },
      );
    }

    const outcome = this.#callChain.run(true, () =>
      this.#dispatchClaimed(normalizedRequest, inputHash),
    );
    const flight = { event: request.event, input_hash: inputHash, outcome };
    this.#inFlight.set(flightKey, flight);
    try {
      return await outcome;
    } finally {
      if (this.#inFlight.get(flightKey) === flight) {
        this.#inFlight.delete(flightKey);
      }
    }
  }

  async #dispatchClaimed(
    request: HookInvocationRequest,
    inputHash: string,
  ): Promise<HookDispatchOutcome> {
    let claimToken: string | undefined;
    if (this.#journal) {
      const claim = await this.#journal.claim({
        scope: request.scope,
        idempotency_key: request.idempotency_key,
        event: request.event,
        input_hash: inputHash,
      });
      if (claim.status === "replay") {
        if (
          claim.record.event !== request.event ||
          claim.record.input_hash !== inputHash ||
          canonicalJson(claim.record.scope) !== canonicalJson(request.scope)
        ) {
          throw new Error("hook idempotency key collision");
        }
        return immutableOutcome(
          claim.record.outcome.event,
          claim.record.outcome.action,
          claim.record.outcome.payload,
          true,
          {
            ...(claim.record.outcome.reason_code === undefined
              ? {}
              : { reason_code: claim.record.outcome.reason_code }),
            follow_ups: claim.record.outcome.follow_ups,
          },
        );
      }
      if (claim.status === "reconciliation") {
        const decisionCapable = DECISION_EVENTS.has(request.event);
        return immutableOutcome(
          request.event,
          decisionCapable ? "deny" : "continue",
          request.payload,
          false,
          decisionCapable ? { reason_code: claim.reason_code } : {},
        );
      }
      if (claim.claim_token.trim().length === 0) {
        throw new Error("hook journal returned an invalid claim token");
      }
      claimToken = claim.claim_token;
    }

    try {
      const outcome = await this.#execute(request);
      if (this.#journal && claimToken) {
        await this.#journal.commit(claimToken, {
          scope: request.scope,
          idempotency_key: request.idempotency_key,
          event: request.event,
          input_hash: inputHash,
          outcome,
        });
      }
      return outcome;
    } catch (error) {
      if (this.#journal && claimToken) {
        try {
          await this.#journal.reconcile(claimToken);
        } catch {
          // Preserve the original execution/commit failure. A claim that
          // cannot be transitioned remains durable and must reconcile on
          // lease expiry rather than being hidden or released for retry.
        }
      }
      throw error;
    }
  }

  async #execute(request: HookInvocationRequest): Promise<HookDispatchOutcome> {
    const inputPayload = request.payload;
    const decisionCapable = DECISION_EVENTS.has(request.event);
    if (request.signal?.aborted) {
      return immutableOutcome(
        request.event,
        decisionCapable ? "deny" : "continue",
        inputPayload,
        false,
        decisionCapable ? { reason_code: "hook_cancelled" } : {},
      );
    }

    let payload = inputPayload;
    const followUps: unknown[] = [];
    for (const hook of this.#registrations.get(request.event)!) {
      const beforeHash = hash(payload);
      const started = this.#monotonicNow();
      const execution = await this.#executeHandler(hook, request, payload);
      if (execution.kind !== "result") {
        const reasonCode =
          execution.kind === "timeout"
            ? "hook_timeout"
            : execution.kind === "cancelled"
              ? "hook_cancelled"
              : execution.kind === "unavailable"
                ? "untrusted_hook_execution_unavailable"
                : "hook_error";
        await this.#recordAudit(hook, beforeHash, hash(payload), started, {
          outcome: decisionCapable ? "denied" : "ignored_invalid_observation",
          reason_code: reasonCode,
        });
        if (decisionCapable) {
          return immutableOutcome(request.event, "deny", payload, false, {
            reason_code: reasonCode,
            follow_ups: followUps,
          });
        }
        continue;
      }

      const result = execution.result;
      if (!isRecord(result) || typeof result.action !== "string") {
        if (decisionCapable) {
          return this.#denyInvalidResult(
            hook,
            request,
            payload,
            followUps,
            started,
            beforeHash,
          );
        }
        await this.#recordAudit(hook, beforeHash, hash(payload), started, {
          outcome: "ignored_invalid_observation",
          reason_code: "invalid_hook_result",
        });
        continue;
      }

      if (decisionCapable) {
        if (result.action === "continue" && exactKeys(result, ["action"])) {
          await this.#recordAudit(hook, beforeHash, hash(payload), started, {
            outcome: "continued",
          });
          continue;
        }
        if (
          result.action === "attenuate" &&
          exactKeys(result, ["action", "payload"])
        ) {
          const candidate = deepFreeze(
            cloneJson(result.payload, "attenuated hook payload"),
          );
          let decision: HookAttenuationDecision;
          try {
            decision = this.#attenuationPolicy?.validate({
              event: request.event,
              scope: request.scope,
              original_payload: payload,
              candidate_payload: candidate,
            }) ?? {
              allowed: false,
              reason_code: "hook_attenuation_policy_required",
            };
          } catch {
            decision = {
              allowed: false,
              reason_code: "hook_attenuation_policy_failed",
            };
          }
          if (!decision.allowed) {
            return this.#denyInvalidResult(
              hook,
              request,
              payload,
              followUps,
              started,
              beforeHash,
              decision.reason_code,
            );
          }
          payload = candidate;
          await this.#recordAudit(hook, beforeHash, hash(candidate), started, {
            outcome: "attenuated",
          });
          continue;
        }
        if (
          ["deny", "skip", "force_prompt"].includes(result.action) &&
          exactKeys(result, ["action", "reason_code"]) &&
          validReason(result.reason_code)
        ) {
          const action = result.action as "deny" | "skip" | "force_prompt";
          await this.#recordAudit(hook, beforeHash, hash(payload), started, {
            outcome:
              action === "deny"
                ? "denied"
                : action === "skip"
                  ? "skipped"
                  : "forced_prompt",
            reason_code: result.reason_code,
          });
          return immutableOutcome(request.event, action, payload, false, {
            reason_code: result.reason_code,
            follow_ups: followUps,
          });
        }
        return this.#denyInvalidResult(
          hook,
          request,
          payload,
          followUps,
          started,
          beforeHash,
        );
      }

      if (
        result.action === "observe" &&
        exactKeys(result, ["action", "follow_up"])
      ) {
        if (Object.hasOwn(result, "follow_up")) {
          followUps.push(cloneJson(result.follow_up, "hook follow-up"));
        }
        await this.#recordAudit(hook, beforeHash, hash(payload), started, {
          outcome: "observed",
        });
        continue;
      }
      if (result.action === "continue" && exactKeys(result, ["action"])) {
        await this.#recordAudit(hook, beforeHash, hash(payload), started, {
          outcome: "observed",
        });
        continue;
      }
      await this.#recordAudit(hook, beforeHash, hash(payload), started, {
        outcome: "ignored_invalid_observation",
        reason_code: "observational_hook_cannot_mutate",
      });
    }

    return immutableOutcome(request.event, "continue", payload, false, {
      follow_ups: followUps,
    });
  }

  #validateRegistration(
    registration: HookRegistration,
    ids: ReadonlySet<string>,
  ): void {
    if (!registration || typeof registration !== "object") {
      throw new TypeError("hook registration must be an object");
    }
    if (
      typeof registration.id !== "string" ||
      registration.id.trim().length === 0
    ) {
      throw new TypeError("hook id is required");
    }
    if (ids.has(registration.id))
      throw new TypeError(`duplicate hook id: ${registration.id}`);
    if (!HOOK_EVENTS.includes(registration.event))
      throw new TypeError("unknown hook event");
    if (!TRUST_LEVELS.has(registration.trust))
      throw new TypeError("invalid hook trust");
    if (
      registration.trust === "hash_reviewed" &&
      !SHA256.test(registration.content_hash ?? "")
    ) {
      throw new TypeError("hash_reviewed hook requires a SHA-256 content_hash");
    }
    if (!Number.isSafeInteger(registration.priority)) {
      throw new TypeError("hook priority must be a safe integer");
    }
    if (
      !Number.isSafeInteger(registration.timeout_ms) ||
      registration.timeout_ms <= 0
    ) {
      throw new TypeError("hook timeout_ms must be a positive safe integer");
    }
    if (
      registration.trust === "managed" &&
      (!registration.handler ||
        typeof registration.handler.handle !== "function")
    ) {
      throw new TypeError("managed hook handler is required");
    }
    if (
      registration.trust === "managed" &&
      "execution" in registration &&
      registration.execution !== undefined
    ) {
      throw new TypeError("managed hooks cannot use external execution");
    }
    if (registration.trust !== "managed") {
      if ("handler" in registration && registration.handler !== undefined) {
        throw new TypeError("untrusted hook callbacks are forbidden");
      }
      const execution = registration.execution;
      if (
        !execution ||
        typeof execution.executable_path !== "string" ||
        execution.executable_path.trim().length === 0 ||
        !Array.isArray(execution.argv) ||
        execution.argv.some((value) => typeof value !== "string") ||
        typeof execution.source_path !== "string" ||
        execution.source_path.trim().length === 0
      ) {
        throw new TypeError("external hook execution descriptor is required");
      }
    }
  }

  #validateRequest(request: HookInvocationRequest): void {
    if (!HOOK_EVENTS.includes(request.event))
      throw new TypeError("unknown hook event");
    for (const [label, value] of [
      ["invocation_id", request.invocation_id],
      ["idempotency_key", request.idempotency_key],
      ["tenant_id", request.scope?.tenant_id],
      ["run_id", request.scope?.run_id],
      ["session_id", request.scope?.session_id],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${label} is required`);
      }
    }
    for (const [label, value] of [
      ["operation_id", request.scope.operation_id],
      ["attempt_id", request.scope.attempt_id],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== "string" || value.trim().length === 0)
      ) {
        throw new TypeError(`${label} must be non-empty when provided`);
      }
    }
  }

  async #executeHandler(
    hook: HookRegistration,
    request: HookInvocationRequest,
    payload: unknown,
  ): Promise<HandlerExecution> {
    const controller = new AbortController();
    let settleFailure!: (value: HandlerExecution) => void;
    const failure = new Promise<HandlerExecution>((resolve) => {
      settleFailure = resolve;
    });
    const fail = (value: HandlerExecution): void => {
      settleFailure(value);
      controller.abort(value.kind);
    };
    const timeout = setTimeout(
      () => fail({ kind: "timeout" }),
      hook.timeout_ms,
    );
    const cancel = () => fail({ kind: "cancelled" });
    request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const handler: Promise<HandlerExecution> = Promise.resolve().then(
        async () => {
          try {
            const input = deepFreeze({
              hook_id: hook.id,
              event: request.event,
              trust: hook.trust,
              invocation_id: request.invocation_id,
              scope: request.scope,
              payload,
            });
            if (hook.trust !== "managed" && !this.#executionPort) {
              return { kind: "unavailable" };
            }
            const result =
              hook.trust === "managed"
                ? await hook.handler.handle(input, controller.signal)
                : await this.#executionPort!.execute(
                    hook,
                    input,
                    controller.signal,
                  );
            return { kind: "result", result };
          } catch {
            return { kind: "error" };
          }
        },
      );
      return await Promise.race([handler, failure]);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", cancel);
    }
  }

  async #denyInvalidResult(
    hook: HookRegistration,
    request: HookInvocationRequest,
    payload: unknown,
    followUps: readonly unknown[],
    started: number,
    beforeHash: string,
    reasonCode = "invalid_hook_result",
  ): Promise<HookDispatchOutcome> {
    await this.#recordAudit(hook, beforeHash, hash(payload), started, {
      outcome: "denied",
      reason_code: reasonCode,
    });
    return immutableOutcome(request.event, "deny", payload, false, {
      reason_code: reasonCode,
      follow_ups: followUps,
    });
  }

  async #recordAudit(
    hook: HookRegistration,
    inputHash: string,
    outputHash: string,
    started: number,
    result: Pick<HookAuditEntry, "outcome" | "reason_code">,
  ): Promise<void> {
    if (!this.#audit) return;
    const timestamp = this.#now();
    if (!Number.isFinite(Date.parse(timestamp)))
      throw new TypeError("invalid hook audit clock");
    await this.#audit.record(
      Object.freeze({
        hook_id: hook.id,
        event: hook.event,
        trust: hook.trust,
        outcome: result.outcome,
        ...(result.reason_code === undefined
          ? {}
          : { reason_code: result.reason_code }),
        input_hash: inputHash,
        output_hash: outputHash,
        timestamp,
        duration_ms: Math.max(0, Math.ceil(this.#monotonicNow() - started)),
      }),
    );
  }
}
