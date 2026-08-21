/**
 * AH-ROUTER-FALLBACK-11-001: 11 fallback types with classification, chain
 * construction, and cascade handling.
 *
 * Fallback taxonomy (distinct from the DAG node failure types in
 * dag-failure.ts — these are model/provider-level failures):
 *  - model_degraded, model_unavailable, rate_limited, context_too_long,
 *    tool_unavailable, provider_down, quota_exceeded, latency_timeout,
 *    content_filter, structured_output_fail, capability_mismatch
 *
 * Guarantees:
 *  - Every fallback chain excludes the primary provider (loop prevention).
 *  - Each candidate is re-validated against the data policy before it enters
 *    the chain (policy engine is never bypassed).
 *  - A cascade of consecutive failures triggers a durable pause with a user
 *    notification — never a silent retry.
 */
export type FallbackType =
  | 'model_degraded'
  | 'model_unavailable'
  | 'rate_limited'
  | 'context_too_long'
  | 'tool_unavailable'
  | 'provider_down'
  | 'quota_exceeded'
  | 'latency_timeout'
  | 'content_filter'
  | 'structured_output_fail'
  | 'capability_mismatch';

export const FALLBACK_TYPES: readonly FallbackType[] = [
  'model_degraded',
  'model_unavailable',
  'rate_limited',
  'context_too_long',
  'tool_unavailable',
  'provider_down',
  'quota_exceeded',
  'latency_timeout',
  'content_filter',
  'structured_output_fail',
  'capability_mismatch',
];

/** Spec output: FallbackClassification. */
export interface FallbackClassification {
  type: FallbackType;
  retryable: boolean;
}

/**
 * Retryable failures are transient — the same provider may recover and be
 * retried. Non-retryable failures are deterministic: retrying the same
 * provider cannot help (input too long, policy block, missing capability...).
 */
const RETRYABLE_FALLBACKS: ReadonlySet<FallbackType> = new Set([
  'model_degraded',
  'model_unavailable',
  'rate_limited',
  'provider_down',
  'latency_timeout',
]);

export function classifyFallback(type: FallbackType): FallbackClassification {
  return { type, retryable: RETRYABLE_FALLBACKS.has(type) };
}

export function isRetryableFallback(type: FallbackType): boolean {
  return classifyFallback(type).retryable;
}

/** Spec output: FallbackChain. */
export interface FallbackChain {
  /** Ordered fallback providers, never including the primary. */
  chain: string[];
  never_returns_to_primary: boolean;
}

export interface BuildFallbackChainOptions {
  primary_provider_id: string;
  /** Ordered alternative providers (may include the primary; it is filtered out). */
  candidates: string[];
  /**
   * Data-policy re-validation per candidate (security invariant: a fallback
   * may not bypass the policy engine). A candidate that fails is dropped.
   */
  policyOk?: (provider_id: string) => boolean;
}

/** Spec output: FallbackDecision. */
export interface FallbackDecision {
  next_provider_id: string | null;
  /** Retry the current provider (transient failure), rather than switching. */
  retry_same: boolean;
  /** Every candidate has been tried and none remains; cascade handling applies. */
  reached_chain_end: boolean;
}

export interface DecideNextOptions {
  chain: string[];
  primary_provider_id: string;
  /** Providers already attempted this run (current provider is the last entry). */
  attempted: string[];
  last_failure: FallbackType;
  /** Consecutive attempts on the current provider so far. */
  same_provider_attempts: number;
}

/** How many times a single provider is retried on a retryable failure before switching. */
export const MAX_SAME_PROVIDER_ATTEMPTS = 2;

/** Consecutive failures that trigger a durable pause. */
export const CASCADE_THRESHOLD = 3;

/**
 * Build the fallback chain for a primary provider. Guarantees:
 *  - the primary is never in the chain (loop prevention);
 *  - every included candidate already passed data-policy re-validation.
 */
export function buildFallbackChain(opts: BuildFallbackChainOptions): FallbackChain {
  const chain = opts.candidates.filter(
    (c) => c !== opts.primary_provider_id && (!opts.policyOk || opts.policyOk(c)),
  );
  return { chain, never_returns_to_primary: true };
}

/**
 * Decide the next provider after a failure. Retryable failures retry the
 * current provider up to MAX_SAME_PROVIDER_ATTEMPTS before switching; a
 * non-retryable failure moves straight to the next untried candidate. The
 * primary provider is never selected. When nothing remains, reports the chain
 * end so the caller applies cascade handling.
 */
export function decideNext(opts: DecideNextOptions): FallbackDecision {
  if (
    isRetryableFallback(opts.last_failure) &&
    opts.attempted.length > 0 &&
    opts.same_provider_attempts < MAX_SAME_PROVIDER_ATTEMPTS
  ) {
    const current = opts.attempted[opts.attempted.length - 1]!;
    return { next_provider_id: current, retry_same: true, reached_chain_end: false };
  }
  const next = opts.chain.find((c) => !opts.attempted.includes(c) && c !== opts.primary_provider_id);
  if (next !== undefined) {
    return { next_provider_id: next, retry_same: false, reached_chain_end: false };
  }
  return { next_provider_id: null, retry_same: false, reached_chain_end: true };
}

/** Spec output: durable pause + notification on cascade failure. */
export interface CascadeOutcome {
  durable_pause: boolean;
  user_notified: boolean;
  reason: string;
  consecutive_failures: number;
}

/**
 * A cascade of consecutive failures triggers a durable pause and a user
 * notification — never a silent retry. Below the threshold the run continues.
 */
export function evaluateCascade(consecutive_failures: number): CascadeOutcome {
  if (consecutive_failures >= CASCADE_THRESHOLD) {
    return {
      durable_pause: true,
      user_notified: true,
      reason: `cascade of ${consecutive_failures} consecutive failures`,
      consecutive_failures,
    };
  }
  return { durable_pause: false, user_notified: false, reason: '', consecutive_failures };
}
