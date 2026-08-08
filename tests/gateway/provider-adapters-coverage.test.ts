import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createProviderAdapter, getProviderRegions } from '../../gateway/provider-adapters.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import type { ModelBinding } from '../../gateway/capability-registry.js';

const originalFetch = globalThis.fetch;

function makeBinding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  const registry = new CapabilityRegistry();
  const all = registry.listAll();
  return { ...all[0]!, ...overrides };
}

function makeZhipuBinding(): ModelBinding {
  return makeBinding({
    provider: 'zhipu',
    model_id: 'glm-5.2',
    api_format: 'openai_chat',
    api_base: 'https://open.bigmodel.cn/api/paas/v4',
  });
}

function makeAnthropicBinding(): ModelBinding {
  return makeBinding({
    provider: 'anthropic',
    model_id: 'claude-3-5-sonnet-20241022',
    api_format: 'anthropic',
    api_base: 'https://api.anthropic.com/v1',
  });
}

function makeLocalBinding(): ModelBinding {
  return makeBinding({
    provider: 'ollama',
    model_id: 'llama3',
    api_format: 'openai_chat',
    api_base: 'http://localhost:11434/v1',
  });
}

function mockFetch(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as Response;
}

describe('getProviderRegions', () => {
  it('returns correct regions for known providers', () => {
    expect(getProviderRegions('openai')).toEqual(['us']);
    expect(getProviderRegions('anthropic')).toEqual(['us']);
    expect(getProviderRegions('zhipu')).toEqual(['cn']);
    expect(getProviderRegions('deepseek')).toEqual(['cn']);
    expect(getProviderRegions('ollama')).toEqual(['local']);
    expect(getProviderRegions('vllm')).toEqual(['local']);
    expect(getProviderRegions('seedance')).toEqual(['cn']);
  });

  it('returns ["us"] for unknown providers', () => {
    expect(getProviderRegions('unknown')).toEqual(['us']);
  });
});

describe('createProviderAdapter buildRequestBody', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('normalizeRequest builds OpenAI format body', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    } as any) as Record<string, unknown>;
    expect(body['model']).toBe('glm-5.2');
    expect(body['temperature']).toBe(0.7);
    expect(body['max_tokens']).toBe(4096);
    const messages = body['messages'] as unknown[];
    expect(messages.length).toBe(2);
    expect((messages[0] as any).role).toBe('system');
    expect((messages[1] as any).role).toBe('user');
  });

  it('normalizeRequest builds Anthropic format body', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('anthropic', 'test-key');
    const binding = makeAnthropicBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.5,
      max_tokens: 2048,
    } as any) as Record<string, unknown>;
    expect(body['model']).toBe('claude-3-5-sonnet-20241022');
    expect(body['max_tokens']).toBe(2048);
    expect(body['system']).toBe('You are helpful');
    const messages = body['messages'] as unknown[];
    expect(messages.length).toBe(1);
    expect((messages[0] as any).role).toBe('user');
  });

  it('normalizeRequest adds reasoning_effort for GLM-5 models', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
    } as any) as Record<string, unknown>;
    expect(body['reasoning_effort']).toBe('xhigh');
    expect(body['thinking']).toBeDefined();
  });

  it('normalizeRequest does not add reasoning_effort for non-GLM-5 models', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeBinding({
      provider: 'zhipu',
      model_id: 'glm-4',
      api_format: 'openai_chat',
      api_base: 'https://open.bigmodel.cn/api/paas/v4',
    });
    const adapter = createProviderAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
    } as any) as Record<string, unknown>;
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('normalizeRequest adds tools in OpenAI format', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    } as any) as Record<string, unknown>;
    expect(body['tools']).toBeDefined();
    const tools = body['tools'] as unknown[];
    expect(tools.length).toBe(1);
    expect((tools[0] as any).function.name).toBe('read_file');
    expect(body['tool_choice']).toBe('auto');
  });

  it('normalizeRequest adds tools in Anthropic format', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('anthropic', 'test-key');
    const binding = makeAnthropicBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    } as any) as Record<string, unknown>;
    expect(body['tools']).toBeDefined();
    const tools = body['tools'] as unknown[];
    expect(tools.length).toBe(1);
    expect((tools[0] as any).name).toBe('read_file');
    expect((tools[0] as any).input_schema).toBeDefined();
  });

  it('normalizeRequest uses default temperature and max_tokens', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
    } as any) as Record<string, unknown>;
    expect(body['temperature']).toBe(0.3);
    expect(body['max_tokens']).toBe(8000);
  });

  it('normalizeRequest uses default system prompt when no system message', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
    } as any) as Record<string, unknown>;
    const messages = body['messages'] as unknown[];
    expect((messages[0] as any).role).toBe('system');
    expect((messages[0] as any).content).toContain('precise agent');
  });
});

describe('createProviderAdapter parseResponse', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('parseResponse parses OpenAI format response', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const result = adapter.parseResponse({
      choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }) as any;
    expect(result.content).toBe('hello world');
    expect(result.stop_reason).toBe('stop');
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(20);
    expect(result.model).toBe('glm-5.2');
  });

  it('parseResponse parses Anthropic format response', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('anthropic', 'test-key');
    const binding = makeAnthropicBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const result = adapter.parseResponse({
      content: [{ type: 'text', text: 'hello from claude' }],
      usage: { input_tokens: 5, output_tokens: 15 },
    }) as any;
    expect(result.content).toBe('hello from claude');
    expect(result.usage.input_tokens).toBe(5);
    expect(result.usage.output_tokens).toBe(15);
  });

  it('parseResponse handles tool_calls in OpenAI format', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const result = adapter.parseResponse({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{"path":"/test"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    }) as any;
    expect(result.stop_reason).toBe('tool_use');
    expect(result.tool_calls).toBeDefined();
    expect(result.tool_calls.length).toBe(1);
    expect(result.tool_calls[0].name).toBe('read_file');
  });

  it('parseResponse extracts reasoning_content when content is empty', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const result = adapter.parseResponse({
      choices: [{
        message: { content: '', reasoning_content: '{"action":"think"}' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    }) as any;
    expect(result.content).toBe('{"action":"think"}');
  });

  it('parseResponse extracts reasoning_content with regex match', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const result = adapter.parseResponse({
      choices: [{
        message: { content: '', reasoning_content: 'some text {"key":"value"} more text' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    }) as any;
    expect(result.content).toBe('{"key":"value"}');
  });

  it('parseResponse throws on no choices', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(() => adapter.parseResponse({})).toThrow(/No choices/);
  });
});

describe('createProviderAdapter normalizeToolCall', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });

  it('normalizes a valid tool call', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const result = adapter.normalizeToolCall({
      id: 'tc1',
      function: { name: 'read_file', arguments: '{"path":"/test"}' },
    });
    expect(result.id).toBe('tc1');
    expect(result.name).toBe('read_file');
    expect(result.arguments.path).toBe('/test');
  });

  it('throws on non-object input', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(() => adapter.normalizeToolCall('string')).toThrow(/invalid tool call/);
    expect(() => adapter.normalizeToolCall(null)).toThrow(/invalid tool call/);
  });

  it('throws on missing id or name', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(() => adapter.normalizeToolCall({ function: { name: 'test' } })).toThrow(/missing id or name/);
    expect(() => adapter.normalizeToolCall({ id: 'tc1' })).toThrow(/missing id or name/);
  });

  it('handles empty arguments string', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const result = adapter.normalizeToolCall({
      id: 'tc1',
      function: { name: 'read_file', arguments: '' },
    });
    expect(result.arguments).toEqual({});
  });
});

describe('createProviderAdapter mapError', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });

  it('classifies auth errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.mapError(new Error('HTTP 401: unauthorized')).kind).toBe('auth');
  });

  it('classifies rate limit errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.mapError(new Error('HTTP 429: rate limited')).kind).toBe('rate_limited');
  });

  it('classifies timeout errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.mapError(new Error('operation timed out')).kind).toBe('timeout');
  });

  it('classifies server errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.mapError(new Error('HTTP 500: server error')).kind).toBe('server');
  });

  it('classifies invalid request errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.mapError(new Error('HTTP 400: invalid request')).kind).toBe('invalid_request');
  });

  it('classifies unknown errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.mapError(new Error('something weird')).kind).toBe('unknown');
    expect(adapter.mapError('string error').kind).toBe('unknown');
  });
});

describe('createProviderAdapter utility methods', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });

  it('meterUsage returns response usage', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const usage = adapter.meterUsage({ usage: { input_tokens: 10, output_tokens: 20 } } as any);
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(20);
  });

  it('meterUsage returns zero when no usage', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    const usage = adapter.meterUsage({} as any);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  it('checkHealth returns healthy when key exists', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.checkHealth()).toBe('healthy');
  });

  it('checkHealth returns down when no key', () => {
    const keyVault = new KeyVault();
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.checkHealth()).toBe('down');
  });

  it('validateDataPolicy returns allowed', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.validateDataPolicy({ messages: [] } as any).allowed).toBe(true);
  });
});

describe('createProviderAdapter resolve', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('resolve makes POST request and returns JSON', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    globalThis.fetch = vi.fn(async () => mockFetch({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    })) as any;
    const result = await adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any);
    expect(result).toBeDefined();
  });

  it('resolve throws on HTTP error', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    globalThis.fetch = vi.fn(async () => mockFetch({ error: 'bad request' }, 400)) as any;
    await expect(adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any)).rejects.toThrow(/HTTP 400/);
  });

  it('resolve throws on 429 rate limit', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('zhipu', 'test-key');
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    globalThis.fetch = vi.fn(async () => mockFetch({ error: 'rate limited' }, 429)) as any;
    await expect(adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any)).rejects.toThrow(/429/);
  });

  it('resolve works for local providers without API key', async () => {
    const keyVault = new KeyVault();
    const binding = makeLocalBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    globalThis.fetch = vi.fn(async () => mockFetch({
      choices: [{ message: { content: 'local response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    })) as any;
    const result = await adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any);
    expect(result).toBeDefined();
  });

  it('resolve throws for remote providers without API key', async () => {
    const keyVault = new KeyVault();
    const binding = makeZhipuBinding();
    const adapter = createProviderAdapter(binding, keyVault);
    await expect(adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any)).rejects.toThrow(/No API key/);
  });
});

describe('createProviderAdapter async_task format', () => {
  it('returns async task adapter for async_task format', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({
      provider: 'seedance',
      api_format: 'async_task',
      api_base: 'https://api.seedance.com',
    });
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter).toBeDefined();
  });
});
