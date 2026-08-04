import { createHash } from "node:crypto";

export const STEERING_QUEUES = Object.freeze([
  "steer",
  "follow_up",
  "next_turn",
] as const);
export const STEERING_PRIORITIES = Object.freeze([
  "kill",
  "security",
  "human_cancel",
  "human_correction",
  "admin",
  "user",
  "supervisor",
  "agent",
] as const);

export type SteeringQueue = (typeof STEERING_QUEUES)[number];
export type SteeringPriority = (typeof STEERING_PRIORITIES)[number];
export type SteeringEffectState =
  | "PRE_DISPATCH"
  | "IN_FLIGHT"
  | "EFFECT_UNKNOWN"
  | "EFFECT_CONFIRMED"
  | "DEFINITELY_FAILED_NO_EFFECT"
  | null;

export interface SteeringScope {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
}
export interface SteeringRequest {
  readonly command_id: string;
  readonly scope: SteeringScope;
  readonly queue: SteeringQueue;
  readonly priority: SteeringPriority;
  readonly content: unknown;
}
export interface SteeringCommand extends SteeringRequest {
  readonly ordinal: number;
  readonly fingerprint: string;
}
export type SteeringEvent =
  | {
      readonly schema_version: "steering-event/v1";
      readonly kind: "enqueued";
      readonly scope: SteeringScope;
      readonly command: SteeringCommand;
    }
  | {
      readonly schema_version: "steering-event/v1";
      readonly kind: "consumed";
      readonly scope: SteeringScope;
      readonly command_id: string;
    };
export interface SteeringJournalPort {
  read(): readonly SteeringEvent[];
  append(event: SteeringEvent): void;
}
export type SteeringDisposition =
  "queued" | "stop_requested" | "reconciliation_required";
export interface SteeringEnqueueResult {
  readonly command: SteeringCommand;
  readonly replayed: boolean;
  readonly disposition: SteeringDisposition;
}
export interface SteeringControllerOptions {
  readonly scope: SteeringScope;
  readonly journal: SteeringJournalPort;
  readonly effectState?: () => SteeringEffectState;
  readonly onImmediate?: (
    command: SteeringCommand,
    disposition: Exclude<SteeringDisposition, "queued">,
  ) => void;
}
export type SteeringListener = (command: SteeringCommand) => void;

export class SteeringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteeringError";
    Object.setPrototypeOf(this, SteeringError.prototype);
  }
}

const PRIORITY_RANK = new Map(
  STEERING_PRIORITIES.map((priority, rank) => [priority, rank]),
);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function requiredId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new SteeringError(`${label} is required`);
}
function cloneJson<T>(value: T, label: string): T {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new SteeringError(`${label} must be JSON-serializable`);
  }
  if (encoded === undefined)
    throw new SteeringError(`${label} must be JSON-serializable`);
  try {
    return JSON.parse(encoded) as T;
  } catch {
    throw new SteeringError(`${label} must be JSON-serializable`);
  }
}
function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(normalize)
      : isRecord(input)
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
              .map(([key, child]) => [key, normalize(child)]),
          )
        : input;
  return JSON.stringify(normalize(value));
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function validateScope(scope: SteeringScope): SteeringScope {
  if (!isRecord(scope)) throw new SteeringError("steering scope is required");
  requiredId("tenant_id", scope.tenant_id);
  requiredId("run_id", scope.run_id);
  requiredId("session_id", scope.session_id);
  return deepFreeze(cloneJson(scope, "steering scope"));
}
const sameScope = (a: SteeringScope, b: SteeringScope) =>
  a.tenant_id === b.tenant_id &&
  a.run_id === b.run_id &&
  a.session_id === b.session_id;
function fingerprint(request: SteeringRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        scope: request.scope,
        queue: request.queue,
        priority: request.priority,
        content: request.content,
      }),
    )
    .digest("hex");
}
function validateCommand(command: SteeringCommand): void {
  requiredId("steering command_id", command?.command_id);
  validateScope(command.scope);
  if (!STEERING_QUEUES.includes(command.queue))
    throw new SteeringError("invalid steering queue");
  if (!STEERING_PRIORITIES.includes(command.priority))
    throw new SteeringError("invalid steering priority");
  cloneJson(command.content, "steering content");
  if (!Number.isSafeInteger(command.ordinal) || command.ordinal < 0)
    throw new SteeringError("invalid steering ordinal");
  if (
    !/^[a-f0-9]{64}$/u.test(command.fingerprint) ||
    fingerprint(command) !== command.fingerprint
  )
    throw new SteeringError("steering fingerprint mismatch");
}

export class SteeringController {
  readonly #scope: SteeringScope;
  readonly #journal: SteeringJournalPort;
  readonly #effectState: () => SteeringEffectState;
  readonly #onImmediate: SteeringControllerOptions["onImmediate"];
  readonly #commands = new Map<string, SteeringCommand>();
  readonly #consumed = new Set<string>();
  readonly #listeners = new Set<SteeringListener>();
  #nextOrdinal = 0;
  constructor(options: SteeringControllerOptions) {
    this.#scope = validateScope(options?.scope);
    if (
      !options?.journal ||
      typeof options.journal.read !== "function" ||
      typeof options.journal.append !== "function"
    )
      throw new SteeringError("steering journal is required");
    this.#journal = options.journal;
    this.#effectState = options.effectState ?? (() => null);
    this.#onImmediate = options.onImmediate;
    this.#rebuild(this.#journal.read());
  }
  enqueue(request: SteeringRequest): SteeringEnqueueResult {
    const normalizedScope = validateScope(request?.scope);
    if (!sameScope(this.#scope, normalizedScope))
      throw new SteeringError("steering request scope mismatch");
    requiredId("steering command_id", request?.command_id);
    if (!STEERING_QUEUES.includes(request.queue))
      throw new SteeringError("invalid steering queue");
    if (!STEERING_PRIORITIES.includes(request.priority))
      throw new SteeringError("invalid steering priority");
    const content = deepFreeze(cloneJson(request.content, "steering content"));
    const candidate = deepFreeze({
      command_id: request.command_id,
      scope: normalizedScope,
      queue: request.queue,
      priority: request.priority,
      content,
      ordinal: this.#nextOrdinal,
      fingerprint: fingerprint({ ...request, scope: normalizedScope, content }),
    });
    const existing = this.#commands.get(candidate.command_id);
    if (existing) {
      if (existing.fingerprint !== candidate.fingerprint)
        throw new SteeringError("steering command id collision");
      return deepFreeze({
        command: existing,
        replayed: true,
        disposition: this.#disposition(existing),
      });
    }
    this.#journal.append(
      deepFreeze({
        schema_version: "steering-event/v1" as const,
        kind: "enqueued" as const,
        scope: this.#scope,
        command: candidate,
      }),
    );
    this.#commands.set(candidate.command_id, candidate);
    this.#nextOrdinal += 1;
    const disposition = this.#disposition(candidate);
    if (disposition !== "queued") this.#onImmediate?.(candidate, disposition);
    for (const listener of this.#listeners) listener(candidate);
    return deepFreeze({ command: candidate, replayed: false, disposition });
  }
  subscribe(listener: SteeringListener): () => void {
    if (typeof listener !== "function")
      throw new SteeringError("steering listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  drain(queue: SteeringQueue): readonly SteeringCommand[] {
    if (!STEERING_QUEUES.includes(queue))
      throw new SteeringError("invalid steering queue");
    const selected = [...this.#commands.values()]
      .filter(
        (command) =>
          command.queue === queue && !this.#consumed.has(command.command_id),
      )
      .sort(
        (a, b) =>
          PRIORITY_RANK.get(a.priority)! - PRIORITY_RANK.get(b.priority)! ||
          a.ordinal - b.ordinal,
      );
    for (const command of selected) {
      this.#journal.append(
        deepFreeze({
          schema_version: "steering-event/v1" as const,
          kind: "consumed" as const,
          scope: this.#scope,
          command_id: command.command_id,
        }),
      );
      this.#consumed.add(command.command_id);
    }
    return Object.freeze([...selected]);
  }
  #disposition(command: SteeringCommand): SteeringDisposition {
    if (!["kill", "human_cancel"].includes(command.priority)) return "queued";
    const state = this.#effectState();
    return state === "IN_FLIGHT" || state === "EFFECT_UNKNOWN"
      ? "reconciliation_required"
      : "stop_requested";
  }
  #rebuild(events: readonly SteeringEvent[]): void {
    if (!Array.isArray(events))
      throw new SteeringError("steering journal must return an event array");
    for (const event of events) {
      if (!isRecord(event) || event.schema_version !== "steering-event/v1")
        throw new SteeringError("invalid steering journal event");
      const eventScope = validateScope(event.scope as SteeringScope);
      if (!sameScope(this.#scope, eventScope))
        throw new SteeringError("steering journal scope mismatch");
      if (event.kind === "enqueued") {
        const command = deepFreeze(
          cloneJson(event.command, "steering journal command"),
        ) as SteeringCommand;
        validateCommand(command);
        if (!sameScope(this.#scope, command.scope))
          throw new SteeringError("steering journal scope mismatch");
        if (this.#commands.has(command.command_id))
          throw new SteeringError("duplicate steering journal command");
        this.#commands.set(command.command_id, command);
        this.#nextOrdinal = Math.max(this.#nextOrdinal, command.ordinal + 1);
      } else if (event.kind === "consumed") {
        requiredId("steering command_id", event.command_id);
        if (
          !this.#commands.has(event.command_id) ||
          this.#consumed.has(event.command_id)
        )
          throw new SteeringError("invalid steering consumed event");
        this.#consumed.add(event.command_id);
      } else throw new SteeringError("invalid steering journal event kind");
    }
  }
}
