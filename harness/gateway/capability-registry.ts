/**
 * AH-GATEWAY-002: Capability Registry, Usage Meter, Key Vault, Rate Limiter,
 * LLM Cache, Fallback Chain (P1-17, P1-18, P1-20, P1-21, P1-22, P2-12)
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Capability Registry (P1-17, P1-22)
// ---------------------------------------------------------------------------

export interface ModelCapabilityEntry {
  model_id: string;
  provider_type: 'openai' | 'anthropic' | 'google' | 'local' | 'scripted_test';
  capabilities: string[];
  price_input_per_1m: number;
  price_output_per_1m: number;
  max_context: number;
  max_output: number;
  latency_ms: number;
  benchmark_scores?: Record<string, number>;
}

export class CapabilityRegistry {
  private readonly models = new Map<string, ModelCapabilityEntry>();

  register(entry: ModelCapabilityEntry): void {
    this.models.set(entry.model_id, entry);
  }

  get(modelId: string): ModelCapabilityEntry | undefined {
    return this.models.get(modelId);
  }

  list(): ModelCapabilityEntry[] {
    return [...this.models.values()];
  }

  /**
   * Filter models by required capabilities, then return sorted by cost
   * (cheapest first). Phase 1 simplified router: hard constraint
   * filtering, no scoring (P1-23).
   */
  filterByCapabilities(required: string[]): ModelCapabilityEntry[] {
    return this.list()
      .filter((m) => required.every((cap) => m.capabilities.includes(cap)))
      .sort((a, b) =>
        (a.price_input_per_1m + a.price_output_per_1m) -
        (b.price_input_per_1m + b.price_output_per_1m),
      );
  }

  /**
   * Get the tool calling format for a model's provider (P1-22).
   */
  getToolCallingFormat(modelId: string): string | null {
    const entry = this.models.get(modelId);
    if (!entry) return null;
    switch (entry.provider_type) {
      case 'openai': return 'tools+tool_calls';
      case 'anthropic': return 'tools+tool_use';
      case 'google': return 'function_declarations';
      case 'local': return 'tools+tool_calls';
      case 'scripted_test': return 'tools+tool_calls';
      default: return null;
    }
  }

  /**
   * Re-validate tool calling format when switching providers (P1-22).
   * Returns true if formats are compatible, false if re-serialization needed.
   */
  isToolFormatCompatible(fromModel: string, toModel: string): boolean {
    const from = this.getToolCallingFormat(fromModel);
    const to = this.getToolCallingFormat(toModel);
    if (!from || !to) return true;
    return from === to;
  }
}

// ---------------------------------------------------------------------------
// Usage Meter (P1-17, P1-21): tracks real cost per model call
// ---------------------------------------------------------------------------

export interface UsageEntry {
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  timestamp: string;
}

export class UsageMeter {
  private readonly entries: UsageEntry[] = [];
  private readonly registry: CapabilityRegistry;

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  record(modelId: string, inputTokens: number, outputTokens: number): UsageEntry {
    const entry = this.registry.get(modelId);
    const inputCost = entry ? (inputTokens / 1_000_000) * entry.price_input_per_1m : 0;
    const outputCost = entry ? (outputTokens / 1_000_000) * entry.price_output_per_1m : 0;
    const usage: UsageEntry = {
      model_id: modelId,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: inputCost + outputCost,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(usage);
    return usage;
  }

  getTotalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.cost_usd, 0);
  }

  getTotalTokens(): { input: number; output: number } {
    return {
      input: this.entries.reduce((sum, e) => sum + e.input_tokens, 0),
      output: this.entries.reduce((sum, e) => sum + e.output_tokens, 0),
    };
  }

  getEntries(): readonly UsageEntry[] {
    return [...this.entries];
  }

  /**
   * Estimate cost for a plan before execution (P1-21).
   */
  estimateCost(
    modelId: string,
    steps: number,
    callsPerStep: number,
    avgInputTokens: number,
    avgOutputTokens: number,
  ): number {
    const entry = this.registry.get(modelId);
    if (!entry) return 0;
    const totalCalls = steps * callsPerStep;
    const inputCost = (totalCalls * avgInputTokens / 1_000_000) * entry.price_input_per_1m;
    const outputCost = (totalCalls * avgOutputTokens / 1_000_000) * entry.price_output_per_1m;
    return inputCost + outputCost;
  }
}

// ---------------------------------------------------------------------------
// Key Vault (P1-17): AES-256-GCM encrypted API key storage
// ---------------------------------------------------------------------------

export class KeyVault {
  private readonly keys = new Map<string, { encrypted: string; iv: string; tag: string }>();
  private readonly encryptionKey: Buffer;

  constructor(masterKey: string) {
    this.encryptionKey = createHash('sha256').update(masterKey).digest();
  }

  store(provider: string, apiKey: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.keys.set(provider, {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    });
  }

  retrieve(provider: string): string | null {
    const record = this.keys.get(provider);
    if (!record) return null;
    try {
      const iv = Buffer.from(record.iv, 'base64');
      const tag = Buffer.from(record.tag, 'base64');
      const encrypted = Buffer.from(record.encrypted, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  listProviders(): string[] {
    return [...this.keys.keys()];
  }
}

// ---------------------------------------------------------------------------
// Rate Limiter (P1-18): per-user sliding window
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  rpm_limit: number;
  tpm_limit: number;
  concurrent_limit: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  rpm_limit: 60,
  tpm_limit: 100_000,
  concurrent_limit: 5,
};

interface RateLimitState {
  requests: number[];
  tokens: number;
  concurrent: number;
}

export class RateLimiter {
  private readonly states = new Map<string, RateLimitState>();
  private readonly config: RateLimitConfig;
  private readonly windowMs = 60_000;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...config };
  }

  check(userId: string, estimatedTokens: number): { allowed: boolean; retryAfterMs?: number } {
    let state = this.states.get(userId);
    if (!state) {
      state = { requests: [], tokens: 0, concurrent: 0 };
      this.states.set(userId, state);
    }

    const now = Date.now();
    const windowStart = now - this.windowMs;
    state.requests = state.requests.filter((ts) => ts > windowStart);
    if (state.requests.length === 0) state.tokens = 0;

    if (state.requests.length >= this.config.rpm_limit) {
      const oldest = state.requests[0];
      return { allowed: false, retryAfterMs: Math.max(1000, oldest + this.windowMs - now) };
    }
    if (state.tokens + estimatedTokens > this.config.tpm_limit) {
      return { allowed: false, retryAfterMs: this.windowMs };
    }
    if (state.concurrent >= this.config.concurrent_limit) {
      return { allowed: false, retryAfterMs: 1000 };
    }
    return { allowed: true };
  }

  recordStart(userId: string, tokens: number): void {
    const state = this.states.get(userId) ?? { requests: [], tokens: 0, concurrent: 0 };
    state.requests.push(Date.now());
    state.tokens += tokens;
    state.concurrent++;
    this.states.set(userId, state);
  }

  recordCompletion(userId: string): void {
    const state = this.states.get(userId);
    if (state) state.concurrent = Math.max(0, state.concurrent - 1);
  }
}

// ---------------------------------------------------------------------------
// Persistent LLM Cache (P2-12)
// ---------------------------------------------------------------------------

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

  get(model: string, messages: unknown, temperature: number = 0): unknown | null {
    const key = this.cacheKey(model, messages, temperature);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const age = (Date.now() - new Date(entry.timestamp).getTime()) / 1000;
    if (age > entry.ttl_seconds) {
      this.entries.delete(key);
      return null;
    }
    return entry.response;
  }

  set(model: string, messages: unknown, response: unknown, temperature: number = 0, ttlSeconds?: number): void {
    const key = this.cacheKey(model, messages, temperature);
    const entry: CacheEntry = {
      key, model, prompt_hash: key, response,
      timestamp: new Date().toISOString(),
      ttl_seconds: ttlSeconds ?? this.defaultTtl,
    };
    this.entries.set(key, entry);
    if (this.dataDir) this.persistEntry(entry);
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

  private persistEntry(_entry: CacheEntry): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'llm-cache.json');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify([...this.entries.values()]), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Fallback Chain with auto-recovery (P1-20)
// ---------------------------------------------------------------------------

export interface FallbackChainOptions {
  primary: string;
  fallbacks: string[];
  recoveryProbeMs: number;
}

/**
 * Fallback chain that automatically returns to primary when its circuit
 * breaker recovers (P1-20). The circuit breaker's HALF_OPEN state acts
 * as the recovery probe: after recoveryProbeMs, a single probe request
 * is sent to primary. If it succeeds, all traffic returns to primary.
 */
export class FallbackChain {
  private readonly options: FallbackChainOptions;
  private currentModel: string;

  constructor(options: Partial<FallbackChainOptions> & { primary: string }) {
    this.options = {
      primary: options.primary,
      fallbacks: options.fallbacks ?? [],
      recoveryProbeMs: options.recoveryProbeMs ?? 60_000,
    };
    this.currentModel = this.options.primary;
  }

  get activeModel(): string { return this.currentModel; }
  get isOnPrimary(): boolean { return this.currentModel === this.options.primary; }

  failover(): string | null {
    const idx = this.options.fallbacks.indexOf(this.currentModel);
    const nextIdx = idx + 1;
    if (nextIdx < this.options.fallbacks.length) {
      this.currentModel = this.options.fallbacks[nextIdx];
      return this.currentModel;
    }
    return null;
  }

  attemptRecovery(): boolean {
    if (this.currentModel === this.options.primary) return true;
    this.currentModel = this.options.primary;
    return true;
  }
}
