import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ManagedGateway } from '../../gateway/managed-gateway.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import { RateLimiter } from '../../gateway/rate-limiter.js';
import { EconomicKernel } from '../../gateway/economic-kernel.js';

const originalFetch = globalThis.fetch;

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as Response;
}

function makeChatResponse(content: string): unknown {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
}

function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    json: async () => ({}), text: async () => '', headers: new Headers(),
  } as Response;
}

function makeGw(overrides: { rpmLimit?: number; budget?: number } = {}) {
  const keyVault = new KeyVault();
  keyVault.addKey('zhipu', 'test-glm-key');
  const registry = new CapabilityRegistry();
  const economic = new EconomicKernel();
  if (overrides.budget) economic.createBudget('task1', overrides.budget);
  const rateLimiter = new RateLimiter({ rpmLimit: overrides.rpmLimit ?? 100, tpmLimit: 1_000_000, concurrentLimit: 10 });
  return new ManagedGateway({ keyVault, registry, economic, rateLimiter });
}

describe('ManagedGateway.completeStream() deep tests', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('yields text_delta and message_stop events', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === 'text_delta' && e.text === 'hello')).toBe(true);
    expect(events.some(e => e.type === 'text_delta' && e.text === ' world')).toBe(true);
    expect(events.some(e => e.type === 'message_stop')).toBe(true);
  });

  it('yields provider_info event with provider and model', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"finish_reason":"stop"}]}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    const info = events.find(e => e.type === 'provider_info');
    expect(info).toBeDefined();
    expect(info.provider).toBe('zhipu');
    expect(info.model).toBeDefined();
  });

  it('yields message_stop with usage', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    const stop = events.find(e => e.type === 'message_stop');
    expect(stop.usage.input_tokens).toBe(10);
    expect(stop.usage.output_tokens).toBe(5);
  });

  it('yields message_stop with cost_usd when cost > 0', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1000000,"completion_tokens":500000}}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    const stop = events.find(e => e.type === 'message_stop');
    expect(stop.cost_usd).toBeDefined();
    expect(stop.cost_usd).toBeGreaterThan(0);
  });

  it('yields message_stop without cost_usd when cost is 0', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    const stop = events.find(e => e.type === 'message_stop');
    expect(stop.cost_usd).toBeUndefined();
  });

  it('stops when rate limited', async () => {
    const gw = makeGw({ rpmLimit: 1 });
    globalThis.fetch = vi.fn(async () => makeStreamResponse(['data: {"choices":[{"finish_reason":"stop"}]}\n'])) as any;
    await gw.completeStream('p1', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' }).next();
    const events: any[] = [];
    for await (const ev of gw.completeStream('p2', { userId: 'u1', taskId: 't2', stepId: 's2', tier: 'work' })) {
      events.push(ev);
    }
    const stop = events.find(e => e.type === 'message_stop');
    expect(stop).toBeDefined();
    expect(stop.usage.input_tokens).toBe(0);
    expect(stop.usage.output_tokens).toBe(0);
  });

  it('handles no compatible provider', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse(['data: {"choices":[{"finish_reason":"stop"}]}\n'])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work', requiredCapabilities: ['nonexistent_cap'] })) {
      events.push(ev);
    }
    const stop = events.find(e => e.type === 'message_stop');
    expect(stop).toBeDefined();
  });

  it('yields tool_call events from stream', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"tc1","function":{"name":"read","arguments":"{}"}}]}}]}\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === 'tool_call')).toBe(true);
  });
});

describe('ManagedGateway utility methods', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('getUsageSummary returns total_calls, total_cost_usd, total_tokens', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('hello'))) as any;
    await gw.complete('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' });
    const summary = gw.getUsageSummary() as Record<string, unknown>;
    expect(summary.total_calls).toBe(1);
    expect(summary.total_cost_usd).toBeDefined();
    expect(summary.total_tokens).toBeDefined();
    expect(summary.by_provider).toBeDefined();
  });

  it('getUsageSummary includes circuit_breakers', () => {
    const gw = makeGw();
    const summary = gw.getUsageSummary() as Record<string, unknown>;
    expect(summary.circuit_breakers).toBeDefined();
  });

  it('getUsageSummary by_provider has calls, cost, tokens, failures', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('hello'))) as any;
    await gw.complete('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' });
    const summary = gw.getUsageSummary() as Record<string, unknown>;
    const byProvider = summary.by_provider as Record<string, Record<string, unknown>>;
    expect(byProvider['zhipu']).toBeDefined();
    expect(byProvider['zhipu']!.calls).toBe(1);
    expect(byProvider['zhipu']!.cost).toBeDefined();
    expect(byProvider['zhipu']!.tokens).toBeDefined();
    expect(byProvider['zhipu']!.failures).toBe(0);
  });

  it('getAvailableModels returns model list with properties', () => {
    const gw = makeGw();
    const models = gw.getAvailableModels() as Record<string, unknown>[];
    expect(models.length).toBeGreaterThan(0);
    const model = models[0]!;
    expect(model.model_id).toBeDefined();
    expect(model.provider).toBeDefined();
    expect(model.tier).toBeDefined();
    expect(model.capabilities).toBeDefined();
    expect(model.has_api_key).toBeDefined();
    expect(model.circuit_breaker).toBeDefined();
  });

  it('getAvailableModels includes has_api_key for each model', () => {
    const gw = makeGw();
    const models = gw.getAvailableModels() as Record<string, unknown>[];
    const zhipuModel = models.find(m => m.provider === 'zhipu');
    expect(zhipuModel!.has_api_key).toBe(true);
    const openaiModel = models.find(m => m.provider === 'openai');
    expect(openaiModel!.has_api_key).toBe(false);
  });

  it('getCacheMetrics returns metrics object', () => {
    const gw = makeGw();
    const metrics = gw.getCacheMetrics();
    expect(metrics).toBeDefined();
    expect(metrics.total_calls).toBeDefined();
  });

  it('getToolMaskState returns current state', () => {
    const gw = makeGw();
    expect(gw.getToolMaskState()).toBeDefined();
  });

  it('isToolMaskEnabled returns boolean', () => {
    const gw = makeGw();
    expect(typeof gw.isToolMaskEnabled()).toBe('boolean');
  });

  it('checkToolAllowed returns allowed result', () => {
    const gw = makeGw();
    const result = gw.checkToolAllowed('read_file');
    expect(result).toBeDefined();
    expect(typeof result.allowed).toBe('boolean');
  });

  it('toHarnessProvider returns resolve function', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('hello'))) as any;
    const provider = gw.toHarnessProvider('user1', 'task1');
    expect(typeof provider.resolve).toBe('function');
    const result = await provider.resolve(
      [{ role: 'user', content: 'hello' }],
      [{ name: 'read_file', description: 'Read a file' }],
    );
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });

  it('toHarnessProvider parses tool_calls from response', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse({
      choices: [{ message: { content: '{"tool_calls":[{"id":"tc1","name":"read","arguments":{}}]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    })) as any;
    const provider = gw.toHarnessProvider('user1', 'task1');
    const result = await provider.resolve([{ role: 'user', content: 'do something' }]);
    expect(result.tool_calls).toBeDefined();
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0]!.name).toBe('read');
  });

  it('toHarnessProvider handles non-JSON response without tool_calls', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('plain text response'))) as any;
    const provider = gw.toHarnessProvider('user1', 'task1');
    const result = await provider.resolve([{ role: 'user', content: 'hello' }]);
    expect(result.tool_calls!).toBeUndefined();
    expect(result.stop_reason).toBe('stop');
  });

  it('toHarnessProvider uses system message as systemPrompt', async () => {
    const gw = makeGw();
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    const provider = gw.toHarnessProvider('user1', 'task1');
    await provider.resolve([
      { role: 'system', content: 'You are a helper' },
      { role: 'user', content: 'hello' },
    ]);
    const messages = capturedBody!.messages as Record<string, string>[];
    expect(messages[0]!.role).toBe('system');
  });
});
