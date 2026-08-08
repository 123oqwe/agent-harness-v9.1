import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../gateway/rate-limiter.js';
import { CircuitBreaker } from '../../gateway/circuit-breaker.js';

describe('RateLimiter: mutation-targeted', () => {
  it('RPM limit reason includes exact limit number', () => {
    const rl = new RateLimiter({ rpmLimit: 42, tpmLimit: 100_000, concurrentLimit: 50 });
    for (let i = 0; i < 42; i++) { rl.check('u1', 1); rl.release('u1'); }
    const result = rl.check('u1', 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('RPM limit (42/min)');
  });

  it('TPM limit reason includes exact limit number', () => {
    const rl = new RateLimiter({ rpmLimit: 100, tpmLimit: 999, concurrentLimit: 10 });
    rl.check('u1', 500);
    rl.release('u1');
    const result = rl.check('u1', 500);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('TPM limit (999/min)');
  });

  it('Concurrent limit reason includes exact limit number', () => {
    const rl = new RateLimiter({ rpmLimit: 100, tpmLimit: 100_000, concurrentLimit: 3 });
    rl.check('u1', 1);
    rl.check('u1', 1);
    rl.check('u1', 1);
    const result = rl.check('u1', 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Concurrent limit (3)');
  });

  it('default config has rpmLimit 60, tpmLimit 100000, concurrentLimit 5', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 60; i++) { rl.check('u1', 1); rl.release('u1'); }
    const blocked = rl.check('u1', 1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('60');
  });

  it('check does not add entry when RPM blocked', () => {
    const rl = new RateLimiter({ rpmLimit: 2, tpmLimit: 100_000, concurrentLimit: 10 });
    rl.check('u1', 100);
    rl.check('u1', 100);
    const blocked = rl.check('u1', 100);
    expect(blocked.allowed).toBe(false);
    // Release one concurrent, should still be RPM blocked
    rl.release('u1');
    const stillBlocked = rl.check('u1', 100);
    expect(stillBlocked.allowed).toBe(false);
    expect(stillBlocked.reason).toContain('RPM');
  });

  it('release on unknown user sets concurrent to 0', () => {
    const rl = new RateLimiter();
    rl.release('unknown');
    // After release, check should work (concurrent is 0)
    const result = rl.check('unknown', 100);
    expect(result.allowed).toBe(true);
  });

  it('multiple releases keep concurrent at 0', () => {
    const rl = new RateLimiter({ rpmLimit: 100, tpmLimit: 100_000, concurrentLimit: 1 });
    rl.check('u1', 100);
    rl.release('u1');
    rl.release('u1');
    rl.release('u1');
    // Should be able to make another request
    expect(rl.check('u1', 100).allowed).toBe(true);
  });

  it('TPM check uses sum of all entries in window', () => {
    const rl = new RateLimiter({ rpmLimit: 100, tpmLimit: 1000, concurrentLimit: 10 });
    rl.check('u1', 300); rl.release('u1');
    rl.check('u1', 300); rl.release('u1');
    rl.check('u1', 300); rl.release('u1');
    const result = rl.check('u1', 200);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('TPM');
  });

  it('window entries are filtered by timestamp > windowStart', () => {
    const rl = new RateLimiter({ rpmLimit: 1, tpmLimit: 100_000, concurrentLimit: 10 });
    // First call fills the window
    rl.check('u1', 100);
    // Second call should be blocked by RPM
    expect(rl.check('u1', 100).allowed).toBe(false);
  });
});

describe('CircuitBreaker: mutation-targeted', () => {
  it('provider name is stored exactly', () => {
    const cb = new CircuitBreaker('my-provider');
    expect(cb.provider).toBe('my-provider');
  });

  it('default failureThreshold is 5', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.failureThreshold).toBe(5);
  });

  it('default recoveryTimeout is 60000', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.recoveryTimeout).toBe(60_000);
  });

  it('initial state is closed', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.state).toBe('closed');
  });

  it('initial consecutiveFailures is 0', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.consecutiveFailures).toBe(0);
  });

  it('initial lastFailureTime is 0', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.lastFailureTime).toBe(0);
  });

  it('recordFailure increments consecutiveFailures by 1', () => {
    const cb = new CircuitBreaker('test', 10, 60_000);
    cb.recordFailure();
    expect(cb.consecutiveFailures).toBe(1);
    cb.recordFailure();
    expect(cb.consecutiveFailures).toBe(2);
  });

  it('does not open when failures are below threshold', () => {
    const cb = new CircuitBreaker('test', 5, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('closed');
  });

  it('opens exactly at threshold', () => {
    const cb = new CircuitBreaker('test', 3, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('closed');
    cb.recordFailure();
    expect(cb.state).toBe('open');
  });

  it('recordSuccess in closed state resets consecutiveFailures to 0', () => {
    const cb = new CircuitBreaker('test', 5, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.consecutiveFailures).toBe(0);
  });

  it('recordSuccess in closed state sets state to closed', () => {
    const cb = new CircuitBreaker('test', 5, 60_000);
    cb.recordSuccess();
    expect(cb.state).toBe('closed');
  });

  it('canRequest returns false when open and timeout not elapsed', () => {
    const cb = new CircuitBreaker('test', 1, 60_000);
    cb.recordFailure();
    expect(cb.canRequest()).toBe(false);
  });

  it('halfOpenProbeInFlight is set to true after canRequest in half_open', () => {
    const cb = new CircuitBreaker('test', 1, 50);
    cb.recordFailure();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const first = cb.canRequest();
        expect(first).toBe(true);
        // Second probe should be blocked
        const second = cb.canRequest();
        expect(second).toBe(false);
        resolve();
      }, 100);
    });
  });

  it('recordFailure in half_open resets halfOpenProbeInFlight', () => {
    const cb = new CircuitBreaker('test', 1, 50);
    cb.recordFailure();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cb.canRequest(); // transition to half_open
        cb.recordFailure(); // fail the probe
        expect(cb.state).toBe('open');
        // After failure, halfOpenProbeInFlight should be false
        // Wait for timeout again
        setTimeout(() => {
          expect(cb.canRequest()).toBe(true);
          resolve();
        }, 100);
      }, 100);
    });
  });

  it('recordSuccess in half_open closes circuit and resets probe flag', () => {
    const cb = new CircuitBreaker('test', 1, 50);
    cb.recordFailure();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cb.canRequest(); // transition to half_open
        cb.recordSuccess(); // success closes circuit
        expect(cb.state).toBe('closed');
        // Should be able to request immediately
        expect(cb.canRequest()).toBe(true);
        resolve();
      }, 100);
    });
  });
});
