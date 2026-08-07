import { describe, it, expect } from 'vitest';
import { CapabilityRegistry, type ModelBinding } from '../../gateway/capability-registry.js';
import { KeyVault } from '../../gateway/key-vault.js';

describe('CapabilityRegistry', () => {
  it('registers default models on construction', () => {
    const cr = new CapabilityRegistry();
    const all = cr.listAll();
    expect(all.length).toBeGreaterThan(5);
  });

  it('findModels by tier returns matching models', () => {
    const cr = new CapabilityRegistry();
    const workModels = cr.findModels({ tier: 'work' });
    expect(workModels.length).toBeGreaterThan(0);
    expect(workModels.every(m => m.tier === 'work')).toBe(true);
  });

  it('findModels by route tier', () => {
    const cr = new CapabilityRegistry();
    const routeModels = cr.findModels({ tier: 'route' });
    expect(routeModels.length).toBeGreaterThan(0);
  });

  it('findModels by verify tier', () => {
    const cr = new CapabilityRegistry();
    const verifyModels = cr.findModels({ tier: 'verify' });
    expect(verifyModels.length).toBeGreaterThan(0);
  });

  it('findModels filters by required capabilities', () => {
    const cr = new CapabilityRegistry();
    const models = cr.findModels({ tier: 'work', requiredCapabilities: ['code', 'reasoning'] });
    expect(models.every(m => (m.capabilities.code ?? 0) > 0.5 && (m.capabilities.reasoning ?? 0) > 0.5)).toBe(true);
  });

  it('findModels filters by min context', () => {
    const cr = new CapabilityRegistry();
    const models = cr.findModels({ tier: 'work', minContext: 100_000 });
    expect(models.every(m => m.max_context >= 100_000)).toBe(true);
  });

  it('findModels filters by max price', () => {
    const cr = new CapabilityRegistry();
    const models = cr.findModels({ tier: 'work', maxPricePerMillion: 1.0 });
    expect(models.every(m => (m.price_input + m.price_output) / 2 <= 1.0)).toBe(true);
  });

  it('findModels filters by vision requirement', () => {
    const cr = new CapabilityRegistry();
    const models = cr.findModels({ tier: 'work', requireVision: true });
    expect(models.every(m => m.supports_vision)).toBe(true);
  });

  it('findModels filters by tools requirement', () => {
    const cr = new CapabilityRegistry();
    const models = cr.findModels({ tier: 'work', requireTools: true });
    expect(models.every(m => m.supports_tools)).toBe(true);
  });

  it('findModels sorts by capability score descending', () => {
    const cr = new CapabilityRegistry();
    const models = cr.findModels({ tier: 'work', requiredCapabilities: ['reasoning'] });
    for (let i = 1; i < models.length; i++) {
      const prevAvg = Object.values(models[i - 1]!.capabilities).reduce((s, v) => s + v, 0);
      const currAvg = Object.values(models[i]!.capabilities).reduce((s, v) => s + v, 0);
      expect(prevAvg).toBeGreaterThanOrEqual(currAvg);
    }
  });

  it('estimateCost calculates input + output cost', () => {
    const cr = new CapabilityRegistry();
    const model = cr.findModels({ tier: 'work' })[0]!;
    const cost = cr.estimateCost(model, 1_000_000, 500_000);
    expect(cost).toBeCloseTo(model.price_input + model.price_output * 0.5, 2);
  });

  it('register adds a custom model', () => {
    const cr = new CapabilityRegistry();
    const before = cr.listAll().length;
    cr.register({
      model_id: 'custom-model', provider: 'custom', tier: 'work',
      capabilities: { code: 0.9, reasoning: 0.9, tool_calling: 0.9, structured_output: 0.9, long_context: 0.9, chinese: 0.9 },
      price_input: 1, price_output: 2, max_context: 32768, avg_latency_ms: 500,
      api_base: 'http://custom', api_format: 'openai_chat',
      supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
    });
    expect(cr.listAll().length).toBe(before + 1);
    const found = cr.findModels({ tier: 'work' });
    expect(found.some(m => m.model_id === 'custom-model')).toBe(true);
  });

  it('filterByKeyAvailability returns only providers with keys', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const cr = new CapabilityRegistry();
    const kv = new KeyVault();
    const filtered = cr.filterByKeyAvailability(kv);
    expect(filtered.some(m => m.provider === 'openai')).toBe(true);
    expect(filtered.some(m => m.provider === 'ollama')).toBe(true);
    delete process.env.OPENAI_API_KEY;
  });

  it('includes seedance models in default registry', () => {
    const cr = new CapabilityRegistry();
    const all = cr.listAll();
    expect(all.some(m => m.provider === 'seedance')).toBe(true);
  });

  it('includes vllm models in default registry', () => {
    const cr = new CapabilityRegistry();
    const all = cr.listAll();
    expect(all.some(m => m.provider === 'vllm')).toBe(true);
  });

  it('includes doubao models in default registry', () => {
    const cr = new CapabilityRegistry();
    const all = cr.listAll();
    expect(all.some(m => m.provider === 'doubao')).toBe(true);
  });

  it('glm-5.2 is registered in both work and route tiers', () => {
    const cr = new CapabilityRegistry();
    const work = cr.findModels({ tier: 'work' });
    const route = cr.findModels({ tier: 'route' });
    expect(work.some(m => m.model_id === 'glm-5.2')).toBe(true);
    expect(route.some(m => m.model_id === 'glm-5.2')).toBe(true);
  });
});
