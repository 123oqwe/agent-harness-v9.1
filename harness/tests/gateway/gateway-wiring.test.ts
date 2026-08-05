import { describe, it, expect } from 'vitest';
import { ModelGateway } from '../../gateway/model-gateway.js';
import { ScriptedTestProvider } from '../../gateway/scripted-provider.js';
import { RateLimiter, LLMCache, UsageMeter, CapabilityRegistry } from '../../gateway/capability-registry.js';

describe('P1-18: RateLimiter wired into ModelGateway', () => {
  it('rejects requests when rate limit exceeded', async () => {
    const rl = new RateLimiter({ rpm_limit: 1, tpm_limit: 100000, concurrent_limit: 5 });
    const provider = new ScriptedTestProvider({
      queue: [
        { content: 'a', stop_reason: 'stop' },
        { content: 'b', stop_reason: 'stop' },
      ],
    });
    const gw = new ModelGateway([provider], { rateLimiter: rl, userId: 'user1' });

    // First request should succeed
    const r1 = await gw.complete('scripted_test', { messages: [{ role: 'user', content: 'x' }] });
    expect(r1.response.content).toBe('a');

   // Second request should be rate limited
    await expect(gw.complete('scripted_test', { messages: [{ role: 'user', content: 'y' }] }))
      .rejects.toThrow(/Rate limit/);
  });
});

describe('P2-12: LLMCache wired into ModelGateway', () => {
  it('returns cached response without calling provider', async () => {
    const cache = new LLMCache();
    const provider = new ScriptedTestProvider({
      queue: [{ content: 'first', stop_reason: 'stop' }],
    });
    const gw = new ModelGateway([provider], { cache });

    // First call hits provider
    const r1 = await gw.complete('scripted_test', {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'test-model',
    });
    expect(r1.response.content).toBe('first');
    expect(provider.callCount).toBe(1);

    // Second call with same input should hit cache (not provider)
    const r2 = await gw.complete('scripted_test', {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'test-model',
    });
    expect(r2.response.content).toBe('first');
    expect(provider.callCount).toBe(1); // no new provider call
  });
});

describe('P1-17: UsageMeter wired into ModelGateway', () => {
  it('records usage on each model call', async () => {
    const reg = new CapabilityRegistry();
    reg.register({
      model_id: 'scripted-test', provider_type: 'scripted_test',
      capabilities: [], price_input_per_1m: 1, price_output_per_1m: 2,
      max_context: 128000, max_output: 4096, latency_ms: 0,
    });
    const meter = new UsageMeter(reg);
    const provider = new ScriptedTestProvider({
      queue: [{
        content: 'response', stop_reason: 'stop',
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'scripted-test',
      }],
    });
    const gw = new ModelGateway([provider], { usageMeter: meter });

    await gw.complete('scripted_test', { messages: [{ role: 'user', content: 'x' }] });

    expect(meter.getEntries().length).toBe(1);
 expect(meter.getTotalCost()).toBeGreaterThan(0);
  });
});
