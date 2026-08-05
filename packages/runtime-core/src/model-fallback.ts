export interface FallbackResolvedProvider {
  readonly provider_id: string;
  readonly registry_snapshot_hash: string;
  readonly provider_metadata_hash: string;
  readonly selection_request_hash: string;
}

export interface FallbackDispatchContext {
  readonly operation_id: string;
  readonly attempt_id?: string;
  readonly signal?: AbortSignal;
  readonly deadline_at?: string;
}

export interface FallbackFailureClassification {
  readonly fallback_allowed: boolean;
  readonly reason_code: string;
}

export interface ModelFallbackGatewayPort<Selection = unknown, Result = unknown> {
  switchProvider(
    previous: FallbackResolvedProvider,
    selection: Selection,
    visitedProviderIds: readonly string[],
  ): FallbackResolvedProvider;
  dispatchExact(
    resolved: FallbackResolvedProvider,
    selection: Selection,
    context: FallbackDispatchContext & {
      readonly context_generation: number;
      readonly context_manifest_hash: string;
    },
  ): Promise<Result>;
  classifyFailure(error: unknown): FallbackFailureClassification;
}

export interface ModelFallbackCachePort {
  invalidate(input: {
    readonly context_generation: number;
    readonly provider_id: string;
    readonly reason: "model_fallback";
  }): void | Promise<void>;
}

export interface ModelFallbackContextPort {
  recompile(input: {
    readonly provider_id: string;
    readonly context_generation: number;
    readonly full_recompute: true;
    readonly validation_dimensions: readonly [
      "context",
      "modalities",
      "tools",
      "structured_output",
      "policy",
      "data_policy",
      "egress",
      "credentials",
    ];
  }): Promise<{
    readonly provider_id: string;
    readonly context_generation: number;
    readonly manifest_hash: string;
  }>;
}

export interface ModelFallbackOptions<Selection = unknown, Result = unknown> {
  readonly gateway: ModelFallbackGatewayPort<Selection, Result>;
  readonly cache: ModelFallbackCachePort;
  readonly context: ModelFallbackContextPort;
}

export interface ModelFallbackInput<Selection = unknown> {
  readonly current_provider: FallbackResolvedProvider;
  readonly selection_request: Selection;
  readonly dispatch_context: FallbackDispatchContext;
  readonly context_generation: number;
  readonly visited_provider_ids: readonly string[];
  readonly initial_failure: unknown;
}

export interface ModelFallbackResult<Result = unknown> {
  readonly provider: FallbackResolvedProvider;
  readonly dispatch_result: Result;
  readonly context_generation: number;
  readonly context_manifest_hash: string;
  readonly visited_provider_ids: readonly string[];
}

export type ModelFallbackErrorCode =
  | "fallback_forbidden"
  | "fallback_loop"
  | "invalid_fallback_state";

export class ModelFallbackError extends Error {
  readonly code: ModelFallbackErrorCode;
  readonly reason_code?: string;

  constructor(code: ModelFallbackErrorCode, reasonCode?: string) {
    super(`Model fallback failed: ${code}`);
    this.name = "ModelFallbackError";
    this.code = code;
    if (reasonCode !== undefined) this.reason_code = reasonCode;
  }
}

const VALIDATION_DIMENSIONS = Object.freeze([
  "context",
  "modalities",
  "tools",
  "structured_output",
  "policy",
  "data_policy",
  "egress",
  "credentials",
] as const);

const assertIdentifier: (
  value: unknown,
  field: string,
) => asserts value is string = (value, field) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new ModelFallbackError("invalid_fallback_state", field);
  }
};

const assertResolvedProvider: (
  value: FallbackResolvedProvider | undefined,
  field: string,
) => asserts value is FallbackResolvedProvider = (value, field) => {
  assertIdentifier(value?.provider_id, `${field}.provider_id`);
  for (const [name, hash] of [
    ["registry_snapshot_hash", value?.registry_snapshot_hash],
    ["provider_metadata_hash", value?.provider_metadata_hash],
    ["selection_request_hash", value?.selection_request_hash],
  ] as const) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash)) {
      throw new ModelFallbackError("invalid_fallback_state", `${field}.${name}`);
    }
  }
};

export class ModelFallbackController<Selection = unknown, Result = unknown> {
  readonly #gateway: ModelFallbackGatewayPort<Selection, Result>;
  readonly #cache: ModelFallbackCachePort;
  readonly #context: ModelFallbackContextPort;
  readonly #maxFallbackDepth: number;

  constructor(options: ModelFallbackOptions<Selection, Result>) {
    if (typeof options?.gateway?.switchProvider !== "function" ||
        typeof options.gateway.dispatchExact !== "function" ||
        typeof options.gateway.classifyFailure !== "function" ||
        typeof options?.cache?.invalidate !== "function" ||
        typeof options?.context?.recompile !== "function") {
      throw new TypeError("ModelFallbackController ports are required");
    }
    this.#gateway = options.gateway;
    this.#cache = options.cache;
    this.#context = options.context;
    this.#maxFallbackDepth = (options as { maxFallbackDepth?: number })?.maxFallbackDepth ?? 16;
  }

  async execute(input: ModelFallbackInput<Selection>): Promise<ModelFallbackResult<Result>> {
    assertResolvedProvider(input?.current_provider, "current_provider");
    assertIdentifier(input?.dispatch_context?.operation_id, "dispatch_context.operation_id");
    if (
      !Number.isSafeInteger(input.context_generation) ||
      input.context_generation < 0 ||
      input.context_generation >= Number.MAX_SAFE_INTEGER
    ) {
      throw new ModelFallbackError("invalid_fallback_state", "context_generation");
    }
    if (!Array.isArray(input.visited_provider_ids)) {
      throw new ModelFallbackError("invalid_fallback_state", "visited_provider_ids");
    }
    const visited = [...input.visited_provider_ids];
    for (const providerId of visited) assertIdentifier(providerId, "visited_provider_ids");
    if (new Set(visited).size !== visited.length) {
      throw new ModelFallbackError("invalid_fallback_state", "duplicate_visited_provider");
    }
    if (!visited.includes(input.current_provider.provider_id)) {
      throw new ModelFallbackError("invalid_fallback_state", "current_provider_not_visited");
    }
    let failure = input.initial_failure;
    let current = input.current_provider;
    let generation = input.context_generation;
    let depth = 0;

    while (depth < this.#maxFallbackDepth) {
      depth += 1;
      const classification = this.#gateway.classifyFailure(failure);
      if (!classification.fallback_allowed) {
        throw new ModelFallbackError("fallback_forbidden", classification.reason_code);
      }
      const candidate = this.#gateway.switchProvider(
        current,
        input.selection_request,
        Object.freeze([...visited]),
      );
      assertResolvedProvider(candidate, "candidate");
      if (
        candidate.registry_snapshot_hash !== current.registry_snapshot_hash ||
        candidate.selection_request_hash !== current.selection_request_hash
      ) {
        throw new ModelFallbackError("invalid_fallback_state", "candidate_binding");
      }
      if (visited.includes(candidate.provider_id)) {
        throw new ModelFallbackError("fallback_loop", candidate.provider_id);
      }

      if (input.dispatch_context.signal?.aborted) {
        throw new ModelFallbackError("fallback_forbidden", "aborted");
      }

      await this.#cache.invalidate({
        context_generation: generation,
        provider_id: current.provider_id,
        reason: "model_fallback",
      });
      generation += 1;
      const compiled = await this.#context.recompile({
        provider_id: candidate.provider_id,
        context_generation: generation,
        full_recompute: true,
        validation_dimensions: VALIDATION_DIMENSIONS,
      });
      if (
        compiled.provider_id !== candidate.provider_id ||
        compiled.context_generation !== generation ||
        !/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u.test(compiled.manifest_hash)
      ) {
        throw new ModelFallbackError("invalid_fallback_state", "compiled_context");
      }
      visited.push(candidate.provider_id);
      try {
        const dispatchResult = await this.#gateway.dispatchExact(
          candidate,
          input.selection_request,
          {
            ...input.dispatch_context,
            context_generation: generation,
            context_manifest_hash: compiled.manifest_hash,
          },
        );
        return Object.freeze({
          provider: candidate,
          dispatch_result: dispatchResult,
          context_generation: generation,
          context_manifest_hash: compiled.manifest_hash,
          visited_provider_ids: Object.freeze([...visited]),
        });
      } catch (error) {
        failure = error;
        current = candidate;
      }
    }

    throw new ModelFallbackError("fallback_loop", `exceeded max depth ${this.#maxFallbackDepth}`);
  }
}
