import { createHash } from "node:crypto";

export interface CompactionSecurityState {
  readonly approvals: readonly unknown[];
  readonly grants: readonly unknown[];
  readonly denials: readonly unknown[];
  readonly current_revocations: readonly unknown[];
  readonly effects: readonly unknown[];
  readonly receipts: readonly unknown[];
  readonly idempotency_ids: readonly string[];
}

export interface CompactionState {
  readonly goal: unknown;
  readonly constraints: readonly unknown[];
  readonly decisions: readonly unknown[];
  readonly security: CompactionSecurityState;
  readonly active_plan: readonly unknown[];
  readonly open_tasks: readonly unknown[];
  readonly source_hashes: readonly string[];
  readonly tracked_file_changes: readonly unknown[];
}

export interface CompactionConversationItem {
  readonly id: string;
  readonly token_count: number;
  readonly content: unknown;
  readonly key_fact: boolean;
}

export interface CompactionOffloadItem {
  readonly id: string;
  readonly token_count: number;
  readonly retained_token_count?: number;
  readonly content: unknown;
}

export interface CompactionInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly context_generation: number;
  readonly context_capacity_tokens: number;
  readonly used_tokens: number;
  readonly cache_breakpoint: number;
  readonly stable_prefix: readonly CompactionConversationItem[];
  readonly recent_conversation: readonly CompactionConversationItem[];
  readonly offload_items: readonly CompactionOffloadItem[];
  readonly state: CompactionState;
}

export interface CompactionVfsPort {
  write(path: string, bytes: string): void;
}

export interface BeforeCompactPort {
  dispatch(input: {
    readonly event: "session_before_compact";
    readonly tenant_id: string;
    readonly run_id: string;
    readonly session_id: string;
    readonly action: "compact" | "context_reset";
    readonly pressure: number;
  }): Promise<{
    readonly action: "continue" | "deny" | "skip" | "force_prompt";
    readonly reason_code?: string;
  }>;
}

export interface FreshSessionPort {
  prepare(input: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly previous_session_id: string;
    readonly context_generation: number;
  }):
    | {
        readonly session_id: string;
        commit(): void | Promise<void>;
      }
    | Promise<{
        readonly session_id: string;
        commit(): void | Promise<void>;
      }>;
}

export interface ContextCompactorOptions {
  readonly vfs: CompactionVfsPort;
  readonly beforeCompact: BeforeCompactPort;
  readonly freshSession: FreshSessionPort;
}

export interface OffloadedContextHandle {
  readonly source_id: string;
  readonly token_count: number;
  readonly path: string;
  readonly sha256: string;
}

export interface ContextHandoffHandle {
  readonly path: string;
  readonly sha256: string;
}

export interface CompactionResult {
  readonly action: "none" | "offload" | "compact" | "context_reset" | "cancelled";
  readonly state: CompactionState;
  readonly stable_prefix: readonly CompactionConversationItem[];
  readonly recent_conversation: readonly CompactionConversationItem[];
  readonly offloaded: readonly OffloadedContextHandle[];
  readonly omitted_ids: readonly string[];
  readonly cache_breakpoint: number;
  readonly pressure_after_offload: number;
  readonly reason_code?: string;
  readonly previous_session_id?: string;
  readonly session_id?: string;
  readonly handoff?: ContextHandoffHandle;
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const cloneJson = <T>(value: T): T => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("compaction state must be JSON-serializable");
  return JSON.parse(encoded) as T;
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

function requiredId(label: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function nonNegativeInteger(label: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

/**
 * Deterministic context-pressure controller. Security state is cloned as
 * structured data and is never passed to a summarizer or model.
 */
export class ContextCompactor {
  readonly #vfs: CompactionVfsPort;
  readonly #beforeCompact: BeforeCompactPort;
  readonly #freshSession: FreshSessionPort;

  constructor(options: ContextCompactorOptions) {
    if (typeof options?.vfs?.write !== "function") throw new TypeError("compaction VFS port is required");
    if (typeof options?.beforeCompact?.dispatch !== "function") throw new TypeError("compaction Hook port is required");
    if (typeof options?.freshSession?.prepare !== "function") throw new TypeError("fresh Session port is required");
    this.#vfs = options.vfs;
    this.#beforeCompact = options.beforeCompact;
    this.#freshSession = options.freshSession;
  }

  async compact(input: CompactionInput): Promise<CompactionResult> {
    this.#validate(input);
    const state = deepFreeze(cloneJson(input.state));
    const stablePrefix = deepFreeze(cloneJson(input.stable_prefix));
    const recentConversation = deepFreeze(cloneJson(input.recent_conversation));
    const initialPressure = input.used_tokens / input.context_capacity_tokens;
    const offloaded: OffloadedContextHandle[] = [];
    let projectedTokens = input.used_tokens;

    if (initialPressure >= 0.4) {
      for (const item of input.offload_items) {
        const payload = canonicalJson(cloneJson({
          schema_version: "context-offload/v1",
          tenant_id: input.tenant_id,
          run_id: input.run_id,
          session_id: input.session_id,
          source_id: item.id,
          token_count: item.token_count,
          ...(item.retained_token_count === undefined
            ? {}
            : { retained_token_count: item.retained_token_count }),
          content: item.content,
        }));
        const hash = sha256(payload);
        const path = `/scratch/context/${input.tenant_id}/${input.run_id}/${input.session_id}/${hash}.json`;
        this.#vfs.write(path, payload);
        offloaded.push(
          Object.freeze({
            source_id: item.id,
            token_count: item.token_count,
            path,
            sha256: hash,
          }),
        );
        projectedTokens = Math.max(
          0,
          projectedTokens - item.token_count + (item.retained_token_count ?? 0),
        );
      }
    }

    const pressureAfterOffload = projectedTokens / input.context_capacity_tokens;
    const common = {
      state,
      stable_prefix: stablePrefix,
      recent_conversation: recentConversation,
      offloaded: Object.freeze(offloaded),
      omitted_ids: Object.freeze([] as string[]),
      cache_breakpoint: input.cache_breakpoint,
      pressure_after_offload: pressureAfterOffload,
    };
    if (initialPressure < 0.4) return deepFreeze({ action: "none" as const, ...common });
    if (pressureAfterOffload < 0.7) return deepFreeze({ action: "offload" as const, ...common });

    const nextAction = pressureAfterOffload >= 0.85 ? "context_reset" : "compact";
    const hook = await this.#beforeCompact.dispatch({
      event: "session_before_compact",
      tenant_id: input.tenant_id,
      run_id: input.run_id,
      session_id: input.session_id,
      action: nextAction,
      pressure: pressureAfterOffload,
    });
    if (hook.action !== "continue") {
      return deepFreeze({
        action: "cancelled" as const,
        ...common,
        reason_code: hook.reason_code ?? `hook_${hook.action}`,
      });
    }

    const kept = recentConversation.filter((entry) => entry.key_fact);
    const omittedIds = recentConversation
      .filter((entry) => !entry.key_fact)
      .map((entry) => entry.id);
    const compacted = {
      ...common,
      recent_conversation: deepFreeze(cloneJson(kept)),
      omitted_ids: Object.freeze(omittedIds),
    };
    if (nextAction === "compact") {
      return deepFreeze({ action: "compact" as const, ...compacted });
    }

    const prepared = await this.#freshSession.prepare({
      tenant_id: input.tenant_id,
      run_id: input.run_id,
      previous_session_id: input.session_id,
      context_generation: input.context_generation,
    });
    const sessionId = prepared.session_id;
    requiredId("fresh session_id", sessionId);
    if (sessionId === input.session_id) throw new Error("context reset requires a fresh session");
    const handoff = canonicalJson({
      schema_version: "context-handoff/v1",
      tenant_id: input.tenant_id,
      run_id: input.run_id,
      previous_session_id: input.session_id,
      session_id: sessionId,
      state,
      stable_prefix: stablePrefix,
      recent_conversation: compacted.recent_conversation,
      offloaded,
      cache_breakpoint: input.cache_breakpoint,
    });
    const handoffHash = sha256(handoff);
    const handoffPath = `/scratch/context/${input.tenant_id}/${input.run_id}/${input.session_id}/handoff-${handoffHash}.json`;
    this.#vfs.write(handoffPath, handoff);
    await prepared.commit();
    return deepFreeze({
      action: "context_reset" as const,
      ...compacted,
      previous_session_id: input.session_id,
      session_id: sessionId,
      handoff: Object.freeze({ path: handoffPath, sha256: handoffHash }),
    });
  }

  #validate(input: CompactionInput): void {
    requiredId("tenant_id", input?.tenant_id);
    requiredId("run_id", input?.run_id);
    requiredId("session_id", input?.session_id);
    nonNegativeInteger("context_generation", input?.context_generation);
    nonNegativeInteger("context_capacity_tokens", input?.context_capacity_tokens);
    if (input.context_capacity_tokens === 0) throw new TypeError("context_capacity_tokens must be positive");
    nonNegativeInteger("used_tokens", input?.used_tokens);
    nonNegativeInteger("cache_breakpoint", input?.cache_breakpoint);
    if (input.cache_breakpoint > input.stable_prefix.length) {
      throw new TypeError("cache_breakpoint exceeds stable prefix");
    }
    for (const item of [...input.stable_prefix, ...input.recent_conversation, ...input.offload_items]) {
      requiredId("context item id", item.id);
      nonNegativeInteger("context item token_count", item.token_count);
    }
    for (const item of input.offload_items) {
      if (item.retained_token_count !== undefined) {
        nonNegativeInteger("context item retained_token_count", item.retained_token_count);
        if (item.retained_token_count > item.token_count) {
          throw new TypeError("context item retained_token_count exceeds token_count");
        }
      }
    }
    for (const field of [
      "approvals",
      "grants",
      "denials",
      "current_revocations",
      "effects",
      "receipts",
      "idempotency_ids",
    ] as const) {
      if (!Array.isArray(input.state?.security?.[field])) {
        throw new TypeError(`security.${field} must be an array`);
      }
    }
    cloneJson(input.state);
  }
}
