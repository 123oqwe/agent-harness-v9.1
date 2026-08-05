import { describe, it, expect } from 'vitest';
import {
  CircuitBreaker,
  ModelGateway,
} from '../../gateway/model-gateway.js';
import { ScriptedTestProvider } from '../../gateway/scripted-provider.js';
import type { ProviderError } from '../../gateway/provider.js';

const serverErr: ProviderError = { kind: 'server', retryable: true, detail: '500' };
const rateErr: ProviderError = { kind: 'rate_limited', retryable: false, detail: '429' };
const authErr: ProviderError = { kind: 'auth', retryable: false, detail: '401' };

describe('AH-GATEWAY-001: Circuit Breaker (P1-19)', () => {
  it('starts in CLOSED state and allows requests', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 1000 });
    expect(cb.currentState).toBe('closed');
    expect(cb.allowRequest()).toBe(true);
  });

  it('trips to OPEN after threshold consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 1000 });
    cb.recordFailure(serverErr);
    cb.recordFailure(serverErr);
    expect(cb.currentState).toBe('closed');
    cb.recordFailure(serverErr);
    expect(cb.currentState).toBe('open');
    expect(cb.allowRequest()).toBe(false);
  });

  it('transitions to HALF_OPEN after recovery timeout', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50 });
    cb.recordFailure(serverErr);
    cb.recordFailure(serverErr);
    expect(cb.currentState).toBe('open');
    const start = Date.now();
    while (Date.now() - start < 60) { /* busy wait */ }
    expect(cb.currentState).toBe('half_open');
    expect(cb.allowRequest()).toBe(true);
  });

  it('HALF_OPEN probe success resets to CLOSED', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50 });
    cb.recordFailure(serverErr);
    cb.recordFailure(serverErr);
    const start = Date.now();
    while (Date.now() - start < 60) { /* busy wait */ }
    cb.allowRequest();
    cb.recordSuccess();
    expect(cb.currentState).toBe('closed');
    expect(cb.failureCount).toBe(0);
  });

  it('HALF_OPEN probe failure goes back to OPEN', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50 });
    cb.recordFailure(serverErr);
    cb.recordFailure(serverErr);
    const start = Date.now();
    while (Date.now() - start < 60) { /* busy wait */ }
    cb.allowRequest();
    cb.recordFailure(serverErr);
    expect(cb.currentState).toBe('open');
  });

  it('only server/timeout errors trip the breaker', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 1000 });
    cb.recordFailure(rateErr);
    cb.recordFailure(authErr);
    expect(cb.currentState).toBe('closed');
    expect(cb.failureCount).toBe(0);
  });

  it('reset clears the breaker to CLOSED', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 1000 });
    cb.recordFailure(serverErr);
    cb.recordFailure(serverErr);
    expect(cb.currentState).toBe('open');
    cb.reset();
    expect(cb.currentState).toBe('closed');
    expect(cb.failureCount).toBe(0);
  });
});

describe('AH-GATEWAY-001: Gateway Circuit Breaker Integration (P1-19)', () => {
  it('gateway exposes per-provider circuit breaker', () => {
    const gw = new ModelGateway([new ScriptedTestProvider({ queue: [{ content: 'ok' }] })]);
    const cb = gw.getCircuitBreaker('scripted_test');
    expect(cb).toBeDefined();
    expect(cb.currentState).toBe('closed');
  });
});
