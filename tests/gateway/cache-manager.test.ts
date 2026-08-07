import { describe, it, expect } from 'vitest';
import { CacheManager } from '../../gateway/cache-manager.js';

describe('CacheManager', () => {
  it('computes cache key from model+effort+fast_mode', () => {
    const cm = new CacheManager();
    const key = cm.computeKey('gpt-4o', 'high', false);
    expect(key.model_id).toBe('gpt-4o');
    expect(key.effort_level).toBe('high');
    expect(key.fast_mode).toBe(false);
  });

  it('cacheKeyHash is deterministic for same input', () => {
    const cm = new CacheManager();
    const k1 = cm.computeKey('gpt-4o', 'high', false);
    const k2 = cm.computeKey('gpt-4o', 'high', false);
    expect(cm.cacheKeyHash(k1)).toBe(cm.cacheKeyHash(k2));
  });

  it('cacheKeyHash differs for different model', () => {
    const cm = new CacheManager();
    const h1 = cm.cacheKeyHash(cm.computeKey('gpt-4o', 'high', false));
    const h2 = cm.cacheKeyHash(cm.computeKey('claude', 'high', false));
    expect(h1).not.toBe(h2);
  });

  it('first call is always a miss', () => {
    const cm = new CacheManager();
    const result = cm.trackCall(cm.computeKey('gpt-4o', 'high', false));
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('initial call');
  });

  it('same key after first call is a hit', () => {
    const cm = new CacheManager();
    const key = cm.computeKey('gpt-4o', 'high', false);
    cm.trackCall(key);
    const result = cm.trackCall(key);
    expect(result.hit).toBe(true);
  });

  it('model switch invalidates cache', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('gpt-4o', 'high', false));
    const result = cm.trackCall(cm.computeKey('claude', 'high', false));
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('model switch');
  });

  it('effort level change invalidates cache', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('gpt-4o', 'high', false));
    const result = cm.trackCall(cm.computeKey('gpt-4o', 'low', false));
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('effort level change');
  });

  it('fast_mode toggle invalidates cache', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('gpt-4o', 'high', false));
    const result = cm.trackCall(cm.computeKey('gpt-4o', 'high', true));
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('fast-mode toggle');
  });

  it('invalidateToolDefinitions records invalidation', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('gpt-4o', 'high', false));
    cm.invalidateToolDefinitions('mcp connected');
    const inv = cm.getRecentInvalidations(1);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.layer).toBe('tool_definitions');
    expect(inv[0]!.reason).toBe('mcp connected');
  });

  it('invalidateConversation records invalidation', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('gpt-4o', 'high', false));
    cm.invalidateConversation('compaction');
    const inv = cm.getRecentInvalidations(1);
    expect(inv[0]!.layer).toBe('conversation');
    expect(inv[0]!.reason).toBe('compaction');
  });

  it('getMetrics tracks hits and misses', () => {
    const cm = new CacheManager();
    const key = cm.computeKey('gpt-4o', 'high', false);
    cm.trackCall(key); // miss
    cm.trackCall(key); // hit
    cm.trackCall(key); // hit
    const m = cm.getMetrics();
    expect(m.total_calls).toBe(3);
    expect(m.cache_hits).toBe(2);
    expect(m.cache_misses).toBe(1);
    expect(m.hit_rate).toBeCloseTo(2 / 3);
  });

  it('reset clears all state', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('gpt-4o', 'high', false));
    cm.reset();
    const m = cm.getMetrics();
    expect(m.total_calls).toBe(0);
    expect(m.cache_hits).toBe(0);
    expect(m.hit_rate).toBe(0);
  });

  it('getRecentInvalidations respects count', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.trackCall(cm.computeKey('m2', 'high', false));
    cm.trackCall(cm.computeKey('m3', 'high', false));
    expect(cm.getRecentInvalidations(2)).toHaveLength(2);
    expect(cm.getRecentInvalidations(10).length).toBeGreaterThanOrEqual(3);
  });
});
