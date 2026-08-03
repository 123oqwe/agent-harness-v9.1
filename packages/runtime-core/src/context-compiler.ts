import { createHash } from "node:crypto";

import type {
  CompactionInput,
  CompactionResult,
  CompactionState,
  OffloadedContextHandle,
} from "./compaction.js";

export const CONTEXT_LAYERS = Object.freeze([
  "system_policy",
  "task",
  "active_plan",
  "recent_conversation",
  "retrieved_evidence",
  "tool_definitions",
  "tool_results",
  "memory",
  "reserved_output",
] as const);

export type ContextLayer = (typeof CONTEXT_LAYERS)[number];
export type ContextContentLayer = Exclude<ContextLayer, "reserved_output">;
export type ContextTrust = "policy" | "trusted" | "untrusted";

export interface ContextCompilerItem {
  readonly id: string;
  readonly layer: ContextContentLayer;
  readonly token_count: number;
  readonly trust: ContextTrust;
  readonly tenant_id: string;
  readonly acl: {
    readonly tenant_id: string;
    readonly principal_ids: readonly string[];
  };
  readonly content: unknown;
  readonly source_hash: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly key_fact?: boolean;
  readonly preview?: unknown;
  readonly preview_token_count?: number;
}

export type ContextCompilerLayers = Readonly<
  Record<ContextContentLayer, readonly ContextCompilerItem[]>
>;

export interface ContextSelectionDisclosure {
  readonly tool_ids: readonly string[];
  readonly skill_ids: readonly string[];
  readonly rag_source_ids: readonly string[];
  readonly disclosures: readonly string[];
}

export interface ActivePlanContent {
  readonly goal: string;
  readonly completed: readonly unknown[];
  readonly in_progress: unknown | null;
  readonly open_tasks: readonly unknown[];
  readonly blockers: readonly unknown[];
  readonly last_error: string | null;
  readonly constraints: readonly unknown[];
}

export interface ContextCompilerInput {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly context_generation: number;
  readonly context_capacity_tokens: number;
  readonly reserved_output_tokens: number;
  readonly cache_breakpoint: number;
  readonly layers: ContextCompilerLayers;
  readonly selected: ContextSelectionDisclosure;
  readonly compaction_state?: CompactionState;
}

export interface CompiledContextMessage {
  readonly layer: ContextContentLayer;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly trust: ContextTrust;
  readonly isolated: boolean;
  readonly item_ids: readonly string[];
  readonly content: readonly unknown[];
}

export interface ContextManifestItem {
  readonly id: string;
  readonly token_count: number;
  readonly trust: ContextTrust;
  readonly source_hash: string;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export interface ContextManifestLayer {
  readonly layer: ContextLayer;
  readonly token_count: number;
  readonly trust: ContextTrust | "mixed" | "reserved";
  readonly items: readonly ContextManifestItem[];
}

export interface ContextManifest {
  readonly schema_version: "context-manifest/v1";
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly context_generation: number;
  readonly cache_breakpoint: number;
  readonly stable_prefix_hash: string;
  readonly layers: readonly ContextManifestLayer[];
  readonly omitted_items: readonly string[];
  readonly offloaded_vfs_handles: readonly OffloadedContextHandle[];
  readonly selected: ContextSelectionDisclosure;
  readonly manifest_hash: string;
}

export interface ContextCompilerResult {
  readonly messages: readonly CompiledContextMessage[];
  readonly manifest: ContextManifest;
  readonly total_input_tokens: number;
  readonly reserved_output_tokens: number;
}

export interface ContextCompactionPort {
  compact(input: CompactionInput): Promise<CompactionResult>;
}

export interface ContextCompilerOptions {
  readonly compactor?: ContextCompactionPort;
  readonly offload_token_threshold?: number;
}

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

const clone = <T>(value: T): T => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("context value must be JSON-serializable");
  return JSON.parse(encoded) as T;
};

const requiredId = (label: string, value: unknown): string => {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
};

const nonNegativeInteger = (label: string, value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const validateActivePlan = (value: unknown): void => {
  if (
    !isRecord(value) ||
    typeof value.goal !== "string" ||
    !Array.isArray(value.completed) ||
    !(value.in_progress === null || isRecord(value.in_progress)) ||
    !Array.isArray(value.open_tasks) ||
    !Array.isArray(value.blockers) ||
    !(value.last_error === null || typeof value.last_error === "string") ||
    !Array.isArray(value.constraints)
  ) {
    throw new TypeError("active plan content is invalid");
  }
};

const roleFor = (layer: ContextContentLayer): CompiledContextMessage["role"] => {
  if (layer === "system_policy") return "system";
  if (layer === "tool_results") return "tool";
  if (layer === "recent_conversation") return "assistant";
  return "user";
};

const layerTrust = (items: readonly ContextCompilerItem[]): ContextTrust | "mixed" => {
  const values = new Set(items.map((entry) => entry.trust));
  return values.size === 1 ? items[0]!.trust : "mixed";
};

/** Deterministic nine-layer compiler. It owns assembly, never persistence or compaction. */
export class ContextCompiler {
  readonly #compactor: ContextCompactionPort | undefined;
  readonly #offloadTokenThreshold: number;

  constructor(options: ContextCompilerOptions = {}) {
    if (options.compactor !== undefined && typeof options.compactor.compact !== "function") {
      throw new TypeError("context compactor port is invalid");
    }
    this.#compactor = options.compactor;
    this.#offloadTokenThreshold = options.offload_token_threshold ?? 20_000;
    if (!Number.isSafeInteger(this.#offloadTokenThreshold) || this.#offloadTokenThreshold <= 0) {
      throw new TypeError("offload_token_threshold must be a positive safe integer");
    }
  }

  async compile(input: ContextCompilerInput): Promise<ContextCompilerResult> {
    this.#validate(input);
    const effectiveLayers = clone(input.layers) as Record<
      ContextContentLayer,
      ContextCompilerItem[]
    >;
    let contextGeneration = input.context_generation;
    let sessionId = input.session_id;
    let omittedItems: string[] = [];
    let offloadedVfsHandles: OffloadedContextHandle[] = [];
    const rawInputTokens = CONTEXT_LAYERS.slice(0, -1).reduce(
      (total, layer) => total + input.layers[layer as ContextContentLayer]
        .reduce((subtotal, entry) => subtotal + entry.token_count, 0),
      0,
    );
    const initialPressure =
      (rawInputTokens + input.reserved_output_tokens) / input.context_capacity_tokens;
    if (initialPressure >= 0.4) {
      if (this.#compactor === undefined) {
        throw new Error("context pressure requires the existing compactor authority");
      }
      if (input.compaction_state === undefined) {
        throw new TypeError("compaction_state is required at context pressure boundary");
      }
      if (contextGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("context_generation cannot be incremented safely");
      }
      const offloadCandidates = input.layers.tool_results
        .filter((entry) => entry.token_count >= this.#offloadTokenThreshold);
      const projectedAfterOffload = rawInputTokens + input.reserved_output_tokens -
        offloadCandidates.reduce(
          (total, entry) => total + entry.token_count - (entry.preview_token_count ?? 0),
          0,
        );
      const projectedAfterCompaction =
        projectedAfterOffload / input.context_capacity_tokens >= 0.7
          ? projectedAfterOffload - input.layers.recent_conversation
            .filter((entry) => entry.key_fact !== true)
            .reduce((total, entry) => total + entry.token_count, 0)
          : projectedAfterOffload;
      if (projectedAfterCompaction > input.context_capacity_tokens) {
        throw new RangeError("preserved context cannot fit after recovery");
      }
      const preparation = await this.#compactor.compact({
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        session_id: input.session_id,
        context_generation: input.context_generation,
        context_capacity_tokens: input.context_capacity_tokens,
        used_tokens: rawInputTokens + input.reserved_output_tokens,
        cache_breakpoint: input.cache_breakpoint,
        stable_prefix: [
          ...input.layers.system_policy,
          ...input.layers.tool_definitions,
        ].map((entry) => ({
          id: entry.id,
          token_count: entry.token_count,
          content: entry.content,
          key_fact: true,
        })),
        recent_conversation: input.layers.recent_conversation.map((entry) => ({
          id: entry.id,
          token_count: entry.token_count,
          content: entry.content,
          key_fact: entry.key_fact === true,
        })),
        offload_items: offloadCandidates
          .map((entry) => ({
            id: entry.id,
            token_count: entry.token_count,
            retained_token_count: entry.preview_token_count ?? 0,
            content: entry.content,
          })),
        state: input.compaction_state,
      });
      if (preparation.action === "cancelled") {
        throw new Error(`context preparation cancelled: ${preparation.reason_code ?? "unspecified"}`);
      }
      if (preparation.action === "none") {
        throw new Error("compactor returned none at context pressure boundary");
      }
      omittedItems = [...preparation.omitted_ids];
      offloadedVfsHandles = [...preparation.offloaded];
      const keptRecentIds = new Set(preparation.recent_conversation.map((entry) => entry.id));
      effectiveLayers.recent_conversation = effectiveLayers.recent_conversation
        .filter((entry) => keptRecentIds.has(entry.id));
      const handles = new Map(preparation.offloaded.map((entry) => [entry.source_id, entry]));
      effectiveLayers.tool_results = effectiveLayers.tool_results.map((entry) => {
        const handle = handles.get(entry.id);
        if (handle === undefined) return entry;
        return {
          ...entry,
          token_count: entry.preview_token_count ?? 0,
          content: {
            kind: "vfs_pointer",
            path: handle.path,
            sha256: handle.sha256,
            source_id: handle.source_id,
            preview: entry.preview ?? null,
          },
        };
      });
      const contextChanged =
        preparation.action === "compact" ||
        preparation.action === "context_reset" ||
        preparation.offloaded.length > 0;
      if (contextChanged) contextGeneration += 1;
      if (preparation.action === "context_reset") {
        if (preparation.session_id === undefined) {
          throw new Error("context reset did not return a fresh session");
        }
        sessionId = preparation.session_id;
      }
    }
    const messages: CompiledContextMessage[] = [];
    const layers: ContextManifestLayer[] = [];
    let totalInputTokens = 0;

    for (const layer of CONTEXT_LAYERS.slice(0, -1) as readonly ContextContentLayer[]) {
      const items = effectiveLayers[layer].map((entry) => clone(entry));
      const tokenCount = items.reduce((total, entry) => total + entry.token_count, 0);
      const trust = layerTrust(items);
      totalInputTokens += tokenCount;
      messages.push({
        layer,
        role: roleFor(layer),
        trust: trust === "mixed" ? "untrusted" : trust,
        isolated: items.some((entry) => entry.trust === "untrusted"),
        item_ids: items.map((entry) => entry.id),
        content: items.map((entry) => entry.content),
      });
      layers.push({
        layer,
        token_count: tokenCount,
        trust,
        items: items.map(({ id, token_count, trust: itemTrust, source_hash, provenance }) => ({
          id,
          token_count,
          trust: itemTrust,
          source_hash,
          provenance,
        })),
      });
    }

    layers.push({
      layer: "reserved_output",
      token_count: input.reserved_output_tokens,
      trust: "reserved",
      items: [],
    });
    if (totalInputTokens + input.reserved_output_tokens > input.context_capacity_tokens) {
      throw new RangeError("compiled context exceeds context capacity");
    }

    const selected = clone(input.selected);
    const stablePrefixHash = sha256(canonicalJson({
      system_policy: effectiveLayers.system_policy,
      tool_definitions: effectiveLayers.tool_definitions,
      cache_breakpoint: input.cache_breakpoint,
    }));
    const manifestBody = {
      schema_version: "context-manifest/v1" as const,
      tenant_id: input.tenant_id,
      run_id: input.run_id,
      session_id: sessionId,
      context_generation: contextGeneration,
      cache_breakpoint: input.cache_breakpoint,
      stable_prefix_hash: stablePrefixHash,
      layers,
      omitted_items: omittedItems,
      offloaded_vfs_handles: offloadedVfsHandles,
      selected,
    };
    const manifest: ContextManifest = {
      ...manifestBody,
      manifest_hash: sha256(canonicalJson(manifestBody)),
    };
    return deepFreeze({
      messages,
      manifest,
      total_input_tokens: totalInputTokens,
      reserved_output_tokens: input.reserved_output_tokens,
    });
  }

  #validate(input: ContextCompilerInput): void {
    requiredId("tenant_id", input?.tenant_id);
    requiredId("principal_id", input?.principal_id);
    requiredId("run_id", input?.run_id);
    requiredId("session_id", input?.session_id);
    nonNegativeInteger("context_generation", input?.context_generation);
    const capacity = nonNegativeInteger("context_capacity_tokens", input?.context_capacity_tokens);
    if (capacity === 0) throw new TypeError("context_capacity_tokens must be positive");
    nonNegativeInteger("reserved_output_tokens", input?.reserved_output_tokens);
    if (input.reserved_output_tokens > capacity) {
      throw new RangeError("reserved_output_tokens exceeds context capacity");
    }
    nonNegativeInteger("cache_breakpoint", input?.cache_breakpoint);
    if (input.layers === null || typeof input.layers !== "object") {
      throw new TypeError("context layers are required");
    }
    for (const layer of CONTEXT_LAYERS.slice(0, -1) as readonly ContextContentLayer[]) {
      if (!Array.isArray(input.layers[layer])) throw new TypeError(`${layer} must be an array`);
    }
    if (input.layers.system_policy.length === 0) {
      throw new TypeError("system_policy must not be empty");
    }
    const seen = new Set<string>();
    let accountedTokens = input.reserved_output_tokens;
    const stablePrefixItemCount =
      input.layers.system_policy.length + input.layers.tool_definitions.length;
    if (input.cache_breakpoint > stablePrefixItemCount) {
      throw new TypeError("cache_breakpoint exceeds stable-prefix boundary");
    }
    for (const layer of CONTEXT_LAYERS.slice(0, -1) as readonly ContextContentLayer[]) {
      const items = input.layers[layer];
      for (const entry of items) {
        requiredId("context item id", entry?.id);
        if (seen.has(entry.id)) throw new TypeError("context item ids must be unique");
        seen.add(entry.id);
        if (entry.layer !== layer) throw new TypeError("context item layer mismatch");
        if (entry.tenant_id !== input.tenant_id) throw new Error("cross-tenant context item rejected");
        if (
          entry.acl?.tenant_id !== input.tenant_id ||
          !Array.isArray(entry.acl.principal_ids) ||
          !entry.acl.principal_ids.includes(input.principal_id)
        ) {
          throw new Error("context item ACL denied");
        }
        for (const principalId of entry.acl.principal_ids) {
          requiredId("context item ACL principal_id", principalId);
        }
        if (new Set(entry.acl.principal_ids).size !== entry.acl.principal_ids.length) {
          throw new TypeError("context item ACL principal_ids must be unique");
        }
        const itemTokens = nonNegativeInteger("context item token_count", entry.token_count);
        if (accountedTokens > Number.MAX_SAFE_INTEGER - itemTokens) {
          throw new RangeError("context token accounting exceeds safe integer range");
        }
        accountedTokens += itemTokens;
        if (!HASH.test(entry.source_hash)) throw new TypeError("context item source_hash is invalid");
        if (!(["policy", "trusted", "untrusted"] as const).includes(entry.trust)) {
          throw new TypeError("context item trust is invalid");
        }
        if (layer === "system_policy" && entry.trust !== "policy") {
          throw new Error("system_policy trust must be policy");
        }
        if (layer !== "system_policy" && entry.trust === "policy") {
          throw new Error("policy trust is restricted to system_policy");
        }
        if (
          (layer === "retrieved_evidence" || layer === "memory") &&
          entry.trust !== "untrusted"
        ) {
          throw new Error(`${layer} trust must be untrusted`);
        }
        if (!isRecord(entry.provenance)) {
          throw new TypeError("context item provenance is required");
        }
        if (entry.preview_token_count !== undefined) {
          nonNegativeInteger("context item preview_token_count", entry.preview_token_count);
          if (entry.preview_token_count > entry.token_count) {
            throw new TypeError("context item preview_token_count exceeds token_count");
          }
        }
      }
    }
    const activePlanTokens = input.layers.active_plan.reduce(
      (total, entry) => total + entry.token_count,
      0,
    );
    if (input.layers.active_plan.length !== 1) {
      throw new TypeError("active plan layer must contain exactly one current plan");
    }
    validateActivePlan(input.layers.active_plan[0]!.content);
    if (activePlanTokens > 2_000) throw new RangeError("active plan exceeds 2000 tokens");
    for (const entry of input.layers.memory) {
      if (entry.provenance.source_type !== "memory_port") {
        throw new Error("memory layer must use memory_port provenance");
      }
    }
    if (input.selected === null || typeof input.selected !== "object") {
      throw new TypeError("context selection disclosure is required");
    }
    for (const field of ["tool_ids", "skill_ids", "rag_source_ids"] as const) {
      const values = input.selected[field];
      if (!Array.isArray(values)) throw new TypeError(`selected.${field} must be an array`);
      const unique = new Set<string>();
      for (const value of values) {
        requiredId(`selected.${field} item`, value);
        if (unique.has(value)) throw new TypeError(`selected.${field} must be unique`);
        unique.add(value);
      }
    }
    if (!Array.isArray(input.selected.disclosures)) {
      throw new TypeError("selected.disclosures must be an array");
    }
    for (const value of input.selected.disclosures) {
      if (typeof value !== "string" || value.length === 0 || value.length > 256) {
        throw new TypeError("selected.disclosures item is invalid");
      }
    }
    const disclosedRag = [...input.selected.rag_source_ids].sort();
    const includedRag = input.layers.retrieved_evidence.map((entry) => entry.id).sort();
    if (canonicalJson(disclosedRag) !== canonicalJson(includedRag)) {
      throw new Error("selected RAG disclosure does not match included evidence");
    }
    clone(input.selected);
  }
}
