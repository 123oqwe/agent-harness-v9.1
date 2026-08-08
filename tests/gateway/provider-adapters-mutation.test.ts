import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createProviderAdapter } from '../../gateway/provider-adapters.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry, type ModelBinding } from '../../gateway/capability-registry.js';

function getBinding(provider: string, modelId: string): ModelBinding {
  const cr = new CapabilityRegistry();
  return cr.listAll().find(b => b.provider === provider && b.model_id === modelId)!;
}

function makeReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function mockStreamResponse(chunks: string[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: makeReadableStream(chunks),
    json: async () => ({}),
    text: async () => '',
    headers: new Headers(),
  } as Response;
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as Response;
}

const originalFetch = globalThis.fetch;

describe('provider-adapters: anthropic format', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('normalizeRequest builds anthropic format for anthropic provider', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7, max_tokens: 500,
    } as any) as Record<string, unknown>;
    expect(body['model']).toBe('claude-sonnet-4-5');
    expect(body['max_tokens']).toBe(500);
    expect(body['temperature']).toBe(0.7);
    expect(body['system']).toBe('You are a precise agent execution engine.');
    const messages = body['messages'] as unknown[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user' });
    const content = (messages[0] as Record<string, unknown[]>)['content'];
  });

  it('normalizeRequest builds anthropic format with tools', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'search', description: 'Search the web', parameters: { type: 'object' } }],
    } as any) as Record<string, unknown>;
    const tools = body['tools'] as unknown[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'search', description: 'Search the web' });
    expect(tools[0]).toHaveProperty('input_schema');
  });

  it('normalizeRequest uses default system prompt when no system messages', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
    } as any) as Record<string, unknown>;
    expect(body['system']).toBe('You are a precise agent execution engine.');
  });

  it('normalizeRequest uses system messages for anthropic', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [
        { role: 'system', content: 'Custom system prompt' },
        { role: 'user', content: 'hi' },
      ],
    } as any) as Record<string, unknown>;
    expect(body['system']).toBe('Custom system prompt');
  });

  it('normalizeRequest uses default temperature and max_tokens for anthropic', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
    } as any) as Record<string, unknown>;
    expect(body['temperature']).toBe(0.3);
    expect(body['max_tokens']).toBe(8000);
  });

  it('normalizeRequest builds openai format with tools and tool_choice', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'calc', description: 'Calculator', parameters: { type: 'object' } }],
    } as any) as Record<string, unknown>;
    const tools = body['tools'] as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'function' });
    expect(tools[0]!["function"]).toMatchObject({ name: "calc" });
    expect(body['tool_choice']).toBe('auto');
  });

  it('normalizeRequest uses system messages for openai format', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [
        { role: 'system', content: 'System A' },
        { role: 'system', content: 'System B' },
        { role: 'user', content: 'hello' },
      ],
    } as any) as Record<string, unknown>;
    const messages = body['messages'] as Record<string, string>[];
    expect(messages[0]).toMatchObject({ role: 'system', content: 'System A\nSystem B' });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('normalizeRequest uses default max_tokens for openai format', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'hi' }],
    } as any) as Record<string, unknown>;
    expect(body['max_tokens']).toBe(8000);
  });

  it('parseResponse extracts content from anthropic format', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      content: [{ type: 'text', text: 'Hello from Claude' }],
      usage: { input_tokens: 15, output_tokens: 25 },
    });
    expect(result.content).toBe('Hello from Claude');
    expect(result.usage!.input_tokens).toBe(15);
    expect(result.usage!.output_tokens).toBe(25);
    expect(result.stop_reason).toBe('stop');
  });

  it('parseResponse handles anthropic with multiple text blocks', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      content: [
        { type: 'text', text: 'Part 1 ' },
        { type: 'text', text: 'Part 2' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.content).toBe('Part 1 Part 2');
  });

  it('parseResponse handles anthropic with non-text blocks', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      content: [
        { type: 'image', text: 'should be ignored' },
        { type: 'text', text: 'only text' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.content).toBe('only text');
  });

  it('parseResponse handles anthropic with missing usage', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      content: [{ type: 'text', text: 'no usage' }],
    });
    expect(result.content).toBe('no usage');
    expect(result.usage!.input_tokens).toBe(0);
    expect(result.usage!.output_tokens).toBe(0);
  });

  it('parseResponse handles anthropic with empty content array', () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({ content: [] });
    expect(result.content).toBe('');
  });

  it('parseResponse throws on no choices for openai format', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    expect(() => adapter.parseResponse({ choices: [] })).toThrow('No choices');
  });

  it('parseResponse handles reasoning_content fallback to slice', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const longText = 'This is a long reasoning content without JSON braces that should be sliced to 2000 chars';
    const result = adapter.parseResponse({
      choices: [{ message: { content: '', reasoning_content: longText }, finish_reason: 'stop' }],
    });
    expect(result.content).toBe(longText);
  });

  it('parseResponse handles missing usage for openai format', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    });
    expect(result.usage!.input_tokens).toBe(0);
    expect(result.usage!.output_tokens).toBe(0);
  });

  it('parseResponse handles multiple tool_calls', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({
      choices: [{
        message: {
          content: '',
          tool_calls: [
            { id: 'tc1', function: { name: 'search', arguments: '{"q":"test"}' } },
            { id: 'tc2', function: { name: 'read', arguments: '{"path":"/a"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
    expect(result.tool_calls).toHaveLength(2);
    expect(result.tool_calls![0]!.name).toBe('search');
    expect(result.tool_calls![1]!.name).toBe('read');
    expect(result.stop_reason).toBe('tool_use');
  });

  it('resolve() sends to /messages endpoint for anthropic', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    let capturedUrl: string;
    globalThis.fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return mockJsonResponse({ content: [{ type: 'text', text: 'hi' }] });
    }) as any;
    await adapter.resolve({ messages: [{ role: 'user', content: 'hello' }] } as any);
    expect(capturedUrl!).toBe('https://api.anthropic.com/v1/messages');
  });

  it('resolve() sends anthropic headers with x-api-key', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    let capturedHeaders: Record<string, string>;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return mockJsonResponse({ content: [{ type: 'text', text: 'hi' }] });
    }) as any;
    await adapter.resolve({ messages: [{ role: 'user', content: 'hello' }] } as any);
    expect(capturedHeaders!['x-api-key']).toBe('ant-key');
    expect(capturedHeaders!['anthropic-version']).toBe('2023-06-01');
    expect(capturedHeaders!["Content-Type"]).toBe("application/json");
    expect(capturedHeaders!['Content-Type']).toBe('application/json');
  });

  it('resolve() sends to /chat/completions for openai format', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    let capturedUrl: string;
    globalThis.fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return mockJsonResponse({ choices: [{ message: { content: 'hi' } }] });
    }) as any;
    await adapter.resolve({ messages: [{ role: 'user', content: 'hello' }] } as any);
    expect(capturedUrl!).toContain('/chat/completions');
  });

  it('resolve() sends Bearer auth for openai format', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'my-key');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    let capturedHeaders: Record<string, string>;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return mockJsonResponse({ choices: [{ message: { content: 'hi' } }] });
    }) as any;
    await adapter.resolve({ messages: [{ role: 'user', content: 'hello' }] } as any);
    expect(capturedHeaders!['Authorization']).toBe('Bearer my-key');
  });

  it('resolve() sends no Authorization for local provider without key', async () => {
    const kv = new KeyVault();
    const binding = getBinding('ollama', 'llama3');
    const adapter = createProviderAdapter(binding, kv);
    let capturedHeaders: Record<string, string>;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return mockJsonResponse({ choices: [{ message: { content: 'hi' } }] });
    }) as any;
    await adapter.resolve({ messages: [{ role: 'user', content: 'hello' }] } as any);
    
    expect(capturedHeaders!['Authorization']).toContain('local-no-auth');
    expect(capturedHeaders!['Content-Type']).toBe('application/json');
  });

  it('resolve() throws 429 for anthropic with rate limited message', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ error: 'rate limited' }, 429)) as any;
    await expect(adapter.resolve({ messages: [{ role: 'user', content: 'hi' }] } as any))
      .rejects.toThrow('HTTP 429 rate limited');
  });

  it('resolve() throws HTTP error for anthropic with non-429 status', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ error: 'bad' }, 500)) as any;
    await expect(adapter.resolve({ messages: [{ role: 'user', content: 'hi' }] } as any))
      .rejects.toThrow('HTTP 500');
  });
});

describe('provider-adapters: streamEvents (openai format)', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('yields text_delta events from openai SSE stream', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":" World"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n',
      'data: [DONE]\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].text).toBe('Hello');
    expect(textDeltas[1].text).toBe(' World');
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent).toBeDefined();
    expect(stopEvent.stop_reason).toBe('stop');
    expect(stopEvent.usage.input_tokens).toBe(5);
    expect(stopEvent.usage.output_tokens).toBe(2);
  });

  it('yields tool_call events from openai SSE stream', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"tc1","function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}]}}]}\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const toolCalls = events.filter(e => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool_call.name).toBe('search');
    expect(toolCalls[0].tool_call.arguments).toEqual({ q: 'test' });
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent.stop_reason).toBe('tool_use');
  });

  it('handles length finish_reason in openai stream', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
      'data: {"choices":[{"finish_reason":"length"}]}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent.stop_reason).toBe('length');
  });

  it('handles unknown finish_reason as stop', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"choices":[{"finish_reason":"content_filter"}]}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent.stop_reason).toBe('stop');
  });

  it('skips malformed SSE chunks', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: not valid json\n',
      'data: {"choices":[{"delta":{"content":"good"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].text).toBe('good');
  });

  it('skips empty lines and non-data lines', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      '\n',
      ': comment\n',
      'data: {"choices":[{"delta":{"content":"x"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
  });

  it('yields final stop event when stream ends without finish_reason', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"text"}}]}\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent).toBeDefined();
    expect(stopEvent.stop_reason).toBe('stop');
    expect(stopEvent.usage.input_tokens).toBe(3);
    expect(stopEvent.usage.output_tokens).toBe(1);
  });

  it('throws 429 rate limited for stream', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ error: 'rate' }, 429)) as any;
    await expect(async () => {
      for await (const _ of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) { }
    }).rejects.toThrow('HTTP 429 rate limited');
  });

  it('throws HTTP error for stream with non-429 status', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ error: 'bad' }, 503)) as any;
    await expect(async () => {
      for await (const _ of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) { }
    }).rejects.toThrow('HTTP 503');
  });

  it('falls back to JSON when response body is null', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({
      choices: [{ message: { content: 'json fallback' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    })) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].text).toBe('json fallback');
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent.usage.input_tokens).toBe(1);
    expect(stopEvent.usage.output_tokens).toBe(2);
  });

  it('falls back to JSON with tool_calls when body is null', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'tc1', function: { name: 'read', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    })) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const toolCalls = events.filter(e => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool_call.name).toBe('read');
  });
});

describe('provider-adapters: streamEvents (anthropic format)', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('yields text_delta from anthropic content_block_delta events', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" World"}}\n',
      'data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":5}}\n',
      'data: {"type":"message_stop"}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].text).toBe('Hello');
    expect(textDeltas[1].text).toBe(' World');
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent).toBeDefined();
    expect(stopEvent.stop_reason).toBe('stop');
    expect(stopEvent.usage.input_tokens).toBe(10);
    expect(stopEvent.usage.output_tokens).toBe(5);
  });

  it('skips non-text_delta anthropic events', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"type":"content_block_start","delta":{"type":"text_delta","text":"ignored"}}\n',
      'data: {"type":"content_block_delta","delta":{"type":"image_delta","text":"ignored"}}\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"kept"}}\n',
      'data: {"type":"message_stop"}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].text).toBe('kept');
  });

  it('handles anthropic message_stop without prior usage', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n',
      'data: {"type":"message_stop"}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent).toBeDefined();
    expect(stopEvent.usage).toBeUndefined();
  });

  it('handles anthropic message_delta with partial usage', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"type":"message_delta","usage":{"input_tokens":15}}\n',
      'data: {"type":"message_delta","usage":{"output_tokens":8}}\n',
      'data: {"type":"message_stop"}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const stopEvent = events.find(e => e.type === 'message_stop');
    expect(stopEvent.usage.input_tokens).toBe(15);
    expect(stopEvent.usage.output_tokens).toBe(8);
  });

  it('throws 429 for anthropic stream', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ error: 'rate' }, 429)) as any;
    await expect(async () => {
      for await (const _ of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) { }
    }).rejects.toThrow('HTTP 429 rate limited');
  });

  it('throws HTTP error for anthropic stream', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ error: 'bad' }, 500)) as any;
    await expect(async () => {
      for await (const _ of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) { }
    }).rejects.toThrow('HTTP 500');
  });

  it('falls back to JSON for anthropic when body is null', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockJsonResponse({
      content: [{ type: 'text', text: 'fallback' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    })) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].text).toBe('fallback');
  });
});

describe('provider-adapters: edge cases', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('mapError handles non-Error input (string)', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError('some string error');
    expect(err.kind).toBe('unknown');
    expect(err.retryable).toBe(false);
    expect(err.detail).toBe('some string error');
  });

  it('mapError handles non-Error input (object)', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError({ code: 500 });
    expect(err.kind).toBe('unknown');
    expect(err.detail).toBe('[object Object]');
  });

  it('mapError handles non-Error input (number)', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(42);
    expect(err.kind).toBe('unknown');
    expect(err.detail).toBe('42');
  });

  it('normalizeToolCall throws on null input', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    expect(() => adapter.normalizeToolCall(null)).toThrow('invalid tool call');
  });

  it('normalizeToolCall throws on non-object input', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    expect(() => adapter.normalizeToolCall('string')).toThrow('invalid tool call');
  });

  it('normalizeToolCall throws on missing function', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    expect(() => adapter.normalizeToolCall({ id: 'tc1' })).toThrow('missing id or name');
  });

  it('meterUsage returns default when usage is undefined', () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    const usage = adapter.meterUsage({} as any);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  it('resolve() text().catch returns empty on failure', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 403,
      text: async () => { throw new Error('text read failed'); },
      json: async () => ({}),
      headers: new Headers(),
    } as unknown as Response)) as any;
    await expect(adapter.resolve({ messages: [{ role: 'user', content: 'hi' }] } as any))
      .rejects.toThrow('HTTP 403');
  });

  it('streamEvents works for local provider without key', async () => {
    const kv = new KeyVault();
    const binding = getBinding('ollama', 'llama3');
    const adapter = createProviderAdapter(binding, kv);
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"local"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n',
    ];
    globalThis.fetch = vi.fn(async () => mockStreamResponse(sseChunks)) as any;
    const events: any[] = [];
    for await (const ev of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) {
      events.push(ev);
    }
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].text).toBe('local');
  });

  it('streamEvents sends stream:true in body', async () => {
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const binding = getBinding('zhipu', 'glm-4-plus');
    const adapter = createProviderAdapter(binding, kv);
    let capturedBody: Record<string, unknown>;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return mockStreamResponse(['data: {"choices":[{"finish_reason":"stop"}]}\n']);
    }) as any;
    for await (const _ of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) { }
    expect(capturedBody!['stream']).toBe(true);
  });

  it('streamEvents sends to correct endpoint for anthropic', async () => {
    const kv = new KeyVault(); kv.addKey('anthropic', 'ant-key');
    const binding = getBinding('anthropic', 'claude-sonnet-4-5');
    const adapter = createProviderAdapter(binding, kv);
    let capturedUrl: string;
    globalThis.fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return mockStreamResponse(['data: {"type":"message_stop"}\n']);
    }) as any;
    for await (const _ of adapter.streamEvents({ messages: [{ role: 'user', content: 'hi' }] } as any)) { }
    expect(capturedUrl!).toBe('https://api.anthropic.com/v1/messages');
  });
});
