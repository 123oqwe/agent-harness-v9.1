import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../gateway/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts in closed state and allows requests', () => {
    const cb = new CircuitBreaker('test-provider');
    expect(cb.state).toBe('closed');
    expect(cb.canRequest()).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker('test', 3, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('closed');
    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.canRequest()).toBe(false);
  });

  it('resets consecutive failures on success', () => {
    const cb = new CircuitBreaker('test', 3, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.state).toBe('closed');
  });

  it('transitions to half_open after recovery timeout', () => {
    const cb = new CircuitBreaker('test', 1, 100);
    cb.recordFailure();
    expect(cb.state).toBe('open');
    // Wait for recovery timeout
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.canRequest()).toBe(true);
        expect(cb.state).toBe('half_open');
        resolve();
      }, 150);
    });
  });

  it('closes on successful probe in half_open', () => {
    const cb = new CircuitBreaker('test', 1, 100);
    cb.recordFailure();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cb.canRequest(); // triggers transition to half_open
        cb.recordSuccess();
        expect(cb.state).toBe('closed');
        resolve();
      }, 150);
    });
  });

  it('reopens on failed probe in half_open', () => {
    const cb = new CircuitBreaker('test', 1, 100);
    cb.recordFailure();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cb.canRequest(); // triggers transition to half_open
        cb.recordFailure();
        expect(cb.state).toBe('open');
        resolve();
      }, 150);
    });
  });

  it('only allows one probe at a time in half_open', () => {
    const cb = new CircuitBreaker('test', 1, 100);
    cb.recordFailure();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.canRequest()).toBe(true); // first probe allowed
        expect(cb.canRequest()).toBe(false); // second probe blocked
        resolve();
      }, 150);
    });
  });

  it('blocks requests while open and before timeout', () => {
    const cb = new CircuitBreaker('test', 1, 60_000);
    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.canRequest()).toBe(false);
  });

  it('records last failure time on failure', () => {
    const cb = new CircuitBreaker('test', 5, 60_000);
    const before = Date.now();
    cb.recordFailure();
    expect(cb.lastFailureTime).toBeGreaterThanOrEqual(before);
  });

  it('uses custom failure threshold and recovery timeout', () => {
    const cb = new CircuitBreaker('test', 10, 5_000);
    expect(cb.failureThreshold).toBe(10);
    expect(cb.recoveryTimeout).toBe(5_000);
  });

  it('does not open before threshold even with many successes between failures', () => {
    const cb = new CircuitBreaker('test', 3, 60_000);
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.state).toBe('closed');
    expect(cb.consecutiveFailures).toBe(1);
  });
});
