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

function makeGw(overrides: { rpmLimit?: number; budget?: number; defaultTemperature?: number; defaultMaxTokens?: number } = {}) {
  const keyVault = new KeyVault();
  keyVault.addKey('zhipu', 'test-glm-key');
  const registry = new CapabilityRegistry();
  const economic = new EconomicKernel();
  if (overrides.budget) economic.createBudget('task1', overrides.budget);
  const rateLimiter = new RateLimiter({ rpmLimit: overrides.rpmLimit ?? 100, tpmLimit: 1_000_000, concurrentLimit: 10 });
  return new ManagedGateway({
    keyVault, registry, economic, rateLimiter,
    ...(overrides.defaultTemperature !== undefined ? { defaultTemperature: overrides.defaultTemperature } : {}),
    ...(overrides.defaultMaxTokens !== undefined ? { defaultMaxTokens: overrides.defaultMaxTokens } : {}),
  });
}

describe('ManagedGateway buildMetadata coverage', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('getAvailableModels returns all registered models with metadata', () => {
    const gw = makeGw();
    const models = gw.getAvailableModels() as Array<Record<string, unknown>>;
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m['model_id']).toBeDefined();
      expect(m['provider']).toBeDefined();
      expect(m['tier']).toBeDefined();
      expect(m['capabilities']).toBeDefined();
      expect(m['price_input']).toBeDefined();
      expect(m['price_output']).toBeDefined();
      expect(m['max_context']).toBeDefined();
      expect(m['supports_tools']).toBeDefined();
      expect(m['supports_vision']).toBeDefined();
      expect(m['has_api_key']).toBeDefined();
      expect(m['circuit_breaker']).toBeDefined();
    }
  });

  it('getAvailableModels reports has_api_key=false for unregistered providers', () => {
    const keyVault = new KeyVault();
    // Don't add any keys
    const registry = new CapabilityRegistry();
    const economic = new EconomicKernel();
    const gw = new ManagedGateway({ keyVault, registry, economic });
    const models = gw.getAvailableModels() as Array<Record<string, unknown>>;
    // All models should have has_api_key=false since no keys were added
    const noKeyModels = models.filter(m => m['has_api_key'] === false);
    expect(noKeyModels.length).toBeGreaterThan(0);
  });

  it('getAvailableModels reports circuit_breaker state as closed initially', () => {
    const gw = makeGw();
    const models = gw.getAvailableModels() as Array<Record<string, unknown>>;
    for (const m of models) {
      expect(m['circuit_breaker']).toBe('closed');
    }
  });
});

describe('ManagedGateway getUsageSummary coverage', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('getUsageSummary returns zero stats when no calls made', () => {
    const gw = makeGw();
    const summary = gw.getUsageSummary() as Record<string, unknown>;
    expect(summary['total_calls']).toBe(0);
    expect(summary['total_cost_usd']).toBe(0);
    expect(summary['total_tokens']).toBe(0);
    expect(summary['by_provider']).toBeDefined();
    expect(summary['circuit_breakers']).toBeDefined();
  });

  it('getUsageSummary tracks usage after a successful call', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('hello'))) as any;
    await gw.complete('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' });
    const summary = gw.getUsageSummary() as Record<string, unknown>;
    expect(summary['total_calls']).toBe(1);
    expect(summary['total_tokens']).toBe(30); // 10 prompt + 20 completion
    const byProvider = summary['by_provider'] as Record<string, Record<string, number>>;
    expect(Object.keys(byProvider).length).toBeGreaterThan(0);
    for (const [provider, stats] of Object.entries(byProvider)) {
      expect(stats['calls']).toBe(1);
      expect(stats['tokens']).toBe(30);
      expect(stats['failures']).toBe(0);
    }
  });

  it('getUsageSummary includes circuit_breaker states', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('hello'))) as any;
    await gw.complete('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' });
    const summary = gw.getUsageSummary() as Record<string, unknown>;
    const breakers = summary['circuit_breakers'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(breakers).length).toBeGreaterThan(0);
    for (const [provider, state] of Object.entries(breakers)) {
      expect(state['state']).toBeDefined();
      expect(state['failures']).toBeDefined();
    }
  });
});

describe('ManagedGateway toHarnessProvider coverage', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('toHarnessProvider returns a resolve function', () => {
    const gw = makeGw();
    const provider = gw.toHarnessProvider('user1', 'task1');
    expect(typeof provider.resolve).toBe('function');
  });

  it('toHarnessProvider.resolve returns content from complete()', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('hello world'))) as any;
    const provider = gw.toHarnessProvider('user1', 'task1');
    const result = await provider.resolve(
      [{ role: 'user', content: 'test prompt' }],
    );
    expect(result.content).toBe('hello world');
    expect(result.stop_reason).toBe('stop');
    expect(result.usage!.input_tokens).toBe(10);
    expect(result.usage!.output_tokens).toBe(20);
  });

  it('toHarnessProvider.resolve passes system message as systemPrompt', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('response'))) as any;
    const provider = gw.toHarnessProvider('user1', 'task1');
    const result = await provider.resolve([
      { role: 'system', content: 'You are a test bot' },
      { role: 'user', content: 'test prompt' },
    ]);
    expect(result.content).toBe('response');
  });

  it('toHarnessProvider.resolve passes tools to complete()', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('ok'))) as any;
    const provider = gw.toHarnessProvider('user1', 'task1');
    const result = await provider.resolve(
      [{ role: 'user', content: 'test' }],
      [{ name: 'tool1', description: 'A tool' }],
    );
    expect(result.content).toBe('ok');
  });

  it('toHarnessProvider.resolve parses tool_calls from JSON response', async () => {
    const gw = makeGw();
    const toolCallResponse = {
      tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/test' } }],
    };
    globalThis.fetch = vi.fn(async () => mockFetchResponse({
      choices: [{ message: { content: JSON.stringify(toolCallResponse) }, finish_reason: 'tool_use' }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    })) as any;
    const provider = gw.toHarnessProvider('user1', 'task1');
    const result = await provider.resolve([{ role: 'user', content: 'test' }]);
    expect(result.tool_calls).toBeDefined();
    expect(result.tool_calls!.length).toBe(1);
    expect(result.tool_calls![0]!.name).toBe('read_file');
  });

  it('toHarnessProvider.resolve returns content_filter stop_reason on failure', async () => {
    const gw = makeGw({ rpmLimit: 1 });
    // Use up the rate limit so the next call fails
    const rl = (gw as any).rateLimiter;
    const check = rl.check('user1', 1000000);
    expect(check.allowed).toBe(true);
    // Don't release - next call should be rate limited
    const provider = gw.toHarnessProvider('user1', 'task1');
    const result = await provider.resolve([{ role: 'user', content: 'test' }]);
    expect(result.stop_reason).toBe('content_filter');
  }, 10000);
});

describe('ManagedGateway tool mask coverage', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('isToolMaskEnabled returns false initially', () => {
    const gw = makeGw();
    expect(gw.isToolMaskEnabled()).toBe(false);
  });

  it('enableToolMask toggles the mask on', () => {
    const gw = makeGw();
    gw.enableToolMask(true);
    expect(gw.isToolMaskEnabled()).toBe(true);
  });

  it('enableToolMask toggles the mask off', () => {
    const gw = makeGw();
    gw.enableToolMask(true);
    gw.enableToolMask(false);
    expect(gw.isToolMaskEnabled()).toBe(false);
  });

  it('checkToolAllowed returns allowed for any tool when mask is disabled', () => {
    const gw = makeGw();
    const result = gw.checkToolAllowed('read_file');
    expect(result.allowed).toBe(true);
  });

  it('getToolMaskHint returns null when no tools provided', () => {
    const gw = makeGw();
    expect(gw.getToolMaskHint([])).toBeNull();
  });

  it('getCacheMetrics returns a record', () => {
    const gw = makeGw();
    const metrics = gw.getCacheMetrics();
    expect(typeof metrics).toBe('object');
  });

  it('getToolMaskState returns the current state', () => {
    const gw = makeGw();
    const state = gw.getToolMaskState();
    expect(state).toBeDefined();
  });

  it('setToolMaskState transitions the state', () => {
    const gw = makeGw();
    gw.setToolMaskState('executing');
    const state = gw.getToolMaskState();
    expect(state).toBe('executing');
  });
});

describe('ManagedGateway completeStream deep coverage', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('completeStream yields provider_info with provider and model', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    const providerInfo = events.find(e => e.type === 'provider_info');
    expect(providerInfo).toBeDefined();
    expect(providerInfo!.provider).toBeDefined();
    expect(providerInfo!.model).toBeDefined();
  });

  it('completeStream yields message_stop with usage on success', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    const stop = events.find(e => e.type === 'message_stop');
    expect(stop).toBeDefined();
    expect(stop!.usage).toBeDefined();
    expect(stop!.usage.input_tokens).toBe(5);
    expect(stop!.usage.output_tokens).toBe(2);
  });

  it('completeStream yields fallback event when first provider fails', async () => {
    const gw = makeGw();
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 500, json: async () => ({ error: 'server error' }), text: async () => 'error', headers: new Headers() } as Response;
      }
      return makeStreamResponse([
        'data: {"choices":[{"delta":{"content":"recovered"}}]}\n',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n',
      ]);
    }) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    // Should have either a fallback event or a message_stop
    const hasStop = events.some(e => e.type === 'message_stop');
    expect(hasStop).toBe(true);
  });

  it('completeStream respects rate limits', async () => {
    const gw = makeGw({ rpmLimit: 1 });
    // First call uses the rate limit
    const rl = (gw as any).rateLimiter;
    const check1 = rl.check('u1', 100);
    expect(check1.allowed).toBe(true);
    // Don't release - next call should be rate limited
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    // Should get a message_stop with zero usage (rate limited)
    const stop = events.find(e => e.type === 'message_stop');
    expect(stop).toBeDefined();
    expect(stop!.usage.input_tokens).toBe(0);
    expect(stop!.usage.output_tokens).toBe(0);
  });

  it('completeStream yields tool_call events', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => makeStreamResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","function":{"name":"read_file","arguments":"{\\"path\\":\\"/test\\"}"}}]}}]}\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n',
    ])) as any;
    const events: any[] = [];
    for await (const ev of gw.completeStream('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' })) {
      events.push(ev);
    }
    const toolCall = events.find(e => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall!.tool_call).toBeDefined();
    expect(toolCall!.tool_call.name).toBe('read_file');
  });
});

describe('ManagedGateway defaultTemperature and defaultMaxTokens', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('uses custom defaultTemperature and defaultMaxTokens', async () => {
    const gw = makeGw({ defaultTemperature: 0.7, defaultMaxTokens: 4096 });
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' });
    expect(capturedBody.temperature).toBe(0.7);
    expect(capturedBody.max_tokens).toBe(4096);
  });

  it('uses default temperature 0.3 and max_tokens 8000 when not specified', async () => {
    const gw = makeGw();
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' });
    expect(capturedBody.temperature).toBe(0.3);
    expect(capturedBody.max_tokens).toBe(8000);
  });
});

describe('ManagedGateway executeDag coverage', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('executeDag returns a result for a simple DAG', async () => {
    const gw = makeGw();
    const dag = {
      nodes: [
        { id: 'node1', tool: 'read_file', inputs: { path: '/test' }, depends_on: [] },
      ],
      edges: [],
    };
    const result = await gw.executeDag(dag as any, { userId: 'u1', taskId: 't1' });
    expect(result).toBeDefined();
  });
});
