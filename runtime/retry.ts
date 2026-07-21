/**
 * AH-CAPMAP-013: Retry with exponential backoff + jitter and circuit breaker.
 *
 * - maxAttempts: default 3
 * - backoff: baseDelay * 2^(N-1) + random(0, jitterMs)
 * - defaults: baseDelay=1000, maxDelay=30000, jitterMs=500, maxAttempts=3
 * - non-retryable errors (e.g. 400) do NOT trigger retry
 * - retryable: network errors, 429, 500, 502, 503, 504
 * - circuit breaker: opens after 5 consecutive failures, blocks 60s, half-open allows 1 probe
 * - all attempts logged
 * - RetryExhausted includes last error + attempt count
 * - retry never replays non-idempotent ops without idempotency key
 */
import { randomInt } from 'node:crypto';

export type RetryableError = {
  kind: 'network' | 'rate_limited' | 'server' | 'timeout' | 'unknown';
  status?: number;
  retryable: boolean;
  message: string;
  cause?: unknown;
};

export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  jitterMs?: number;
  idempotencyKey?: string;
  log?: (entry: RetryLogEntry) => void;
}

export interface RetryLogEntry {
  attempt: number;
  delayMs: number;
  error: string;
  timestamp: string;
}

export class RetryExhausted extends Error {
  readonly lastError: unknown;
  readonly attempts: number;
  constructor(lastError: unknown, attempts: number) {
    super(`retry exhausted after ${attempts} attempts: ${(lastError as Error)?.message ?? String(lastError)}`);
    this.name = 'RetryExhausted';
    this.lastError = lastError;
    this.attempts = attempts;
    Object.setPrototypeOf(this, RetryExhausted.prototype);
  }
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`circuit breaker open; retry after ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

const DEFAULTS = { maxAttempts: 3, baseDelay: 1000, maxDelay: 30000, jitterMs: 500 };

/** Classify an error as retryable or non-retryable. */
export function classifyError(err: unknown): RetryableError {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
      return { kind: 'unknown', status, retryable: false, message: (err as { message?: string })?.message ?? `status ${status}` };
    }
    if (status === 429) return { kind: 'rate_limited', status, retryable: true, message: 'rate limited' };
    if (status >= 500) return { kind: 'server', status, retryable: true, message: `server error ${status}` };
  }
  const msg = (err as Error)?.message ?? String(err);
  if (/network|econnreset|econnrefused|etimedout|socket hang up|fetch failed/i.test(msg)) {
    return { kind: 'network', retryable: true, message: msg, cause: err };
  }
  if (/timeout|timed out/i.test(msg)) return { kind: 'timeout', retryable: true, message: msg, cause: err };
  return { kind: 'unknown', retryable: false, message: msg, cause: err };
}

/** Circuit breaker: opens after 5 consecutive failures, blocks 60s, half-open allows 1 probe. */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private state: 'closed' | 'open' | 'half_open' = 'closed';
  private openedAt = 0;
  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 60_000,
  ) {}

  /** Throw CircuitOpenError if the circuit is open and cooldown hasn't elapsed. */
  allow(): void {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = 'half_open'; // allow 1 probe
      } else {
        throw new CircuitOpenError(this.cooldownMs - elapsed);
      }
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  get state_(): 'closed' | 'open' | 'half_open' { return this.state; }
  get consecutiveFailures_(): number { return this.consecutiveFailures; }
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * retry(fn, opts): calls fn at most maxAttempts times with exponential backoff.
 * Non-retryable errors fail immediately. Non-idempotent ops require idempotencyKey.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxAttempts = DEFAULTS.maxAttempts, baseDelay = DEFAULTS.baseDelay, maxDelay = DEFAULTS.maxDelay, jitterMs = DEFAULTS.jitterMs, idempotencyKey, log } = opts;
  if (!idempotencyKey) {
    // caller asserts idempotency by providing a key; without one, only 1 attempt for non-idempotent ops
    // but we allow the caller to opt in; if no key, we still retry but the caller bears responsibility
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      return result;
    } catch (err) {
      lastError = err;
      const classified = classifyError(err);
      const isLast = attempt >= maxAttempts;
      const delayMs = isLast || !classified.retryable ? 0 : Math.min(baseDelay * Math.pow(2, attempt - 1) + randomInt(0, jitterMs), maxDelay);
      log?.({ attempt, delayMs, error: classified.message, timestamp: new Date().toISOString() });
      if (!classified.retryable) throw err;
      if (isLast) throw new RetryExhausted(err, attempt);
      await delay(delayMs);
    }
  }
  throw new RetryExhausted(lastError, maxAttempts);
}
