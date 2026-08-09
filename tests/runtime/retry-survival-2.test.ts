import { describe, it, expect, vi } from 'vitest';
import {
  classifyError,
  CircuitBreaker,
  CircuitOpenError,
  retry,
  RetryExhausted,
  type RetryOptions,
} from '../../runtime/retry.js';

// ============================================================
// classifyError - exact classification (L80-120)
// ============================================================

describe('Retry survival-2 - classifyError', () => {
  it('classifies 408 status as timeout', () => {
    const error = { status: 408, message: 'Request Timeout' };
    const result = classifyError(error);
    expect(result.kind).toBe('timeout');
    expect(result.status).toBe(408);
    expect(result.retryable).toBe(true);
    expect(result.message).toBe('Request Timeout');
    expect(result.cause).toBe(error);
  });

  it('classifies 429 status as rate_limited', () => {
    const error = { status: 429, message: 'Too Many Requests' };
    const result = classifyError(error);
    expect(result.kind).toBe('rate_limited');
    expect(result.status).toBe(429);
    expect(result.retryable).toBe(true);
  });

  it('classifies 500 status as server_error', () => {
    const error = { status: 500, message: 'Internal Server Error' };
    const result = classifyError(error);
    expect(result.kind).toBe('server');
    expect(result.status).toBe(500);
    expect(result.retryable).toBe(true);
  });

  it('classifies 503 status as server_error', () => {
    const error = { status: 503, message: 'Service Unavailable' };
    const result = classifyError(error);
    expect(result.kind).toBe('server');
    expect(result.retryable).toBe(true);
  });

  it('classifies 400 status as client_error with retryable=false', () => {
    const error = { status: 400, message: 'Bad Request' };
    const result = classifyError(error);
    expect(result.kind).toBe('unknown');
    expect(result.status).toBe(400);
    expect(result.retryable).toBe(false);
  });

  it('classifies 404 status as client_error with retryable=false', () => {
    const error = { status: 404, message: 'Not Found' };
    const result = classifyError(error);
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('classifies error with non-integer status as unknown', () => {
    const error = { status: 408.5, message: 'weird' };
    const result = classifyError(error);
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('classifies error with non-number status as unknown', () => {
    const error = { status: '408', message: 'string status' };
    const result = classifyError(error);
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('classifies Error without status as unknown', () => {
    const error = new Error('generic failure');
    const result = classifyError(error);
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.message).toBe('generic failure');
  });

  it('classifies null as unknown', () => {
    const result = classifyError(null);
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('classifies string as unknown', () => {
    const result = classifyError('string error');
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.message).toBe('string error');
  });
});

// ============================================================
// CircuitBreaker - exact state transitions (L130-215)
// ============================================================

describe('Retry survival-2 - CircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.state_).toBe('closed');
    expect(cb.consecutiveFailures_).toBe(0);
  });

  it('allow() does nothing when closed', () => {
    const cb = new CircuitBreaker();
    expect(() => cb.allow()).not.toThrow();
    expect(cb.state_).toBe('closed');
  });

  it('opens after threshold consecutive failures', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    expect(cb.state_).toBe('closed');
    cb.recordFailure();
    expect(cb.state_).toBe('closed');
    cb.recordFailure();
    expect(cb.state_).toBe('open');
  });

  it('throws CircuitOpenError when calling allow() on open circuit', () => {
    const cb = new CircuitBreaker(1);
    cb.recordFailure();
    expect(cb.state_).toBe('open');
    expect(() => cb.allow()).toThrow(CircuitOpenError);
  });

  it('throws CircuitOpenError with remaining cooldown', () => {
    const now = { value: 1000 };
    const cb = new CircuitBreaker(1, 60_000, () => now.value);
    cb.recordFailure();
    now.value = 10_000; // 9000ms elapsed, cooldown is 60000ms
    try {
      cb.allow();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError);
      expect((e as CircuitOpenError).retryAfterMs).toBe(51_000);
    }
  });

  it('transitions to half_open after cooldown', () => {
    const now = { value: 1000 };
    const cb = new CircuitBreaker(1, 60_000, () => now.value);
    cb.recordFailure();
    expect(cb.state_).toBe('open');
    now.value = 62_000; // 61000ms elapsed, past cooldown
    cb.allow();
    expect(cb.state_).toBe('half_open');
  });

  it('throws CircuitOpenError when calling allow() on half_open', () => {
    const now = { value: 1000 };
    const cb = new CircuitBreaker(1, 60_000, () => now.value);
    cb.recordFailure();
    now.value = 62_000;
    cb.allow();
    expect(cb.state_).toBe('half_open');
    expect(() => cb.allow()).toThrow(CircuitOpenError);
  });

  it('recordSuccess closes from half_open', () => {
    const now = { value: 1000 };
    const cb = new CircuitBreaker(1, 60_000, () => now.value);
    cb.recordFailure();
    now.value = 62_000;
    cb.allow();
    expect(cb.state_).toBe('half_open');
    cb.recordSuccess();
    expect(cb.state_).toBe('closed');
    expect(cb.consecutiveFailures_).toBe(0);
  });

  it('recordFailure from half_open opens immediately', () => {
    const now = { value: 1000 };
    const cb = new CircuitBreaker(1, 60_000, () => now.value);
    cb.recordFailure();
    now.value = 62_000;
    cb.allow();
    expect(cb.state_).toBe('half_open');
    cb.recordFailure();
    expect(cb.state_).toBe('open');
  });

  it('recordSuccess resets consecutiveFailures from closed', () => {
    const cb = new CircuitBreaker(5);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.consecutiveFailures_).toBe(2);
    cb.recordSuccess();
    expect(cb.consecutiveFailures_).toBe(0);
    expect(cb.state_).toBe('closed');
  });

  it('throws RangeError for threshold < 1', () => {
    expect(() => new CircuitBreaker(0)).toThrow(RangeError);
    expect(() => new CircuitBreaker(0)).toThrow('threshold must be a positive safe integer');
  });

  it('throws RangeError for non-integer threshold', () => {
    expect(() => new CircuitBreaker(1.5)).toThrow(RangeError);
  });

  it('throws RangeError for negative cooldownMs', () => {
    expect(() => new CircuitBreaker(1, -1)).toThrow(RangeError);
    expect(() => new CircuitBreaker(1, -1)).toThrow('cooldownMs must be a non-negative safe integer');
  });

  it('accepts cooldownMs = 0', () => {
    expect(() => new CircuitBreaker(1, 0)).not.toThrow();
  });

  it('halfOpenProbeInFlight_ returns true when half_open', () => {
    const now = { value: 1000 };
    const cb = new CircuitBreaker(1, 60_000, () => now.value);
    expect(cb.halfOpenProbeInFlight_).toBe(false);
    cb.recordFailure();
    now.value = 62_000;
    cb.allow();
    expect(cb.halfOpenProbeInFlight_).toBe(true);
  });

  it('CircuitOpenError has exact message format', () => {
    const error = new CircuitOpenError(5000);
    expect(error.message).toBe('circuit breaker open; retry after 5000ms');
    expect(error.retryAfterMs).toBe(5000);
    expect(error.name).toBe('CircuitOpenError');
  });

  it('CircuitOpenError with 0 remaining', () => {
    const error = new CircuitOpenError(0);
    expect(error.message).toBe('circuit breaker open; retry after 0ms');
    expect(error.retryAfterMs).toBe(0);
  });
});

// ============================================================
// retry function - exact behavior (L230-276)
// ============================================================

describe('Retry survival-2 - retry function', () => {
  it('returns result on first attempt', async () => {
    const result = await retry(async () => 'success');
    expect(result).toBe('success');
  });

  it('retries on retryable error with idempotencyKey', async () => {
    let attempts = 0;
    const result = await retry(
      async (attempt) => {
        attempts++;
        if (attempt === 1) throw { status: 500, message: 'server error' };
        return 'success';
      },
      { idempotencyKey: 'key-123', maxAttempts: 3, baseDelay: 0, maxDelay: 0, jitterMs: 0 },
    );
    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('does not retry without idempotencyKey', async () => {
    let attempts = 0;
    try {
      await retry(
        async (attempt) => {
          attempts++;
          if (attempt === 1) throw { status: 500, message: 'server error' };
          return 'success';
        },
        { maxAttempts: 3, baseDelay: 0, maxDelay: 0, jitterMs: 0 },
      );
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
  });

  it('does not retry on non-retryable error', async () => {
    let attempts = 0;
    try {
      await retry(
        async (attempt) => {
          attempts++;
          throw { status: 400, message: 'bad request' };
        },
        { idempotencyKey: 'key-123', maxAttempts: 3, baseDelay: 0, maxDelay: 0, jitterMs: 0 },
      );
    } catch (error) {
      expect((error as any).status).toBe(400);
    }
    expect(attempts).toBe(1);
  });

  it('throws RetryExhausted after max attempts', async () => {
    let attempts = 0;
    try {
      await retry(
        async (attempt) => {
          attempts++;
          throw { status: 500, message: 'always fails' };
        },
        { idempotencyKey: 'key-123', maxAttempts: 3, baseDelay: 0, maxDelay: 0, jitterMs: 0 },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhausted);
      expect((error as RetryExhausted).attempts).toBe(3);
    }
    expect(attempts).toBe(3);
  });

  it('calls log callback with exact fields', async () => {
    const logs: any[] = [];
    try {
      await retry(
        async () => { throw { status: 500, message: 'fail' }; },
        {
          idempotencyKey: 'key',
          maxAttempts: 2,
          baseDelay: 0,
          maxDelay: 0,
          jitterMs: 0,
          log: (entry) => logs.push(entry),
        },
      );
    } catch {
      // expected
    }
    expect(logs.length).toBe(2);
    expect(logs[0].attempt).toBe(1);
    expect(logs[0].delayMs).toBe(0);
    expect(logs[0].error).toBe('fail');
    expect(logs[0].timestamp).toBeDefined();
    expect(typeof logs[0].timestamp).toBe('string');
  });

  it('uses exponential backoff with jitter', async () => {
    const sleepCalls: number[] = [];
    let attempts = 0;
    try {
      await retry(
        async () => {
          attempts++;
          throw { status: 500, message: 'fail' };
        },
        {
          idempotencyKey: 'key',
          maxAttempts: 4,
          baseDelay: 100,
          maxDelay: 1000,
          jitterMs: 50,
          dependencies: {
            sleep: (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); },
            randomJitter: () => 25,
            now: () => new Date('2026-08-10T00:00:00.000Z'),
          },
        },
      );
    } catch {
      // expected
    }
    expect(attempts).toBe(4);
    // Delays: attempt 1: 100*2^0 + 25 = 125, attempt 2: 100*2^1 + 25 = 225, attempt 3: 100*2^2 + 25 = 425
    // Last attempt (4): delay is 0 (isLast)
    expect(sleepCalls.length).toBe(3);
    expect(sleepCalls[0]).toBe(125);
    expect(sleepCalls[1]).toBe(225);
    expect(sleepCalls[2]).toBe(425);
  });

  it('throws RangeError for invalid maxAttempts', async () => {
    await expect(
      retry(async () => 'ok', { maxAttempts: 0 } as RetryOptions),
    ).rejects.toThrow('maxAttempts must be a safe integer >= 1');
  });

  it('throws RangeError for negative baseDelay', async () => {
    await expect(
      retry(async () => 'ok', { baseDelay: -1 } as RetryOptions),
    ).rejects.toThrow('baseDelay must be a safe integer >= 0');
  });

  it('throws RangeError for negative maxDelay', async () => {
    await expect(
      retry(async () => 'ok', { maxDelay: -1 } as RetryOptions),
    ).rejects.toThrow('maxDelay must be a safe integer >= 0');
  });

  it('throws RangeError for negative jitterMs', async () => {
    await expect(
      retry(async () => 'ok', { jitterMs: -1 } as RetryOptions),
    ).rejects.toThrow('jitterMs must be a safe integer >= 0');
  });

  it('throws RangeError when randomJitter returns out-of-range value', async () => {
    await expect(
      retry(
        async () => { throw { status: 500, message: 'fail' }; },
        {
          idempotencyKey: 'key',
          maxAttempts: 2,
          baseDelay: 0,
          maxDelay: 0,
          jitterMs: 10,
          dependencies: {
            sleep: () => Promise.resolve(),
            randomJitter: () => -1, // out of range
            now: () => new Date(),
          },
        },
      ),
    ).rejects.toThrow('randomJitter returned an out-of-range value');
  });

  it('throws RangeError when clock returns invalid date', async () => {
    await expect(
      retry(
        async () => { throw { status: 500, message: 'fail' }; },
        {
          idempotencyKey: 'key',
          maxAttempts: 2,
          baseDelay: 0,
          maxDelay: 0,
          jitterMs: 0,
          dependencies: {
            sleep: () => Promise.resolve(),
            randomJitter: () => 0,
            now: () => new Date('invalid'),
          },
        },
      ),
    ).rejects.toThrow('retry clock returned an invalid date');
  });

  it('trims idempotencyKey before checking', async () => {
    let attempts = 0;
    try {
      await retry(
        async () => {
          attempts++;
          throw { status: 500, message: 'fail' };
        },
        { idempotencyKey: '  ', maxAttempts: 3, baseDelay: 0, maxDelay: 0, jitterMs: 0 },
      );
    } catch {
      // expected
    }
    // Empty key after trim means no retry
    expect(attempts).toBe(1);
  });

  it('RetryExhausted has exact message format', () => {
    const cause = new Error('test error');
    const exhausted = new RetryExhausted(cause, 3);
    expect(exhausted.message).toBe('retry exhausted after 3 attempts: test error');
    expect(exhausted.attempts).toBe(3);
    expect(exhausted.name).toBe('RetryExhausted');
  });
});
