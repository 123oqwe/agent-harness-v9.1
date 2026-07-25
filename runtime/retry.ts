/**
 * AH-CAPMAP-013: bounded retry and a deterministic circuit breaker.
 *
 * A retry is permitted only when the caller supplies an idempotency key.
 * Delay, jitter, time, and sleep are injectable so tests and replay do not
 * depend on wall-clock races.
 */
import { randomInt } from 'node:crypto';

export type RetryableError = {
  kind: 'network' | 'rate_limited' | 'server' | 'timeout' | 'unknown';
  status?: number;
  retryable: boolean;
  message: string;
  cause?: unknown;
};

export interface RetryDependencies {
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly randomJitter?: (maxInclusive: number) => number;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  jitterMs?: number;
  idempotencyKey?: string;
  log?: (entry: RetryLogEntry) => void;
  dependencies?: RetryDependencies;
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
    const detail =
      lastError instanceof Error ? lastError.message : String(lastError);
    super(`retry exhausted after ${attempts} attempts: ${detail}`);
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

const DEFAULTS = Object.freeze({
  maxAttempts: 3,
  baseDelay: 1_000,
  maxDelay: 30_000,
  jitterMs: 500,
});

function errorMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return String(error);
}

export function classifyError(error: unknown): RetryableError {
  const message = errorMessage(error);
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = error.status;
    if (typeof status === 'number' && Number.isInteger(status)) {
      if (status === 408) {
        return {
          kind: 'timeout',
          status,
          retryable: true,
          message,
          cause: error,
        };
      }
      if (status === 429) {
        return {
          kind: 'rate_limited',
          status,
          retryable: true,
          message,
          cause: error,
        };
      }
      if (status >= 500 && status <= 599) {
        return {
          kind: 'server',
          status,
          retryable: true,
          message,
          cause: error,
        };
      }
      return { kind: 'unknown', status, retryable: false, message };
    }
  }
  if (/timeout|timed out|etimedout/iu.test(message)) {
    return { kind: 'timeout', retryable: true, message, cause: error };
  }
  if (
    /network|econnreset|econnrefused|socket hang up|fetch failed/iu.test(
      message,
    )
  ) {
    return { kind: 'network', retryable: true, message, cause: error };
  }
  return { kind: 'unknown', retryable: false, message, cause: error };
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private state: 'closed' | 'open' | 'half_open' = 'closed';
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(threshold) || threshold < 1) {
      throw new RangeError('threshold must be a positive safe integer');
    }
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) {
      throw new RangeError('cooldownMs must be a non-negative safe integer');
    }
  }

  allow(): void {
    if (this.state === 'closed') return;
    if (this.state === 'half_open') {
      throw new CircuitOpenError(0);
    }
    const elapsed = Math.max(0, this.now() - this.openedAt);
    if (elapsed < this.cooldownMs) {
      throw new CircuitOpenError(this.cooldownMs - elapsed);
    }
    this.state = 'half_open';
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.open();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) this.open();
  }

  get state_(): 'closed' | 'open' | 'half_open' {
    return this.state;
  }

  get consecutiveFailures_(): number {
    return this.consecutiveFailures;
  }

  get halfOpenProbeInFlight_(): boolean {
    return this.state === 'half_open';
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = this.now();
  }
}

function validateInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultJitter(maxInclusive: number): number {
  return maxInclusive === 0 ? 0 : randomInt(0, maxInclusive + 1);
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelay = options.baseDelay ?? DEFAULTS.baseDelay;
  const maxDelay = options.maxDelay ?? DEFAULTS.maxDelay;
  const jitterMs = options.jitterMs ?? DEFAULTS.jitterMs;
  validateInteger('maxAttempts', maxAttempts, 1);
  validateInteger('baseDelay', baseDelay, 0);
  validateInteger('maxDelay', maxDelay, 0);
  validateInteger('jitterMs', jitterMs, 0);

  const replaySafe = (options.idempotencyKey?.trim().length ?? 0) > 0;
  const effectiveMaxAttempts = replaySafe ? maxAttempts : 1;
  const now = options.dependencies?.now ?? (() => new Date());
  const sleep = options.dependencies?.sleep ?? defaultSleep;
  const randomJitter =
    options.dependencies?.randomJitter ?? defaultJitter;
  let lastError: unknown;

  for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const classified = classifyError(error);
      const isLast = attempt === effectiveMaxAttempts;
      const jitter = isLast ? 0 : randomJitter(jitterMs);
      if (
        !Number.isSafeInteger(jitter) ||
        jitter < 0 ||
        jitter > jitterMs
      ) {
        throw new RangeError('randomJitter returned an out-of-range value', {
          cause: error,
        });
      }
      const exponential = Math.min(
        maxDelay,
        baseDelay * 2 ** (attempt - 1),
      );
      const delayMs =
        isLast || !classified.retryable
          ? 0
          : Math.min(maxDelay, exponential + jitter);
      const timestamp = now();
      if (!Number.isFinite(timestamp.getTime())) {
        throw new RangeError('retry clock returned an invalid date', {
          cause: error,
        });
      }
      options.log?.({
        attempt,
        delayMs,
        error: classified.message,
        timestamp: timestamp.toISOString(),
      });
      if (!classified.retryable) throw error;
      if (isLast) throw new RetryExhausted(error, attempt);
      await sleep(delayMs);
    }
  }
  throw new RetryExhausted(lastError, effectiveMaxAttempts);
}
