import {
  ModelGateway,
  ProviderDispatchError,
  type GatewayDispatchResult,
  type ProviderSelectionRequest,
  type ResolvedProvider,
} from "../gateway/model-gateway.js";

type FallbackProviderBinding = Pick<
  ResolvedProvider,
  | "provider_id"
  | "registry_snapshot_hash"
  | "provider_metadata_hash"
  | "selection_request_hash"
>;

interface RuntimeFallbackDispatchContext {
  readonly operation_id: string;
  readonly attempt_id?: string;
  readonly signal?: AbortSignal;
  readonly deadline_at?: string;
}

/**
 * Thin runtime adapter over the existing ModelGateway authority. Selection,
 * Policy, egress, credential exchange, health and provider dispatch remain in
 * ModelGateway; this adapter only exposes its exact-hop surface.
 */
export class ModelFallbackGatewayAdapter {
  readonly #gateway: ModelGateway;

  constructor(gateway: ModelGateway) {
    if (!(gateway instanceof ModelGateway)) {
      throw new TypeError("ModelFallbackGatewayAdapter requires ModelGateway");
    }
    this.#gateway = gateway;
  }

  switchProvider(
    previous: FallbackProviderBinding,
    selection: ProviderSelectionRequest,
    visitedProviderIds: readonly string[],
  ): ResolvedProvider {
    return this.#gateway.switchProvider(
      previous as ResolvedProvider,
      selection,
      visitedProviderIds,
    );
  }

  dispatchExact(
    resolved: FallbackProviderBinding,
    selection: ProviderSelectionRequest,
    context: RuntimeFallbackDispatchContext & {
      readonly context_generation: number;
      readonly context_manifest_hash: string;
    },
  ): Promise<GatewayDispatchResult> {
    return this.#gateway.dispatchExact(resolved as ResolvedProvider, selection, {
      operation_id: context.operation_id,
      ...(context.attempt_id === undefined ? {} : { attempt_id: context.attempt_id }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.deadline_at === undefined ? {} : { deadline_at: context.deadline_at }),
    });
  }

  classifyFailure(error: unknown): {
    readonly fallback_allowed: boolean;
    readonly reason_code: string;
  } {
    if (!(error instanceof ProviderDispatchError)) {
      return Object.freeze({ fallback_allowed: false, reason_code: "unclassified_failure" });
    }
    if (error.code === "provider_unhealthy") {
      return Object.freeze({ fallback_allowed: true, reason_code: "provider_unhealthy" });
    }
    const providerError = error.provider_error;
    if (
      error.code === "provider_failure" &&
      providerError?.retryable === true &&
      providerError.kind !== "auth" &&
      providerError.kind !== "invalid_request"
    ) {
      return Object.freeze({ fallback_allowed: true, reason_code: "retryable_provider_failure" });
    }
    return Object.freeze({ fallback_allowed: false, reason_code: error.code });
  }
}
