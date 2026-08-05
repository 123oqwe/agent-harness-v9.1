/**
 * AH-GATEWAY-004: LLM Cache (P2-12)
 * Persistent cache for identical model+prompt+temperature requests.
 * TTL-based expiry (default 24h). Uses SHA-256 key.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface CacheEntry {
  key: string;
  model: string;
  prompt_hash: string;
  response: unknown;
  timestamp: string;
  ttl_seconds: number;
}

export class LLMCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly dataDir: string | null;
  private readonly defaultTtl: number;

  constructor(opts: { dataDir?: string; ttlSeconds?: number } = {}) {
    this.dataDir = opts.dataDir ?? null;
    this.defaultTtl = opts.ttlSeconds ?? 86_400;
    if (this.dataDir) this.load();
  }

  private cacheKey(model: string, messages: unknown, temperature: number): string {
    return createHash('sha256').update(JSON.stringify({ model, messages, temperature })).digest('hex');
  }

  get(model: string, messages: unknown, temperature = 0): unknown | null {
    const key = this.cacheKey(model, messages, temperature);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const age = (Date.now() - new Date(entry.timestamp).getTime()) / 1000;
    if (age > entry.ttl_seconds) { this.entries.delete(key); return null; }
    return entry.response;
  }

  set(model: string, messages: unknown, response: unknown, temperature = 0, ttlSeconds?: number): void {
    const key = this.cacheKey(model, messages, temperature);
    const entry: CacheEntry = {
      key, model, prompt_hash: key, response,
      timestamp: new Date().toISOString(),
      ttl_seconds: ttlSeconds ?? this.defaultTtl,
    };
    this.entries.set(key, entry);
    if (this.dataDir) this.persist();
  }

  get size(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); }

  private load(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'llm-cache.json');
    if (!existsSync(filePath)) return;
    try {
      const data = readFileSync(filePath, 'utf8');
      const entries: CacheEntry[] = JSON.parse(data);
      for (const entry of entries) this.entries.set(entry.key, entry);
    } catch { /* corrupted, start fresh */ }
  }

  private persist(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'llm-cache.json');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify([...this.entries.values()]), 'utf8');
  }
}
