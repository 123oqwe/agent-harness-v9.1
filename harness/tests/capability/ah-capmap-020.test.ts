import { describe, it, expect } from 'vitest';
import { withRetry, createRetryableError, isRetryable, calculateBackoff } from '../../runtime/retry.js';

describe('AH-CAPMAP-020: retry with bounded backoff', () => {
  it('succeeds on first attempt', async () => {
    const result = await withRetry(async () => 'ok', {
      maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0.1,
    });
    expect(result.success).toBe(true);
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(1);
  });

  it('retries on retryable error and succeeds', async () => {
    let attempt = 0;
    const result = await withRetry(async () => {
      attempt++;
      if (attempt < 3) throw createRetryableError('transient', true, 'key-1');
      return 'ok';
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0.1 });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('does not retry non-retryable error', async () => {
    const result = await withRetry(async () => {
      throw createRetryableError('permanent', false);
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0.1 });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it('does not retry retryable error without idempotency key', async () => {
    const result = await withRetry(async () => {
      throw createRetryableError('transient', true);
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0.1 });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it('respects max retries', async () => {
    const result = await withRetry(async () => {
      throw createRetryableError('always fails', true, 'key-1');
    }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitterFactor: 0.1 });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it('isRetryable detects retryable errors', () => {
    expect(isRetryable(createRetryableError('test', true))).toBe(true);
    expect(isRetryable(createRetryableError('test', false))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
  });

  it('calculateBackoff produces bounded delays', () => {
    const delay0 = calculateBackoff(0, 10, 100, 0);
    const delay5 = calculateBackoff(5, 10, 100, 0);
    expect(delay0).toBe(10);
    expect(delay5).toBeLessThanOrEqual(100 + 100 * 0); // max + jitter
  });
});
