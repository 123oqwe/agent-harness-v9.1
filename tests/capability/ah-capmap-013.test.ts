import { describe, it, expect } from 'vitest';
import { retry, classifyError, CircuitBreaker, RetryExhausted, CircuitOpenError, type RetryLogEntry } from '../../runtime/retry.js';

describe('AH-CAPMAP-013 retry + circuit breaker', () => {
  describe('retry', () => {
    it('calls fn at most maxAttempts times', async () => {
      let calls = 0;
      await expect(retry(async () => { calls++; if (calls < 3) throw Object.assign(new Error('srv'), { status: 500 }); return 'ok'; }, { maxAttempts: 3, baseDelay: 1, jitterMs: 1, idempotencyKey: 'test-1' })).resolves.toBe('ok');
      expect(calls).toBe(3);
    });
    it('non-retryable error (400) does NOT trigger retry', async () => {
      let calls = 0;
      await expect(retry(async () => { calls++; throw Object.assign(new Error('bad'), { status: 400 }); }, { maxAttempts: 3, baseDelay: 1 })).rejects.toThrow();
      expect(calls).toBe(1);
    });
    it('retryable errors: 429, 500, 502, 503, 504, network, timeout', () => {
      expect(classifyError({ status: 429, message: 'x' })).toMatchObject({
        kind: 'rate_limited',
        status: 429,
        retryable: true,
        message: 'x',
      });
      for (const status of [500, 502, 503, 504, 599]) {
        expect(classifyError({ status, message: 'x' })).toMatchObject({
          kind: 'server',
          status,
          retryable: true,
        });
      }
      expect(classifyError(new Error('network error'))).toMatchObject({
        kind: 'network',
        retryable: true,
      });
      expect(classifyError(new Error('ETIMEDOUT'))).toMatchObject({
        kind: 'timeout',
        retryable: true,
      });
    });
    it('default baseDelay=1000 maxDelay=30000 jitterMs=500 maxAttempts=3', () => {
      const logs: RetryLogEntry[] = [];
      const delays: number[] = [];
      let calls = 0;
      return expect(
        retry(
          async () => {
            calls += 1;
            throw { status: 500, message: 'down' };
          },
          {
            idempotencyKey: 'defaults',
            log: (entry) => logs.push(entry),
            dependencies: {
              now: () => new Date('2026-07-25T00:00:00.000Z'),
              randomJitter: () => 0,
              sleep: async (milliseconds) => {
                delays.push(milliseconds);
              },
            },
          },
        ),
      ).rejects.toMatchObject({ attempts: 3 }).then(() => {
        expect(calls).toBe(3);
        expect(delays).toEqual([1_000, 2_000]);
        expect(logs.map((entry) => entry.delayMs)).toEqual([1_000, 2_000, 0]);
        expect(logs[0]!.timestamp).toBe('2026-07-25T00:00:00.000Z');
      });
    });
    it('backoff: attempt N waits baseDelay * 2^(N-1) + random(0, jitterMs)', async () => {
      const delays: number[] = [];
      let calls = 0;
      await retry(async () => { calls++; if (calls < 3) throw Object.assign(new Error('srv'), { status: 500 }); return 'ok'; }, { maxAttempts: 3, baseDelay: 10, jitterMs: 5, idempotencyKey: 'backoff', log: e => delays.push(e.delayMs) });
      expect(delays).toHaveLength(2); // 2 retries
      expect(delays[0]).toBeGreaterThanOrEqual(10); // baseDelay*2^0 + jitter
      expect(delays[0]).toBeLessThanOrEqual(15);
      expect(delays[1]).toBeGreaterThanOrEqual(20); // baseDelay*2^1 + jitter
      expect(delays[1]).toBeLessThanOrEqual(25);
    });
    it('RetryExhausted includes last error and attempt count', async () => {
      try { await retry(async () => { throw Object.assign(new Error('srv'), { status: 500 }); }, { maxAttempts: 2, baseDelay: 1, idempotencyKey: 'exhaust' }); expect.fail('should throw'); }
      catch (e) { expect(e).toBeInstanceOf(RetryExhausted); expect((e as RetryExhausted).attempts).toBe(2); expect((e as RetryExhausted).lastError).toBeDefined(); }
    });
    it('all retry attempts logged with attempt number, delay, error', async () => {
      const logs: RetryLogEntry[] = [];
      try { await retry(async () => { throw Object.assign(new Error('srv'), { status: 500 }); }, { maxAttempts: 2, baseDelay: 1, idempotencyKey: 'log', log: e => logs.push(e) }); } catch { /* */ }
      expect(logs).toHaveLength(2);
      expect(logs[0]!.attempt).toBe(1);
      expect(logs[0]!.error).toBeTruthy();
    });
  });

  describe('circuit breaker', () => {
    it('opens after 5 consecutive failures, blocks for 60s', () => {
      const cb = new CircuitBreaker(5, 60_000);
      for (let i = 0; i < 5; i++) { cb.allow(); cb.recordFailure(); }
      expect(cb.state_).toBe('open');
      expect(() => cb.allow()).toThrow(CircuitOpenError);
    });
    it('half-open allows 1 probe request after cooldown', () => {
      let now = 0;
      const cb = new CircuitBreaker(2, 10, () => now);
      cb.allow(); cb.recordFailure();
      cb.allow(); cb.recordFailure();
      expect(cb.state_).toBe('open');
      expect(() => cb.allow()).toThrow(CircuitOpenError);
      now = 10;
      cb.allow();
      expect(cb.state_).toBe('half_open');
      expect(cb.halfOpenProbeInFlight_).toBe(true);
      expect(() => cb.allow()).toThrow(CircuitOpenError);
      cb.recordSuccess();
      expect(cb.state_).toBe('closed');
      expect(cb.halfOpenProbeInFlight_).toBe(false);
    });
    it('success resets consecutive failures', () => {
      const cb = new CircuitBreaker(5);
      cb.allow(); cb.recordFailure();
      cb.allow(); cb.recordFailure();
      cb.allow(); cb.recordSuccess();
      expect(cb.consecutiveFailures_).toBe(0);
      expect(cb.state_).toBe('closed');
    });
  });

  describe('idempotency enforcement', () => {
    it('does NOT retry when idempotencyKey is absent (prevents non-idempotent replay)', async () => {
      let calls = 0;
      const fn = async () => { calls++; if (calls < 3) throw { status: 500 }; return 'ok'; };
      // Without idempotencyKey, retry must only attempt once — no replay
      await expect(retry(fn, { maxAttempts: 3, baseDelay: 1 })).rejects.toThrow();
      expect(calls).toBe(1);
    });

    it('retries when idempotencyKey is present (safe to replay)', async () => {
      let calls = 0;
      const fn = async () => { calls++; if (calls < 3) throw { status: 500 }; return 'ok'; };
      const result = await retry(fn, { maxAttempts: 3, baseDelay: 1, idempotencyKey: 'key-1' });
      expect(result).toBe('ok');
      expect(calls).toBe(3);
    });
  });

  describe('boundary behavior', () => {
    it.each([400, 401, 403, 404, 422, 499])(
      'classifies HTTP %s as non-retryable',
      (status) => {
        expect(classifyError({ status, message: 'denied' })).toEqual({
          kind: 'unknown',
          status,
          retryable: false,
          message: 'denied',
        });
      },
    );

    it('classifies HTTP 408 as timeout and malformed statuses as unknown', () => {
      expect(classifyError({ status: 408, message: 'late' })).toMatchObject({
        kind: 'timeout',
        status: 408,
        retryable: true,
      });
      expect(classifyError({ status: '500', message: 'wrong type' })).toEqual({
        kind: 'unknown',
        retryable: false,
        message: 'wrong type',
        cause: { status: '500', message: 'wrong type' },
      });
      expect(classifyError(null)).toMatchObject({
        kind: 'unknown',
        retryable: false,
        message: 'null',
      });
      expect(classifyError({ status: 600, message: 'not a server error' }))
        .toEqual({
          kind: 'unknown',
          status: 600,
          retryable: false,
          message: 'not a server error',
        });
      expect(classifyError({ status: 500.5, message: 'not an integer' }))
        .toEqual({
          kind: 'unknown',
          retryable: false,
          message: 'not an integer',
          cause: { status: 500.5, message: 'not an integer' },
        });
      expect(classifyError({ message: 42 })).toEqual({
        kind: 'unknown',
        retryable: false,
        message: '[object Object]',
        cause: { message: 42 },
      });
    });

    it('reopens a failed half-open probe and reports exact remaining cooldown', () => {
      let now = 100;
      const cb = new CircuitBreaker(1, 50, () => now);
      cb.recordFailure();
      now = 120;
      try {
        cb.allow();
        expect.fail('expected open circuit');
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        expect((error as CircuitOpenError).retryAfterMs).toBe(30);
      }
      now = 150;
      cb.allow();
      cb.recordFailure();
      expect(cb.state_).toBe('open');
      now = 151;
      expect(() => cb.allow()).toThrow(CircuitOpenError);
    });

    it('validates circuit and retry configuration', async () => {
      expect(() => new CircuitBreaker(0)).toThrow(RangeError);
      expect(() => new CircuitBreaker(1, -1)).toThrow(RangeError);
      for (const options of [
        { maxAttempts: 0 },
        { baseDelay: -1 },
        { maxDelay: -1 },
        { jitterMs: -1 },
      ]) {
        await expect(retry(async () => 'never', options)).rejects.toThrow(
          RangeError,
        );
      }
      await expect(
        retry(async () => 'ok', {
          maxAttempts: 1,
          baseDelay: 0,
          maxDelay: 0,
          jitterMs: 0,
        }),
      ).resolves.toBe('ok');
    });

    it('caps delay, validates jitter and clock, and preserves original non-retryable error', async () => {
      const delays: number[] = [];
      let attempts = 0;
      await expect(
        retry(
          async () => {
            attempts += 1;
            if (attempts < 3) throw { status: 500, message: 'retry' };
            return 'ok';
          },
          {
            idempotencyKey: 'cap',
            maxAttempts: 3,
            baseDelay: 80,
            maxDelay: 100,
            jitterMs: 30,
            dependencies: {
              randomJitter: () => 30,
              sleep: async (milliseconds) => {
                delays.push(milliseconds);
              },
            },
          },
        ),
      ).resolves.toBe('ok');
      expect(delays).toEqual([100, 100]);

      await expect(
        retry(async () => {
          throw { status: 500 };
        }, {
          idempotencyKey: 'bad-jitter',
          maxAttempts: 2,
          dependencies: { randomJitter: () => 501 },
        }),
      ).rejects.toThrow('randomJitter returned an out-of-range value');
      const lowJitterCause = { status: 500, message: 'low jitter' };
      try {
        await retry(async () => {
          throw lowJitterCause;
        }, {
          idempotencyKey: 'low-jitter',
          maxAttempts: 2,
          dependencies: { randomJitter: () => -1 },
        });
        expect.fail('expected invalid jitter');
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        expect((error as Error & { cause: unknown }).cause).toBe(
          lowJitterCause,
        );
      }

      const clockCause = { status: 500, message: 'bad clock' };
      await expect(
        retry(async () => {
          throw clockCause;
        }, {
          idempotencyKey: 'bad-clock',
          maxAttempts: 2,
          dependencies: {
            randomJitter: () => 0,
            now: () => new Date(Number.NaN),
          },
        }),
      ).rejects.toThrow('retry clock returned an invalid date');

      const original = { status: 400, message: 'bad request' };
      await expect(retry(async () => {
        throw original;
      }, { log: () => undefined })).rejects.toBe(original);
    });

    it('treats a blank idempotency key as unsafe to replay', async () => {
      let calls = 0;
      await expect(
        retry(async () => {
          calls += 1;
          throw { status: 500 };
        }, { idempotencyKey: '   ', maxAttempts: 3 }),
      ).rejects.toMatchObject({ attempts: 1 });
      expect(calls).toBe(1);
    });

    it('exposes typed, exact retry and circuit errors', () => {
      const root = new Error('root failure');
      const exhausted = new RetryExhausted(root, 2);
      expect(exhausted.name).toBe('RetryExhausted');
      expect(exhausted.message).toBe(
        'retry exhausted after 2 attempts: root failure',
      );
      expect(exhausted.lastError).toBe(root);
      expect(exhausted.attempts).toBe(2);

      const exhaustedValue = new RetryExhausted({ code: 1 }, 1);
      expect(exhaustedValue.message).toBe(
        'retry exhausted after 1 attempts: [object Object]',
      );
      const open = new CircuitOpenError(25);
      expect(open.name).toBe('CircuitOpenError');
      expect(open.message).toBe('circuit breaker open; retry after 25ms');
      expect(open.retryAfterMs).toBe(25);
    });

    it('uses zero default jitter without calling crypto for a zero range', async () => {
      const delays: number[] = [];
      let calls = 0;
      await expect(
        retry(async () => {
          calls += 1;
          if (calls === 1) throw { status: 500, message: 'once' };
          return 'ok';
        }, {
          idempotencyKey: 'zero',
          maxAttempts: 2,
          baseDelay: 0,
          maxDelay: 0,
          jitterMs: 0,
          dependencies: {
            sleep: async (milliseconds) => {
              delays.push(milliseconds);
            },
          },
        }),
      ).resolves.toBe('ok');
      expect(delays).toEqual([0]);
    });
  });
});
