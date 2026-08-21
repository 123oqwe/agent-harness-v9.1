import { describe, it, expect } from 'vitest';
import {
  CASCADE_THRESHOLD,
  FALLBACK_TYPES,
  MAX_SAME_PROVIDER_ATTEMPTS,
  buildFallbackChain,
  classifyFallback,
  decideNext,
  evaluateCascade,
  isRetryableFallback,
} from '../../router/fallback.js';

const chain = ['A', 'B', 'C'];

describe('AH-ROUTER-FALLBACK-11-001 taxonomy', () => {
  it('exposes exactly the 11 mandated fallback types', () => {
    expect(FALLBACK_TYPES).toEqual([
      'model_degraded',
      'model_unavailable',
      'rate_limited',
      'context_too_long',
      'tool_unavailable',
      'provider_down',
      'quota_exceeded',
      'latency_timeout',
      'content_filter',
      'structured_output_fail',
      'capability_mismatch',
    ]);
    expect(FALLBACK_TYPES).toHaveLength(11);
  });

  it('classifies each type as retryable or non-retryable', () => {
    const retryable = ['model_degraded', 'model_unavailable', 'rate_limited', 'provider_down', 'latency_timeout'];
    const nonRetryable = [
      'context_too_long',
      'tool_unavailable',
      'quota_exceeded',
      'content_filter',
      'structured_output_fail',
      'capability_mismatch',
    ];
    for (const t of retryable) {
      expect(classifyFallback(t as (typeof FALLBACK_TYPES)[number])).toEqual({ type: t, retryable: true });
      expect(isRetryableFallback(t as (typeof FALLBACK_TYPES)[number])).toBe(true);
    }
    for (const t of nonRetryable) {
      expect(classifyFallback(t as (typeof FALLBACK_TYPES)[number])).toEqual({ type: t, retryable: false });
      expect(isRetryableFallback(t as (typeof FALLBACK_TYPES)[number])).toBe(false);
    }
  });
});

describe('AH-ROUTER-FALLBACK-11-001 chain construction', () => {
  it('builds a chain that never returns to the primary', () => {
    const r = buildFallbackChain({ primary_provider_id: 'P', candidates: ['P', 'A', 'B', 'C'] });
    expect(r.chain).toEqual(['A', 'B', 'C']);
    expect(r.never_returns_to_primary).toBe(true);
    expect(r.chain).not.toContain('P');
  });

  it('re-validates data policy per candidate and drops policy-denied ones', () => {
    const allowed = new Set(['A', 'C']);
    const r = buildFallbackChain({
      primary_provider_id: 'P',
      candidates: ['A', 'B', 'C'],
      policyOk: (id) => allowed.has(id),
    });
    expect(r.chain).toEqual(['A', 'C']);
  });

  it('with no surviving candidate the chain is empty', () => {
    const r = buildFallbackChain({ primary_provider_id: 'P', candidates: ['P'], policyOk: () => true });
    expect(r.chain).toEqual([]);
  });
});

describe('AH-ROUTER-FALLBACK-11-001 next-provider decisions', () => {
  it('a non-retryable failure moves to the next untried candidate', () => {
    const r = decideNext({ chain, primary_provider_id: 'P', attempted: ['A'], last_failure: 'context_too_long', same_provider_attempts: 1 });
    expect(r).toEqual({ next_provider_id: 'B', retry_same: false, reached_chain_end: false });
  });

  it('never selects the primary, even if it is an untried candidate', () => {
    // chain contains P but it is filtered at build time; decideNext also guards.
    const r = decideNext({ chain: ['P', 'A'], primary_provider_id: 'P', attempted: [], last_failure: 'tool_unavailable', same_provider_attempts: 0 });
    expect(r.next_provider_id).toBe('A');
  });

  it('reports the chain end once every candidate has been tried', () => {
    const r = decideNext({ chain, primary_provider_id: 'P', attempted: ['A', 'B', 'C'], last_failure: 'tool_unavailable', same_provider_attempts: 0 });
    expect(r).toEqual({ next_provider_id: null, retry_same: false, reached_chain_end: true });
  });

  it('retries the current provider on a retryable failure, capped at MAX_SAME_PROVIDER_ATTEMPTS', () => {
    // first retryable failure -> retry same provider
    const r1 = decideNext({ chain, primary_provider_id: 'P', attempted: ['A'], last_failure: 'rate_limited', same_provider_attempts: 0 });
    expect(r1.retry_same).toBe(true);
    expect(r1.next_provider_id).toBe('A');
    // at the cap -> switch to next candidate
    const r2 = decideNext({ chain, primary_provider_id: 'P', attempted: ['A'], last_failure: 'rate_limited', same_provider_attempts: MAX_SAME_PROVIDER_ATTEMPTS });
    expect(r2.retry_same).toBe(false);
    expect(r2.next_provider_id).toBe('B');
  });
});

describe('AH-ROUTER-FALLBACK-11-001 cascade handling', () => {
  it('below the threshold the run continues without a pause', () => {
    const r = evaluateCascade(CASCADE_THRESHOLD - 1);
    expect(r.durable_pause).toBe(false);
    expect(r.user_notified).toBe(false);
  });

  it('at the threshold a cascade triggers a durable pause and a user notification', () => {
    const r = evaluateCascade(CASCADE_THRESHOLD);
    expect(r.durable_pause).toBe(true);
    expect(r.user_notified).toBe(true);
    expect(r.reason).toContain('cascade');
  });

  it('deeper cascades still pause durably (never a silent retry)', () => {
    expect(evaluateCascade(10).durable_pause).toBe(true);
  });
});
