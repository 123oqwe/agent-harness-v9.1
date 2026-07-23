/**
 * AH-RUNTIME-001: Retry with Bounded Backoff
 *
 * Retries only normalized retryable errors using exponential backoff
 * with jitter. Requires idempotency for effects.
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number; // 0-1
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

export interface RetryableError extends Error {
  retryable: boolean;
  idempotencyKey?: string;
}

export function createRetryableError(message: string, retryable: boolean, idempotencyKey?: string): RetryableError {
  const err = new Error(message) as RetryableError;
  err.retryable = retryable;
  err.idempotencyKey = idempotencyKey;
  err.name = 'RetryableError';
  return err;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof Error && 'retryable' in err) {
    return (err as RetryableError).retryable;
  }
  return false;
}

export function hasIdempotencyKey(err: unknown): boolean {
  if (err instanceof Error && 'idempotencyKey' in err) {
    return (err as RetryableError).idempotencyKey !== undefined;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<RetryResult<T>> {
  const { maxRetries, baseDelayMs, maxDelayMs, jitterFactor } = opts;
  let attempts = 0;
  let totalDelayMs = 0;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    try {
      const result = await fn();
      return { success: true, result, attempts, totalDelayMs };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryable(err) || attempt === maxRetries) {
        return { success: false, error: lastError, attempts, totalDelayMs };
      }

      // Check idempotency for effects
      if (!hasIdempotencyKey(err)) {
        // Non-idempotent effects cannot be retried
        return { success: false, error: lastError, attempts, totalDelayMs };
      }

      // Calculate delay with jitter
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const jitter = exponentialDelay * jitterFactor * Math.random();
      const delay = Math.round(exponentialDelay + jitter);
      totalDelayMs += delay;

      // Sleep
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: lastError, attempts, totalDelayMs };
}

export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number,
): number {
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const jitter = exponentialDelay * jitterFactor * Math.random();
  return Math.round(exponentialDelay + jitter);
}
