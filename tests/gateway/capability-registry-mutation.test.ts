import { describe, it, expect } from 'vitest';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';

function getModel(cr: CapabilityRegistry, provider: string, modelId: string, tier: string) {
  return cr.listAll().find(b => b.provider === provider && b.model_id === modelId && b.tier === tier)!;
}

describe('capability-registry: model binding property assertions', () => {
  const cr = new CapabilityRegistry();

  it('glm-5.2 work binding has exact properties', () => {
    const b = getModel(cr, 'zhipu', 'glm-5.2', 'work');
    expect(b.model_id).toBe('glm-5.2');
    expect(b.provider).toBe('zhipu');
    expect(b.tier).toBe('work');
    expect(b.api_base).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(b.api_format).toBe('openai_chat');
    expect(b.price_input).toBe(0.5);
    expect(b.price_output).toBe(1.5);
    expect(b.max_context).toBe(131072);
    expect(b.avg_latency_ms).toBe(800);
    expect(b.supports_tools).toBe(true);
    expect(b.supports_streaming).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });

  it('glm-5.2 route binding has exact properties', () => {
    const b = getModel(cr, 'zhipu', 'glm-5.2', 'route');
    expect(b.tier).toBe('route');
    expect(b.api_format).toBe('openai_chat');
    expect(b.supports_tools).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });

  it('glm-5.2 work binding has exact capability scores', () => {
    const b = getModel(cr, 'zhipu', 'glm-5.2', 'work');
    expect(b.capabilities.code).toBe(0.95);
    expect(b.capabilities.reasoning).toBe(0.96);
    expect(b.capabilities.tool_calling).toBe(0.93);
    expect(b.capabilities.structured_output).toBe(0.92);
    expect(b.capabilities.long_context).toBe(0.90);
    expect(b.capabilities.chinese).toBe(0.98);
  });

  it('glm-4-plus work binding has exact properties', () => {
    const b = getModel(cr, 'zhipu', 'glm-4-plus', 'work');
    expect(b.model_id).toBe('glm-4-plus');
    expect(b.provider).toBe('zhipu');
    expect(b.tier).toBe('work');
    expect(b.api_base).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(b.api_format).toBe('openai_chat');
    expect(b.price_input).toBe(0.5);
    expect(b.price_output).toBe(1.5);
    expect(b.supports_tools).toBe(true);
    expect(b.supports_streaming).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });

  it('glm-4-plus work binding has exact capability scores', () => {
    const b = getModel(cr, 'zhipu', 'glm-4-plus', 'work');
    expect(b.capabilities.code).toBe(0.82);
    expect(b.capabilities.reasoning).toBe(0.80);
    expect(b.capabilities.tool_calling).toBe(0.78);
    expect(b.capabilities.structured_output).toBe(0.80);
    expect(b.capabilities.long_context).toBe(0.85);
    expect(b.capabilities.chinese).toBe(0.95);
  });

  it('gpt-4o work binding has exact properties', () => {
    const b = getModel(cr, 'openai', 'gpt-4o', 'work');
    expect(b.model_id).toBe('gpt-4o');
    expect(b.provider).toBe('openai');
    expect(b.tier).toBe('work');
    expect(b.api_base).toBe('https://api.openai.com/v1');
    expect(b.api_format).toBe('openai_chat');
    expect(b.price_input).toBe(2.5);
    expect(b.price_output).toBe(10.0);
    expect(b.max_context).toBe(131072);
    expect(b.avg_latency_ms).toBe(1200);
    expect(b.supports_tools).toBe(true);
    expect(b.supports_streaming).toBe(true);
    expect(b.supports_vision).toBe(true);
    expect(b.enabled).toBe(true);
  });

  it('gpt-4o work binding has exact capability scores', () => {
    const b = getModel(cr, 'openai', 'gpt-4o', 'work');
    expect(b.capabilities.code).toBe(0.95);
    expect(b.capabilities.reasoning).toBe(0.94);
    expect(b.capabilities.tool_calling).toBe(0.95);
    expect(b.capabilities.structured_output).toBe(0.95);
    expect(b.capabilities.long_context).toBe(0.90);
    expect(b.capabilities.chinese).toBe(0.85);
  });

  it('gpt-4o-mini route binding has exact properties', () => {
    const b = getModel(cr, 'openai', 'gpt-4o-mini', 'route');
    expect(b.model_id).toBe('gpt-4o-mini');
    expect(b.provider).toBe('openai');
    expect(b.tier).toBe('route');
    expect(b.api_base).toBe('https://api.openai.com/v1');
    expect(b.api_format).toBe('openai_chat');
    expect(b.price_input).toBe(0.15);
    expect(b.price_output).toBe(0.60);
    expect(b.max_context).toBe(131072);
    expect(b.avg_latency_ms).toBe(400);
    expect(b.supports_tools).toBe(true);
    expect(b.supports_streaming).toBe(true);
    expect(b.supports_vision).toBe(true);
    expect(b.enabled).toBe(true);
  });

  it('gpt-4o-mini route binding has exact capability scores', () => {
    const b = getModel(cr, 'openai', 'gpt-4o-mini', 'route');
    expect(b.capabilities.code).toBe(0.80);
    expect(b.capabilities.reasoning).toBe(0.78);
    expect(b.capabilities.tool_calling).toBe(0.82);
    expect(b.capabilities.structured_output).toBe(0.82);
    expect(b.capabilities.long_context).toBe(0.80);
    expect(b.capabilities.chinese).toBe(0.75);
  });

  it('claude-sonnet-4-5 work binding has exact properties', () => {
    const b = getModel(cr, 'anthropic', 'claude-sonnet-4-5', 'work');
    expect(b.model_id).toBe('claude-sonnet-4-5');
    expect(b.provider).toBe('anthropic');
    expect(b.tier).toBe('work');
    expect(b.api_base).toBe('https://api.anthropic.com/v1');
    expect(b.api_format).toBe('anthropic');
    expect(b.price_input).toBe(3.0);
    expect(b.price_output).toBe(15.0);
    expect(b.max_context).toBe(200000);
    expect(b.avg_latency_ms).toBe(1000);
    expect(b.supports_tools).toBe(true);
    expect(b.supports_streaming).toBe(true);
    expect(b.supports_vision).toBe(true);
    expect(b.enabled).toBe(true);
  });

  it('claude-sonnet-4-5 verify binding has exact properties', () => {
    const b = getModel(cr, 'anthropic', 'claude-sonnet-4-5', 'verify');
    expect(b.tier).toBe('verify');
    expect(b.api_format).toBe('anthropic');
    expect(b.supports_tools).toBe(true);
    expect(b.supports_vision).toBe(true);
    expect(b.enabled).toBe(true);
  });

  it('claude-sonnet-4-5 work binding has exact capability scores', () => {
    const b = getModel(cr, 'anthropic', 'claude-sonnet-4-5', 'work');
    expect(b.capabilities.code).toBe(0.93);
    expect(b.capabilities.reasoning).toBe(0.95);
    expect(b.capabilities.tool_calling).toBe(0.92);
    expect(b.capabilities.structured_output).toBe(0.93);
    expect(b.capabilities.long_context).toBe(0.95);
    expect(b.capabilities.chinese).toBe(0.88);
  });

  it('deepseek-chat work binding has exact properties', () => {
    const b = getModel(cr, 'deepseek', 'deepseek-chat', 'work');
    expect(b.model_id).toBe('deepseek-chat');
    expect(b.provider).toBe('deepseek');
    expect(b.api_base).toBe('https://api.deepseek.com/v1');
    expect(b.api_format).toBe('openai_chat');
    expect(b.supports_tools).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });

  it('qwen-max work binding has exact properties', () => {
    const b = getModel(cr, 'qwen', 'qwen-max', 'work');
    expect(b.model_id).toBe('qwen-max');
    expect(b.provider).toBe('qwen');
    expect(b.api_base).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(b.api_format).toBe('openai_chat');
    expect(b.supports_tools).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });

  it('ollama binding has exact properties', () => {
    const b = getModel(cr, 'ollama', 'qwen2.5', 'work');
    expect(b.model_id).toBe('qwen2.5');
    expect(b.provider).toBe('ollama');
    expect(b.api_base).toBe('http://localhost:11434/v1');
    expect(b.api_format).toBe('openai_chat');
    expect(b.price_input).toBe(0);
    expect(b.price_output).toBe(0);
    expect(b.supports_tools).toBe(true);
    expect(b.supports_streaming).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });

  it('vllm binding has exact properties', () => {
    const b = getModel(cr, 'vllm', 'vllm-default', 'work');
    expect(b.model_id).toBe('vllm-default');
    expect(b.provider).toBe('vllm');
    expect(b.api_base).toBe('http://localhost:8000/v1');
    expect(b.api_format).toBe('openai_chat');
    expect(b.price_input).toBe(0);
    expect(b.price_output).toBe(0);
    expect(b.supports_tools).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });

  it('seedance binding has exact properties', () => {
    const b = getModel(cr, 'seedance', 'seedance-1-0-pro', 'work');
    expect(b.model_id).toBe('seedance-1-0-pro');
    expect(b.provider).toBe('seedance');
    expect(b.api_format).toBe('async_task');
    expect(b.supports_tools).toBe(false);
    expect(b.supports_streaming).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });

  it('doubao binding has exact properties', () => {
    const b = getModel(cr, 'doubao', 'doubao-pro-32k', 'work');
    expect(b.model_id).toBe('doubao-pro-32k');
    expect(b.provider).toBe('doubao');
    expect(b.api_base).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(b.api_format).toBe('openai_chat');
    expect(b.supports_tools).toBe(true);
    expect(b.supports_vision).toBe(false);
    expect(b.enabled).toBe(true);
  });
});

describe('capability-registry: findModels edge cases', () => {
  it('excludes disabled models', () => {
    const cr = new CapabilityRegistry();
    cr.register({
      model_id: 'disabled-model', provider: 'test', tier: 'work',
      capabilities: { code: 0.9 }, price_input: 1, price_output: 2,
      max_context: 32768, avg_latency_ms: 500,
      api_base: 'http://test', api_format: 'openai_chat',
      supports_tools: true, supports_streaming: true, supports_vision: false, enabled: false,
    });
    const found = cr.findModels({ tier: 'work' });
    expect(found.every(m => m.model_id !== 'disabled-model')).toBe(true);
  });

  it('requiredCapabilities uses 0.5 threshold', () => {
    const cr = new CapabilityRegistry();
    cr.register({
      model_id: 'low-cap', provider: 'test', tier: 'work',
      capabilities: { code: 0.4, reasoning: 0.6 }, price_input: 1, price_output: 2,
      max_context: 32768, avg_latency_ms: 500,
      api_base: 'http://test', api_format: 'openai_chat',
      supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
    });
    const found = cr.findModels({ tier: 'work', requiredCapabilities: ['code'] });
    expect(found.every(m => m.model_id !== 'low-cap')).toBe(true);
    const found2 = cr.findModels({ tier: 'work', requiredCapabilities: ['reasoning'] });
    expect(found2.some(m => m.model_id === 'low-cap')).toBe(true);
  });

  it('requiredCapabilities with unknown capability defaults to 0', () => {
    const cr = new CapabilityRegistry();
    const found = cr.findModels({ tier: 'work', requiredCapabilities: ['nonexistent_cap'] });
    expect(found).toHaveLength(0);
  });

  it('maxPricePerMillion uses average of input and output', () => {
    const cr = new CapabilityRegistry();
    cr.register({
      model_id: 'cheap-model', provider: 'test', tier: 'work',
      capabilities: { code: 0.9 }, price_input: 0.1, price_output: 0.3,
      max_context: 32768, avg_latency_ms: 500,
      api_base: 'http://test', api_format: 'openai_chat',
      supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
    });
    const found = cr.findModels({ tier: 'work', maxPricePerMillion: 0.25 });
    expect(found.some(m => m.model_id === 'cheap-model')).toBe(true);
    const notFound = cr.findModels({ tier: 'work', maxPricePerMillion: 0.15 });
    expect(notFound.every(m => m.model_id !== 'cheap-model')).toBe(true);
  });

  it('estimateCost with zero tokens returns zero', () => {
    const cr = new CapabilityRegistry();
    const model = cr.listAll()[0]!;
    expect(cr.estimateCost(model, 0, 0)).toBe(0);
  });

  it('register overwrites existing binding with same key', () => {
    const cr = new CapabilityRegistry();
    const before = cr.listAll().length;
    cr.register({
      model_id: 'glm-5.2', provider: 'zhipu', tier: 'work',
      capabilities: { code: 0.99 }, price_input: 999, price_output: 999,
      max_context: 999, avg_latency_ms: 999,
      api_base: 'http://overwritten', api_format: 'openai_chat',
      supports_tools: false, supports_streaming: false, supports_vision: true, enabled: true,
    });
    expect(cr.listAll().length).toBe(before);
    const b = getModel(cr, 'zhipu', 'glm-5.2', 'work');
    expect(b.price_input).toBe(999);
    expect(b.supports_tools).toBe(false);
    expect(b.supports_vision).toBe(true);
  });

  it('listAll returns only enabled models', () => {
    const cr = new CapabilityRegistry();
    const all = cr.listAll();
    expect(all.every(b => b.enabled)).toBe(true);
  });

  it('findModels sorts by capability avg descending then by price ascending', () => {
    const cr = new CapabilityRegistry();
    cr.register({
      model_id: 'same-cap-a', provider: 'test', tier: 'work',
      capabilities: { code: 0.9 }, price_input: 1, price_output: 1,
      max_context: 32768, avg_latency_ms: 500,
      api_base: 'http://a', api_format: 'openai_chat',
      supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
    });
    cr.register({
      model_id: 'same-cap-b', provider: 'test', tier: 'work',
      capabilities: { code: 0.9 }, price_input: 0.5, price_output: 0.5,
      max_context: 32768, avg_latency_ms: 500,
      api_base: 'http://b', api_format: 'openai_chat',
      supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
    });
    const found = cr.findModels({ tier: 'work', requiredCapabilities: ['code'] });
    const aIdx = found.findIndex(m => m.model_id === 'same-cap-a');
    const bIdx = found.findIndex(m => m.model_id === 'same-cap-b');
    if (aIdx >= 0 && bIdx >= 0) {
      expect(bIdx).toBeLessThan(aIdx);
    }
  });
});
