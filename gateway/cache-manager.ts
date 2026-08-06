import { createHash } from 'node:crypto';

export type CacheLayer = 'system_prompt' | 'tool_definitions' | 'conversation';

export interface CacheKey {
  model_id: string;
  effort_level: string;
  fast_mode: boolean;
}

export interface CacheInvalidation {
  timestamp: number;
  layer: CacheLayer;
  reason: string;
  previous_key: string;
  new_key: string;
}

export interface CacheMetrics {
  total_calls: number;
  cache_hits: number;
  cache_misses: number;
  hit_rate: number;
  invalidations: number;
  by_reason: Record<string, number>;
}

export class CacheManager {
  private currentKey: CacheKey | null = null;
  private readonly invalidations: CacheInvalidation[] = [];
  private totalCalls = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private readonly byReason: Record<string, number> = {};

  computeKey(model_id: string, effort_level: string, fast_mode: boolean): CacheKey {
    return { model_id, effort_level, fast_mode };
  }

  cacheKeyHash(key: CacheKey): string {
    return createHash('sha256').update(`${key.model_id}:${key.effort_level}:${key.fast_mode}`).digest('hex').slice(0, 16);
  }

  /** Called before each model call. Returns true if the cache is preserved (hit), false if invalidated (miss). */
  trackCall(key: CacheKey): { hit: boolean; invalidated_layer?: CacheLayer; reason?: string } {
    this.totalCalls++;
    if (this.currentKey === null) {
      this.currentKey = key;
      this.cacheMisses++;
      return { hit: false, invalidated_layer: 'system_prompt', reason: 'initial call' };
    }
    if (this.currentKey.model_id !== key.model_id) {
      this.recordInvalidation('system_prompt', 'model switch', key);
      this.recordInvalidation('conversation', 'model switch', key);
      this.currentKey = key;
      this.cacheMisses++;
      return { hit: false, invalidated_layer: 'system_prompt', reason: 'model switch' };
    }
    if (this.currentKey.effort_level !== key.effort_level) {
      this.recordInvalidation('system_prompt', 'effort level change', key);
      this.currentKey = key;
      this.cacheMisses++;
      return { hit: false, invalidated_layer: 'system_prompt', reason: 'effort level change' };
    }
    if (this.currentKey.fast_mode !== key.fast_mode) {
      this.recordInvalidation('system_prompt', 'fast-mode toggle', key);
      this.currentKey = key;
      this.cacheMisses++;
      return { hit: false, invalidated_layer: 'system_prompt', reason: 'fast-mode toggle' };
    }
    this.cacheHits++;
    return { hit: true };
  }

  /** Called when tool definitions change (MCP connect/disconnect, generated tools). */
  invalidateToolDefinitions(reason: string): void {
    if (this.currentKey) {
      this.recordInvalidation('tool_definitions', reason, this.currentKey);
      this.cacheMisses++;
    }
  }

  /** Called when compaction or context_reset rewrites the conversation layer. */
  invalidateConversation(reason: string): void {
    if (this.currentKey) {
      this.recordInvalidation('conversation', reason, this.currentKey);
    }
  }

  private recordInvalidation(layer: CacheLayer, reason: string, newKey: CacheKey): void {
    const prevKey = this.currentKey ? this.cacheKeyHash(this.currentKey) : 'none';
    this.invalidations.push({
      timestamp: Date.now(),
      layer,
      reason,
      previous_key: prevKey,
      new_key: this.cacheKeyHash(newKey),
    });
    this.byReason[reason] = (this.byReason[reason] ?? 0) + 1;
    if (this.invalidations.length > 1000) this.invalidations.splice(0, this.invalidations.length - 1000);
  }

  getMetrics(): CacheMetrics {
    return {
      total_calls: this.totalCalls,
      cache_hits: this.cacheHits,
      cache_misses: this.cacheMisses,
      hit_rate: this.totalCalls > 0 ? this.cacheHits / this.totalCalls : 0,
      invalidations: this.invalidations.length,
      by_reason: { ...this.byReason },
    };
  }

  getRecentInvalidations(count = 10): CacheInvalidation[] {
    return this.invalidations.slice(-count);
  }

  reset(): void {
    this.currentKey = null;
    this.invalidations.length = 0;
    this.totalCalls = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}
