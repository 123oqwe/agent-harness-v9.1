import { describe, it, expect } from 'vitest';
import {
  CapabilityRegistry,
  UsageMeter,
  KeyVault,
  RateLimiter,
  LLMCache,
  FallbackChain,
} from '../../gateway/capability-registry.js';

describe('P1-17: CapabilityRegistry', () => {
  it('registers and retrieves model profiles', () => {
    const reg = new CapabilityRegistry();
    reg.register({
      model_id: 'gpt-4o', provider_type: 'openai',
      capabilities: ['tool_calling', 'vision'],
      price_input_per_1m: 2.5, price_output_per_1m: 10,
      max_context: 128000, max_output: 16384, latency_ms: 800,
    });
    expect(reg.get('gpt-4o')).toBeDefined();
  });

  it('filterByCapabilities returns cheapest matching model', () => {
    const reg = new CapabilityRegistry();
    reg.register({ model_id: 'expensive', provider_type: 'openai', capabilities: ['tool_calling'], price_input_per_1m: 10, price_output_per_1m: 30, max_context: 128000, max_output: 16384, latency_ms: 800 });
    reg.register({ model_id: 'cheap', provider_type: 'openai', capabilities: ['tool_calling'], price_input_per_1m: 1, price_output_per_1m: 3, max_context: 128000, max_output: 16384, latency_ms: 500 });
    const results = reg.filterByCapabilities(['tool_calling']);
    expect(results[0].model_id).toBe('cheap');
  });

  it('getToolCallingFormat returns format per provider (P1-22)', () => {
    const reg = new CapabilityRegistry();
    reg.register({ model_id: 'gpt-4o', provider_type: 'openai', capabilities: [], price_input_per_1m: 0, price_output_per_1m: 0, max_context: 128000, max_output: 16384, latency_ms: 0 });
    reg.register({ model_id: 'claude', provider_type: 'anthropic', capabilities: [], price_input_per_1m: 0, price_output_per_1m: 0, max_context: 200000, max_output: 8192, latency_ms: 0 });
    expect(reg.getToolCallingFormat('gpt-4o')).toBe('tools+tool_calls');
    expect(reg.getToolCallingFormat('claude')).toBe('tools+tool_use');
  });

  it('isToolFormatCompatible detects format mismatch (P1-22)', () => {
    const reg = new CapabilityRegistry();
    reg.register({ model_id: 'gpt-4o', provider_type: 'openai', capabilities: [], price_input_per_1m: 0, price_output_per_1m: 0, max_context: 128000, max_output: 16384, latency_ms: 0 });
    reg.register({ model_id: 'claude', provider_type: 'anthropic', capabilities: [], price_input_per_1m: 0, price_output_per_1m: 0, max_context: 200000, max_output: 8192, latency_ms: 0 });
    expect(reg.isToolFormatCompatible('gpt-4o', 'claude')).toBe(false);
    expect(reg.isToolFormatCompatible('gpt-4o', 'gpt-4o')).toBe(true);
  });
});

describe('P1-17/P1-21: UsageMeter', () => {
  it('records usage with real cost', () => {
    const reg = new CapabilityRegistry();
    reg.register({ model_id: 'gpt-4o', provider_type: 'openai', capabilities: [], price_input_per_1m: 2.5, price_output_per_1m: 10, max_context: 128000, max_output: 16384, latency_ms: 0 });
    const meter = new UsageMeter(reg);
    meter.record('gpt-4o', 1000000, 500000);
    expect(meter.getTotalCost()).toBeCloseTo(2.5 + 5, 2);
  });

  it('estimateCost for a plan (P1-21)', () => {
    const reg = new CapabilityRegistry();
    reg.register({ model_id: 'gpt-4o', provider_type: 'openai', capabilities: [], price_input_per_1m: 2.5, price_output_per_1m: 10, max_context: 128000, max_output: 16384, latency_ms: 0 });
    const meter = new UsageMeter(reg);
    const cost = meter.estimateCost('gpt-4o', 10, 2, 5000, 2000);
    expect(cost).toBeGreaterThan(0);
  });
});

describe('P1-17: KeyVault', () => {
  it('encrypts and decrypts API keys', () => {
    const vault = new KeyVault('master-key');
    vault.store('openai', 'sk-test-123');
    expect(vault.retrieve('openai')).toBe('sk-test-123');
  });

  it('returns null for unknown provider', () => {
    const vault = new KeyVault('master-key');
    expect(vault.retrieve('unknown')).toBeNull();
  });
});

describe('P1-18: RateLimiter', () => {
  it('allows requests within limits', () => {
    const rl = new RateLimiter({ rpm_limit: 10, tpm_limit: 100000, concurrent_limit: 5 });
    expect(rl.check('user1', 1000).allowed).toBe(true);
  });

  it('rejects when RPM exceeded', () => {
    const rl = new RateLimiter({ rpm_limit: 2, tpm_limit: 100000, concurrent_limit: 5 });
    rl.recordStart('user1', 100);
    rl.recordCompletion('user1');
    rl.recordStart('user1', 100);
    rl.recordCompletion('user1');
    expect(rl.check('user1', 100).allowed).toBe(false);
  });
});

describe('P2-12: LLMCache', () => {
  it('caches and retrieves responses', () => {
    const cache = new LLMCache();
    cache.set('gpt-4o', [{ role: 'user', content: 'hi' }], { content: 'hello' });
    const cached = cache.get('gpt-4o', [{ role: 'user', content: 'hi' }]);
    expect(cached).toEqual({ content: 'hello' });
  });

  it('returns null for cache miss', () => {
    const cache = new LLMCache();
    expect(cache.get('gpt-4o', [{ role: 'user', content: 'hi' }])).toBeNull();
  });
});

describe('P1-20: FallbackChain', () => {
  it('starts on primary', () => {
    const chain = new FallbackChain({ primary: 'gpt-4o', fallbacks: ['claude', 'gemini'] });
    expect(chain.isOnPrimary).toBe(true);
  });

  it('failover switches to fallback', () => {
    const chain = new FallbackChain({ primary: 'gpt-4o', fallbacks: ['claude', 'gemini'] });
    expect(chain.failover()).toBe('claude');
    expect(chain.isOnPrimary).toBe(false);
  });

  it('attemptRecovery returns to primary (P1-20)', () => {
    const chain = new FallbackChain({ primary: 'gpt-4o', fallbacks: ['claude'] });
    chain.failover();
    expect(chain.isOnPrimary).toBe(false);
    chain.attemptRecovery();
    expect(chain.isOnPrimary).toBe(true);
  });
});
