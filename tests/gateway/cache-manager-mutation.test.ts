import { describe, it, expect } from 'vitest';
import { CacheManager } from '../../gateway/cache-manager.js';

describe('CacheManager: mutation-targeted tests', () => {
  it('first call returns invalidated_layer system_prompt', () => {
    const cm = new CacheManager();
    const result = cm.trackCall(cm.computeKey('m1', 'high', false));
    expect(result.invalidated_layer).toBe('system_prompt');
  });

  it('model switch invalidates both system_prompt and conversation', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    const result = cm.trackCall(cm.computeKey('m2', 'high', false));
    expect(result.invalidated_layer).toBe('system_prompt');
    // Two invalidations should be recorded: system_prompt + conversation
    const invs = cm.getRecentInvalidations(10);
    const layers = invs.map(i => i.layer);
    expect(layers).toContain('system_prompt');
    expect(layers).toContain('conversation');
  });

  it('effort level change only invalidates system_prompt', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    const result = cm.trackCall(cm.computeKey('m1', 'low', false));
    expect(result.invalidated_layer).toBe('system_prompt');
    const invs = cm.getRecentInvalidations(10);
    // Should NOT contain conversation invalidation for effort change
    const convInvs = invs.filter(i => i.layer === 'conversation');
    expect(convInvs).toHaveLength(0);
  });

  it('fast_mode toggle only invalidates system_prompt', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    const result = cm.trackCall(cm.computeKey('m1', 'high', true));
    expect(result.invalidated_layer).toBe('system_prompt');
  });

  it('cacheKeyHash differs for different effort_level', () => {
    const cm = new CacheManager();
    const h1 = cm.cacheKeyHash(cm.computeKey('m1', 'high', false));
    const h2 = cm.cacheKeyHash(cm.computeKey('m1', 'low', false));
    expect(h1).not.toBe(h2);
  });

  it('cacheKeyHash differs for different fast_mode', () => {
    const cm = new CacheManager();
    const h1 = cm.cacheKeyHash(cm.computeKey('m1', 'high', false));
    const h2 = cm.cacheKeyHash(cm.computeKey('m1', 'high', true));
    expect(h1).not.toBe(h2);
  });

  it('cacheKeyHash is 16 chars long', () => {
    const cm = new CacheManager();
    const hash = cm.cacheKeyHash(cm.computeKey('m1', 'high', false));
    expect(hash).toHaveLength(16);
  });

  it('invalidateToolDefinitions increments cache_misses', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    const before = cm.getMetrics().cache_misses;
    cm.invalidateToolDefinitions('test reason');
    const after = cm.getMetrics().cache_misses;
    expect(after).toBe(before + 1);
  });

  it('invalidateToolDefinitions does nothing when no current key', () => {
    const cm = new CacheManager();
    cm.invalidateToolDefinitions('test');
    expect(cm.getMetrics().invalidations).toBe(0);
    expect(cm.getMetrics().cache_misses).toBe(0);
  });

  it('invalidateConversation does not increment cache_misses', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    const before = cm.getMetrics().cache_misses;
    cm.invalidateConversation('compaction');
    const after = cm.getMetrics().cache_misses;
    expect(after).toBe(before);
  });

  it('invalidateConversation does nothing when no current key', () => {
    const cm = new CacheManager();
    cm.invalidateConversation('test');
    expect(cm.getMetrics().invalidations).toBe(0);
  });

  it('getMetrics returns hit_rate 0 when no calls', () => {
    const cm = new CacheManager();
    expect(cm.getMetrics().hit_rate).toBe(0);
  });

  it('getMetrics returns correct invalidations count', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.trackCall(cm.computeKey('m2', 'high', false));
    cm.trackCall(cm.computeKey('m3', 'high', false));
    // Each model switch creates 2 invalidations (system_prompt + conversation)
    expect(cm.getMetrics().invalidations).toBe(4);
  });

  it('getMetrics by_reason tracks reasons', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.trackCall(cm.computeKey('m2', 'high', false));
    cm.invalidateToolDefinitions('mcp connected');
    const m = cm.getMetrics();
    expect(m.by_reason['model switch']).toBe(2);
    expect(m.by_reason['mcp connected']).toBe(1);
  });

  it('getRecentInvalidations returns last N entries', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.trackCall(cm.computeKey('m2', 'high', false));
    const invs = cm.getRecentInvalidations(1);
    expect(invs).toHaveLength(1);
  });

  it('invalidation records previous_key and new_key', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.trackCall(cm.computeKey('m2', 'high', false));
    const inv = cm.getRecentInvalidations(10)[0]!;
    expect(inv.previous_key).toBeDefined();
    expect(inv.new_key).toBeDefined();
    expect(inv.previous_key).not.toBe(inv.new_key);
  });

  it('invalidation records timestamp', () => {
    const cm = new CacheManager();
    const before = Date.now();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.trackCall(cm.computeKey('m2', 'high', false));
    const after = Date.now();
    const inv = cm.getRecentInvalidations(1)[0]!;
    expect(inv.timestamp).toBeGreaterThanOrEqual(before);
    expect(inv.timestamp).toBeLessThanOrEqual(after);
  });

  it('reset clears invalidations array', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.trackCall(cm.computeKey('m2', 'high', false));
    cm.reset();
    expect(cm.getRecentInvalidations(10)).toHaveLength(0);
    expect(cm.getMetrics().invalidations).toBe(0);
  });

  it('reset clears invalidations but not by_reason', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.trackCall(cm.computeKey('m2', 'high', false));
    cm.reset();
    // reset() clears invalidations array and counters, but by_reason persists
    expect(cm.getMetrics().invalidations).toBe(0);
    expect(cm.getMetrics().total_calls).toBe(0);
  });

  it('trackCall after reset treats as initial call', () => {
    const cm = new CacheManager();
    cm.trackCall(cm.computeKey('m1', 'high', false));
    cm.reset();
    const result = cm.trackCall(cm.computeKey('m1', 'high', false));
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('initial call');
  });
});
