import { describe, it, expect } from 'vitest';
import { retry, classifyError, CircuitBreaker, RetryExhausted, CircuitOpenError } from '../../runtime/retry.js';

describe('classifyError', () => {
  it('classifies 408 as timeout', () => {
    const e = classifyError({ status: 408, message: 'timeout' });
    expect(e.kind).toBe('timeout');
    expect(e.retryable).toBe(true);
    expect(e.status).toBe(408);
  });
  it('classifies 429 as rate_limited', () => {
    const e = classifyError({ status: 429, message: 'rate limited' });
    expect(e.kind).toBe('rate_limited');
    expect(e.retryable).toBe(true);
  });
  it('classifies 500 as server', () => {
    const e = classifyError({ status: 500, message: 'server error' });
    expect(e.kind).toBe('server');
    expect(e.retryable).toBe(true);
  });
  it('classifies 503 as server', () => {
    const e = classifyError({ status: 503, message: 'unavailable' });
    expect(e.kind).toBe('server');
    expect(e.retryable).toBe(true);
  });
  it('classifies 400 as unknown non-retryable', () => {
    const e = classifyError({ status: 400, message: 'bad request' });
    expect(e.kind).toBe('unknown');
    expect(e.retryable).toBe(false);
  });
  it('classifies timeout message without status', () => {
    const e = classifyError(new Error('request timed out'));
    expect(e.kind).toBe('timeout');
    expect(e.retryable).toBe(true);
  });
  it('classifies network error message', () => {
    const e = classifyError(new Error('ECONNRESET socket hang up'));
    expect(e.kind).toBe('network');
    expect(e.retryable).toBe(true);
  });
  it('classifies unknown error', () => {
    const e = classifyError(new Error('something else'));
    expect(e.kind).toBe('unknown');
    expect(e.retryable).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('starts closed and allows', () => {
    const cb = new CircuitBreaker(5, 60_000);
    expect(() => cb.allow()).not.toThrow();
  });
  it('opens after threshold failures', () => {
    let time = 0;
    const cb = new CircuitBreaker(3, 60_000, () => time);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(() => cb.allow()).toThrow(CircuitOpenError);
  });
  it('resets on success', () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(() => cb.allow()).not.toThrow();
  });
  it('transitions to half_open after cooldown', () => {
    let time = 0;
    const cb = new CircuitBreaker(1, 1000, () => time);
    cb.recordFailure();
    expect(() => cb.allow()).toThrow(CircuitOpenError);
    time = 1001;
    expect(() => cb.allow()).not.toThrow();
  });
  it('half_open probe failure reopens circuit', () => {
    let time = 0;
    const cb = new CircuitBreaker(1, 1000, () => time);
    cb.recordFailure();
    time = 1001;
    cb.allow(); // transitions to half_open
    cb.recordFailure();
    expect(() => cb.allow()).toThrow(CircuitOpenError);
  });
  it('half_open probe success closes circuit', () => {
    let time = 0;
    const cb = new CircuitBreaker(1, 1000, () => time);
    cb.recordFailure();
    time = 1001;
    cb.allow(); // transitions to half_open
    cb.recordSuccess();
    expect(() => cb.allow()).not.toThrow();
  });
  it('throws on invalid threshold', () => {
    expect(() => new CircuitBreaker(0, 1000)).toThrow(RangeError);
    expect(() => new CircuitBreaker(-1, 1000)).toThrow(RangeError);
  });
  it('throws on invalid cooldown', () => {
    expect(() => new CircuitBreaker(5, -1)).toThrow(RangeError);
  });
});

describe('retry', () => {
  it('succeeds on first attempt', async () => {
    const result = await retry(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });
  it('retries on retryable error with idempotency key', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw { status: 500, message: 'server error' };
        return 'success';
      },
      { idempotencyKey: 'key-1', maxAttempts: 5, baseDelay: 0, jitterMs: 0 },
    );
    expect(result).toBe('success');
    expect(calls).toBe(3);
  });
  it('does not retry without idempotency key', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw { status: 500, message: 'server error' };
        },
        { maxAttempts: 5, baseDelay: 0, jitterMs: 0 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw { status: 400, message: 'bad request' };
        },
        { idempotencyKey: 'key-2', maxAttempts: 5, baseDelay: 0, jitterMs: 0 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('throws RetryExhausted after max attempts', async () => {
    await expect(
      retry(
        async () => { throw { status: 500, message: 'always fail' }; },
        { idempotencyKey: 'key-3', maxAttempts: 3, baseDelay: 0, jitterMs: 0 },
      ),
    ).rejects.toThrow(RetryExhausted);
  });
  it('logs retry attempts', async () => {
    const logs: any[] = [];
    try {
      await retry(
        async () => { throw { status: 500, message: 'fail' }; },
        { idempotencyKey: 'key-4', maxAttempts: 2, baseDelay: 0, jitterMs: 0, log: (e) => logs.push(e) },
      );
    } catch {}
    expect(logs.length).toBe(2);
    expect(logs[0].attempt).toBe(1);
    expect(logs[1].attempt).toBe(2);
  });
  it('uses exponential backoff', async () => {
    const sleeps: number[] = [];
    await expect(
      retry(
        async () => { throw { status: 500, message: 'fail' }; },
        {
          idempotencyKey: 'key-5', maxAttempts: 3, baseDelay: 1000, maxDelay: 30000, jitterMs: 0,
          dependencies: { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, randomJitter: () => 0 },
        },
      ),
    ).rejects.toThrow();
    expect(sleeps[0]).toBe(1000);
    expect(sleeps[1]).toBe(2000);
  });
  it('respects maxDelay', async () => {
    const sleeps: number[] = [];
    await expect(
      retry(
        async () => { throw { status: 500, message: 'fail' }; },
        {
          idempotencyKey: 'key-6', maxAttempts: 5, baseDelay: 10000, maxDelay: 15000, jitterMs: 0,
          dependencies: { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, randomJitter: () => 0 },
        },
      ),
    ).rejects.toThrow();
    for (const s of sleeps) expect(s).toBeLessThanOrEqual(15000);
  });
  it('throws on invalid maxAttempts', async () => {
    await expect(retry(() => Promise.resolve(), { maxAttempts: 0 } as any)).rejects.toThrow(RangeError);
  });
});

describe('LoopError', () => {
  it('creates with message and name', async () => {
    const { LoopError } = await import('../../runtime/errors.js');
    const e = new LoopError('test error');
    expect(e.message).toBe('test error');
    expect(e.name).toBe('LoopError');
    expect(e instanceof Error).toBe(true);
  });
});
