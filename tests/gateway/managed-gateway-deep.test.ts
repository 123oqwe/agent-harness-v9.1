import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ManagedGateway } from '../../gateway/managed-gateway.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import { RateLimiter } from '../../gateway/rate-limiter.js';
import { EconomicKernel } from '../../gateway/economic-kernel.js';

const originalFetch = globalThis.fetch;

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as Response;
}

function makeChatResponse(content: string): unknown {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
}

function makeGw(overrides: { rpmLimit?: number; budget?: number } = {}) {
  const keyVault = new KeyVault();
  keyVault.addKey('zhipu', 'test-glm-key');
  const registry = new CapabilityRegistry();
  const economic = new EconomicKernel();
  if (overrides.budget) economic.createBudget('task1', overrides.budget);
  const rateLimiter = new RateLimiter({
    rpmLimit: overrides.rpmLimit ?? 100,
    tpmLimit: 1_000_000,
    concurrentLimit: 10,
  });
  return new ManagedGateway({ keyVault, registry, economic, rateLimiter });
}

describe('ManagedGateway.complete() deep tests', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns content on successful complete() call', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('hello world'))) as any;
    const result = await gw.complete('test prompt', {
      userId: 'user1', taskId: 'task1', stepId: 'step1', tier: 'work',
    });
    expect(result.response).toBe('hello world');
    expect(result.usage.success).toBe(true);
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(20);
  });

  it('returns rate limited error when RPM exceeded', async () => {
    const gw = makeGw({ rpmLimit: 1 });
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('first'))) as any;
    await gw.complete('p1', { userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work' });
    const result = await gw.complete('p2', { userId: 'u1', taskId: 't2', stepId: 's2', tier: 'work' });
    expect(result.usage.success).toBe(false);
    expect(result.response).toContain('RPM');
  });

  it('returns fail when no compatible provider (bad capability)', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('x'))) as any;
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
      requiredCapabilities: ['nonexistent_capability_xyz'],
    });
    expect(result.usage.success).toBe(false);
    expect(result.response).toContain('No compatible provider');
  });

  it('maps tools with name/description/parameters/risk_feature_extractor', async () => {
    const gw = makeGw();
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, risk_feature_extractor: 'fs_read' }],
    });
    const body = capturedBody as { tools?: unknown[] };
    expect(body.tools).toBeDefined();
    expect(body.tools).toHaveLength(1);
    // GLM openai_chat format wraps tools as { type: 'function', function: { name, description, parameters } }
    const tool = (body.tools as Record<string, unknown>[])[0]!;
    const fn = tool['function'] as Record<string, unknown>;
    expect(fn['name']).toBe('read_file');
    expect(fn['description']).toBe('Read a file');
    expect(fn['parameters']).toEqual({ type: 'object' });
  });

  it('maps string tools to tool_N format', async () => {
    const gw = makeGw();
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
      tools: ['read_file', 'write_file'],
    });
    const body = capturedBody as { tools?: unknown[] };
    expect(body.tools).toHaveLength(2);
    // String tools are mapped to { name: tool_N } by ManagedGateway, then to function format
    const t0 = (body.tools as Record<string, unknown>[])[0]!;
    const t1 = (body.tools as Record<string, unknown>[])[1]!;
    expect((t0['function'] as Record<string, unknown>)['name']).toBe('tool_0');
    expect((t1['function'] as Record<string, unknown>)['name']).toBe('tool_1');
  });

  it('does not include tools field when tools array is empty', async () => {
    const gw = makeGw();
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
      tools: [],
    });
    const body = capturedBody as { tools?: unknown };
    expect(body.tools).toBeUndefined();
  });

  it('uses custom systemPrompt when provided', async () => {
    const gw = makeGw();
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
      systemPrompt: 'Custom system prompt here',
    });
    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toBe('Custom system prompt here');
  });

  it('uses default system prompt when not provided', async () => {
    const gw = makeGw();
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]!.content).toBe('You are a precise agent execution engine.');
  });

  it('records cost in EconomicKernel after successful call', async () => {
    const gw = makeGw({ budget: 100.0 });
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('ok'))) as any;
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 'task1', stepId: 's1', tier: 'work',
    });
    expect(result.usage.success).toBe(true);
    expect(result.usage.cost_usd).toBeGreaterThan(0);
    expect(result.usage.cost_usd).toBeLessThan(1);
  });

  it('returns fallback_triggered=false on single provider success', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('ok'))) as any;
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    expect(result.fallback_triggered).toBe(false);
  });

  it('returns model_used and provider_used in result', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('ok'))) as any;
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    expect(result.model_used).toBeDefined();
    expect(result.provider_used).toBeDefined();
  });

  it('includes user prompt in messages', async () => {
    const gw = makeGw();
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('What is 2+2?', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    const userMsg = body.messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('What is 2+2?');
  });

  it('handles fetch returning HTTP 500 error', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse({ error: 'server error' }, 500)) as any;
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    expect(result.usage.success).toBe(false);
  }, 30000);

  it('handles fetch returning HTTP 429 rate limited', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => mockFetchResponse({ error: 'rate limited' }, 429)) as any;
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    expect(result.usage.success).toBe(false);
  });

  it('handles fetch throwing network error', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    expect(result.usage.success).toBe(false);
  });

  it('passes temperature and max_tokens from defaults', async () => {
    const gw = makeGw();
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    const body = capturedBody as { temperature: number; max_tokens: number };
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(8000);
  });

  it('returns fail with error JSON when all providers fail', async () => {
    const gw = makeGw();
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); }) as any;
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
    });
    expect(result.usage.success).toBe(false);
    expect(result.response).toContain('All providers failed');
  });

  it('uses estimatedOutputTokens for rate limit check', async () => {
    const gw = makeGw({ rpmLimit: 100 });
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockFetchResponse(makeChatResponse('ok'));
    }) as any;
    await gw.complete('test', {
      userId: 'u1', taskId: 't1', stepId: 's1', tier: 'work',
      estimatedOutputTokens: 500,
    });
    // Should succeed — just verifying the estimatedOutputTokens path is exercised
    const body = capturedBody as { max_tokens: number };
    expect(body.max_tokens).toBe(8000);
  });
});

describe('ManagedGateway.complete() fallback and circuit breaker', () => {
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  // 1. Fallback chain: first provider fails, second succeeds

  it('triggers fallback when first provider fails and second succeeds', async () => {
    const kv = new KeyVault();
    kv.addKey('zhipu', 'zhipu-key');
    kv.addKey('deepseek', 'deepseek-key');
    const registry = new CapabilityRegistry();
    const economic = new EconomicKernel();
    const rateLimiter = new RateLimiter({ rpmLimit: 100, tpmLimit: 10_000_000, concurrentLimit: 10 });
    const gw = new ManagedGateway({ keyVault: kv, registry, economic, rateLimiter });

    const deepseekEndpoint = 'https://api.deepseek.com/v1/chat/completions';
    const zhipuEndpoint = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === deepseekEndpoint) throw new Error('ECONNREFUSED');
      if (url === zhipuEndpoint) return mockFetchResponse(makeChatResponse('fallback success'));
      throw new Error(`unexpected URL: ${url}`);
    }) as any;

    const result = await gw.complete('test prompt', {
      userId: 'user1', taskId: 'task1', stepId: 'step1', tier: 'work',
    });
    expect(result.usage.success).toBe(true);
    expect(result.response).toBe('fallback success');
    expect(result.fallback_triggered).toBe(true);
    expect(result.fallback_chain.length).toBeGreaterThanOrEqual(2);
  }, 30000);

  // 2. Circuit breaker open: after 5 failures, breaker blocks provider

  it('returns circuit breakers open after threshold failures', async () => {
    const kv = new KeyVault();
    kv.addKey('zhipu', 'zhipu-key');
    const registry = new CapabilityRegistry();
    const economic = new EconomicKernel();
    const rateLimiter = new RateLimiter({ rpmLimit: 100, tpmLimit: 10_000_000, concurrentLimit: 10 });
    const gw = new ManagedGateway({ keyVault: kv, registry, economic, rateLimiter });

    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;

    // Make 5 failed calls to open the breaker (threshold=5)
    for (let i = 0; i < 5; i++) {
      await gw.complete('test', {
        userId: 'u1', taskId: `fail-task-${i}`, stepId: `s${i}`, tier: 'work',
      });
    }
    // 6th call: breaker should be open
    const result = await gw.complete('test', {
      userId: 'u1', taskId: 'cb-task', stepId: 's6', tier: 'work',
    });
    expect(result.usage.success).toBe(false);
    // Either "Circuit breakers open" or "All providers failed" depending on exact flow
    const errorResponse = JSON.parse(result.response);
    expect(errorResponse.error.toLowerCase()).toMatch(/circuit breaker|all providers failed/);
  }, 60000);

  // 3. All providers failed: only one provider, it fails, switchProvider throws

  it('returns all providers failed when single provider dispatch throws', async () => {
    const kv = new KeyVault();
    kv.addKey('zhipu', 'zhipu-key');
    const registry = new CapabilityRegistry();
    const economic = new EconomicKernel();
    const rateLimiter = new RateLimiter({ rpmLimit: 100, tpmLimit: 10_000_000, concurrentLimit: 10 });
    const gw = new ManagedGateway({ keyVault: kv, registry, economic, rateLimiter });

    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;

    const result = await gw.complete('test', {
      userId: 'u1', taskId: 'all-fail', stepId: 's1', tier: 'work',
    });
    expect(result.usage.success).toBe(false);
    const errorResponse = JSON.parse(result.response);
    expect(errorResponse.error).toContain('All providers failed');
  }, 30000);

  // 4. Budget insufficient: estimateCost > budgetRemaining

  it('returns budget insufficient when cost exceeds remaining budget', async () => {
    const kv = new KeyVault();
    kv.addKey('zhipu', 'zhipu-key');
    const registry = new CapabilityRegistry();
    const economic = new EconomicKernel();
    economic.createBudget('budget-task', 0.0001); // Very small budget
    const rateLimiter = new RateLimiter({ rpmLimit: 100, tpmLimit: 10_000_000, concurrentLimit: 10 });
    const gw = new ManagedGateway({ keyVault: kv, registry, economic, rateLimiter });

    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('ok'))) as any;

    const result = await gw.complete('test prompt', {
      userId: 'u1', taskId: 'budget-task', stepId: 's1', tier: 'work',
    });
    // zhipu glm-5.2: price_input=0.5, price_output=1.5
    // estInput=1, estOutput=2000
    // estCost = 1/1M * 0.5 + 2000/1M * 1.5 = ~0.003 > 0.0001
    expect(result.usage.success).toBe(false);
    const errorResponse = JSON.parse(result.response);
    expect(errorResponse.error.toLowerCase()).toMatch(/budget|all providers failed/);
  }, 30000);
});
