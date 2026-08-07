import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createProviderAdapter, getProviderRegions } from '../../gateway/provider-adapters.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry, type ModelBinding } from '../../gateway/capability-registry.js';

function getBinding(provider: string, modelId: string): ModelBinding {
  const cr = new CapabilityRegistry();
  const all = cr.listAll();
  return all.find(b => b.provider === provider && b.model_id === modelId)!;
}

describe('getProviderRegions', () => {
  it('returns us for openai', () => {
    expect(getProviderRegions('openai')).toContain('us');
  });
  it('returns cn for zhipu', () => {
    expect(getProviderRegions('zhipu')).toContain('cn');
  });
  it('returns local for ollama', () => {
    expect(getProviderRegions('ollama')).toContain('local');
  });
  it('returns local for vllm', () => {
    expect(getProviderRegions('vllm')).toContain('local');
  });
  it('returns cn for seedance', () => {
    expect(getProviderRegions('seedance')).toContain('cn');
  });
  it('defaults to us for unknown provider', () => {
    expect(getProviderRegions('unknown')).toEqual(['us']);
  });
});

describe('createProviderAdapter', () => {
  let oldEnv: Record<string, string | undefined>;
  beforeEach(() => { oldEnv = { ...process.env }; });
  afterEach(() => { process.env = oldEnv; });

  it('creates adapter for openai', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    expect(adapter).toBeDefined();
  });

  it('creates adapter for ollama (no auth required)', () => {
    const kv = new KeyVault();
    const binding = getBinding('ollama', 'llama3');
    const adapter = createProviderAdapter(binding, kv);
    expect(adapter).toBeDefined();
  });

  it('creates adapter for seedance (async_task format)', () => {
    process.env.VOLC_API_KEY = 'volc-test';
    const kv = new KeyVault();
    const binding = getBinding('seedance', 'seedance-1-0-pro');
    const adapter = createProviderAdapter(binding, kv);
    expect(adapter).toBeDefined();
  });

  it('normalizeRequest builds OpenAI chat format for openai provider', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.5,
      max_tokens: 1000,
    } as any) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(body['temperature']).toBe(0.5);
    expect(body['max_tokens']).toBe(1000);
    const messages = body['messages'] as unknown[];
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('normalizeRequest adds reasoning_effort for glm-5.x', () => {
    process.env.GLM_API_KEY = 'glm-test';
    const kv = new KeyVault();
    const binding = getBinding('zhipu', 'glm-5.2');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
    } as any) as Record<string, unknown>;
    expect(body['reasoning_effort']).toBe('xhigh');
    expect(body['thinking']).toBeDefined();
  });

  it('normalizeRequest uses default temperature when not provided', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
    } as any) as Record<string, unknown>;
    expect(body['temperature']).toBe(0.3);
  });

  it('parseResponse extracts content from OpenAI format', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.content).toBe('hello world');
    expect(result.stop_reason).toBe('stop');
    expect(result.usage!.input_tokens).toBe(10);
    expect(result.usage!.output_tokens).toBe(5);
  });

  it('parseResponse sets stop_reason to tool_use when tool_calls present', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{"path":"/test"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.stop_reason).toBe('tool_use');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0]!.name).toBe('read_file');
    expect(result.tool_calls![0]!.arguments).toEqual({ path: '/test' });
  });

  it('parseResponse extracts content from reasoning_content when content is empty', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      choices: [{
        message: { content: '', reasoning_content: '{"answer": 42}' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.content).toBe('{"answer": 42}');
  });

  it('mapError classifies auth errors', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('HTTP 401 unauthorized'));
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('mapError classifies rate limit errors', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('HTTP 429 rate limited'));
    expect(err.kind).toBe('rate_limited');
    expect(err.retryable).toBe(false);
  });

  it('mapError classifies timeout errors', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('request timed out'));
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('mapError classifies server errors', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('HTTP 500 server error'));
    expect(err.kind).toBe('server');
    expect(err.retryable).toBe(true);
  });

  it('mapError classifies invalid request errors', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('HTTP 400 invalid request'));
    expect(err.kind).toBe('invalid_request');
    expect(err.retryable).toBe(false);
  });

  it('mapError classifies unknown errors', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('something weird happened'));
    expect(err.kind).toBe('unknown');
    expect(err.retryable).toBe(false);
  });

  it('checkHealth returns healthy when key available', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    expect(adapter.checkHealth()).toBe('healthy');
  });

  it('checkHealth returns down when no key', () => {
    delete process.env.OPENAI_API_KEY;
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    expect(adapter.checkHealth()).toBe('down');
  });

  it('validateDataPolicy always returns allowed', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.validateDataPolicy({} as any);
    expect(result.allowed).toBe(true);
  });

  it('meterUsage extracts usage from response', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const usage = adapter.meterUsage({ usage: { input_tokens: 100, output_tokens: 50 } } as any);
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
  });

  it('normalizeToolCall parses function call format', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const tc = adapter.normalizeToolCall({ id: 'tc1', function: { name: 'read_file', arguments: '{"path":"/test"}' } });
    expect(tc.id).toBe('tc1');
    expect(tc.name).toBe('read_file');
    expect(tc.arguments).toEqual({ path: '/test' });
  });

  it('normalizeToolCall throws on missing id', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    expect(() => adapter.normalizeToolCall({ function: { name: 'test' } })).toThrow();
  });

  it('normalizeToolCall throws on missing name', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    expect(() => adapter.normalizeToolCall({ id: 'tc1' })).toThrow();
  });

  it('normalizeToolCall handles empty arguments string', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    const binding = getBinding('openai', 'gpt-4o');
    const adapter = createProviderAdapter(binding, kv);
    const tc = adapter.normalizeToolCall({ id: 'tc1', function: { name: 'test', arguments: '' } });
    expect(tc.arguments).toEqual({});
  });
});

const originalFetch = globalThis.fetch;

describe('createProviderAdapter resolve()', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  function makeReq(): any {
    return {
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3, max_tokens: 100,
    };
  }

  it('resolve() returns JSON on success for zhipu', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'test-key');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
      text: async () => '{}', headers: new Headers(),
    } as Response)) as any;
    const result = await adapter.resolve(makeReq());
    expect(result).toBeDefined();
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall![0]).toBe(binding.api_base + '/chat/completions');
    const init = fetchCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
  });

  it('resolve() throws No API key for non-local provider without key', async () => {
    const kv = new KeyVault();
    // Manually remove zhipu key if it was auto-loaded
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) } as Response)) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('No API key for zhipu');
  });

  it('resolve() allows empty key for local provider (ollama)', async () => {
    const kv = new KeyVault();
    const binding = getBinding('ollama', 'llama3');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
      text: async () => '{}', headers: new Headers(),
    } as Response)) as any;
    // KeyVault auto-registers ollama with 'local-no-auth' key, so resolve won't throw
    // The key difference: local providers don't throw "No API key" even if key is empty
    const result = await adapter.resolve(makeReq());
    expect(result).toBeDefined();
    // Ollama auto-gets 'local-no-auth' key, so Authorization header is present
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    const authHeader = (init.headers as Record<string, string>)['Authorization'];
    // KeyVault auto-registers 'local-no-auth' for ollama, so header exists
    expect(authHeader).toBeDefined();
    expect(authHeader).toContain('local-no-auth');
  });

  it('resolve() throws HTTP 429 with rate limited message', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}), headers: new Headers(),
    } as Response)) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('HTTP 429 rate limited');
  });

  it('resolve() throws HTTP 500 with status', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 500, text: async () => 'server error', json: async () => ({}), headers: new Headers(),
    } as Response)) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('HTTP 500');
  });

  it('resolve() throws HTTP 400 with status', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 400, text: async () => 'bad request', json: async () => ({}), headers: new Headers(),
    } as Response)) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('HTTP 400');
  });

  it('resolve() passes AbortSignal.timeout(90000) as signal', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    let capturedSignal: unknown;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', headers: new Headers() } as Response;
    }) as any;
    await adapter.resolve(makeReq());
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('resolve() sends POST method with JSON body', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', headers: new Headers() } as Response;
    }) as any;
    await adapter.resolve(makeReq());
    expect(capturedInit!.method).toBe('POST');
    expect(capturedInit!.body).toBeDefined();
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.model).toBe('glm-4-plus');
    expect(body.messages).toBeDefined();
  });
});
