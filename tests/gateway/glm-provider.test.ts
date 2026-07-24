import { describe, expect, it, vi } from 'vitest';

import { GlmProvider } from '../../gateway/glm-provider.js';
import type { ProviderDispatchContext } from '../../gateway/model-gateway.js';
import {
  ProviderTimeoutError,
  type ProviderRequest,
  type StreamEvent,
} from '../../gateway/scripted-provider.js';

const request: ProviderRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [
    {
      name: 'read_file',
      risk_feature_extractor: 'Read a workspace file',
      input_schema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
        additionalProperties: false,
      },
    },
  ],
};

function context(secret = 'lease-secret'): ProviderDispatchContext {
  return {
    operation_id: 'operation-1',
    attempt_id: 'attempt-1',
    credential: {
      lease_id: 'lease-1',
      audience: 'https://provider.invalid',
      expires_at: '2030-01-01T00:00:00.000Z',
      secret,
    },
  };
}

function jsonResponse(content = 'ok'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      model: 'glm-5.2',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('GlmProvider dispatch adapter', () => {
  it('uses only the dispatch-scoped credential and forwards the cancellation signal', async () => {
    const ambient = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'ambient-secret-must-not-be-used';
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer lease-secret');
      return jsonResponse();
    });
    const provider = new GlmProvider({
      model: 'glm-5.2',
      reasoningEffort: 'xhigh',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: fetchImpl,
    });
    const controller = new AbortController();

    try {
      await provider.resolve(request, { ...context(), signal: controller.signal });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]![1]?.signal).toBe(controller.signal);
      expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('ambient-secret-must-not-be-used');
    } finally {
      if (ambient === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = ambient;
    }
  });

  it('fails closed without an ephemeral credential secret', async () => {
    const provider = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: vi.fn(),
    });
    await expect(provider.resolve(request, { operation_id: 'missing-secret' })).rejects.toThrow(
      'dispatch credential',
    );
    await expect(provider.resolve(request)).rejects.toThrow(
      'dispatch credential secret is required',
    );
  });

  it('sends an exact JSON POST request and rejects HTTP failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse())
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    const provider = new GlmProvider({
      model: 'glm-5.2',
      reasoningEffort: 'xhigh',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: fetchImpl,
    });

    await provider.resolve(request, context('exact-secret'));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://provider.invalid/chat/completions');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers)).toEqual(
      new Headers({
        'Content-Type': 'application/json',
        Authorization: 'Bearer exact-secret',
      }),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'glm-5.2',
      reasoning_effort: 'xhigh',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.1,
      max_tokens: 4096,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a workspace file',
            parameters: request.tools![0]!.input_schema,
          },
        },
      ],
    });
    await expect(provider.resolve(request, context())).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 429,
    });
  });

  it('rejects expired and invalid deadlines before network dispatch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: fetchImpl,
    });

    for (const deadline_at of [
      '1970-01-01T00:00:00.000Z',
      'not-a-date',
    ]) {
      await expect(
        provider.resolve(request, { ...context(), deadline_at }),
      ).rejects.toBeInstanceOf(ProviderTimeoutError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('combines caller cancellation with a future deadline', async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(controller.signal);
      return jsonResponse();
    });
    const provider = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: fetchImpl,
    });
    const controller = new AbortController();

    await provider.resolve(request, {
      ...context(),
      signal: controller.signal,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('sends the full selected tool input schema to the provider', () => {
    const provider = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: vi.fn(),
    });
    const normalized = provider.normalizeRequest(request) as {
      tools: Array<{ function: { name: string; description: string; parameters: unknown } }>;
    };

    expect(normalized.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a workspace file',
        parameters: request.tools![0]!.input_schema,
      },
    });
  });

  it('parses real incremental SSE content, tool calls and final usage', async () => {
    const encoder = new TextEncoder();
    const frames = [
      'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/workspace/a\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    const provider = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: vi.fn(async () => new Response(body, { status: 200 })),
    });
    const events: StreamEvent[] = [];

    for await (const event of provider.streamEvents(request, context())) events.push(event);

    expect(events).toEqual([
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
      {
        type: 'tool_call',
        tool_call: {
          id: 'call-1',
          name: 'read_file',
          arguments: { path: '/workspace/a' },
        },
      },
      {
        type: 'message_stop',
        stop_reason: 'tool_use',
        usage: { input_tokens: 4, output_tokens: 3 },
      },
    ]);
  });

  it('parses CRLF SSE, orders tool calls by index, and defaults arguments', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"second","function":{"name":"write_file"}},{"index":0,"id":"first","function":{"name":"read_file"}}]},"finish_reason":"tool_calls"}]}',
              '',
              '',
            ].join('\r\n'),
          ),
        );
        controller.close();
      },
    });
    const provider = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: vi.fn(async () => new Response(body, { status: 200 })),
    });
    const events: StreamEvent[] = [];

    for await (const event of provider.streamEvents(request, context())) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'tool_call',
        tool_call: { id: 'first', name: 'read_file', arguments: {} },
      },
      {
        type: 'tool_call',
        tool_call: { id: 'second', name: 'write_file', arguments: {} },
      },
      { type: 'message_stop', stop_reason: 'tool_use' },
    ]);
  });

  it('marks streaming requests explicitly and requests terminal usage', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    });
    const provider = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: fetchImpl,
    });
    const events = [];

    for await (const event of provider.streamEvents(request, context())) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'message_stop', stop_reason: 'stop' }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fails closed for missing stream bodies and non-terminal streams', async () => {
    const noBody = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
    });
    await expect(async () => {
      for await (const _event of noBody.streamEvents(request, context())) {
        // No event is expected.
      }
    }).rejects.toThrow('stream returned no body');

    const encoder = new TextEncoder();
    const incompleteBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
          ),
        );
        controller.close();
      },
    });
    const incomplete = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: vi.fn(async () => new Response(incompleteBody, { status: 200 })),
    });
    await expect(async () => {
      for await (const _event of incomplete.streamEvents(request, context())) {
        // Consume the text delta before the required terminal event is checked.
      }
    }).rejects.toThrow('without a terminal event');
  });

  it('fails closed when a completed streamed tool lacks identity', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          ),
        );
        controller.close();
      },
    });
    const provider = new GlmProvider({
      model: 'glm-5.2',
      endpoint: 'https://provider.invalid/chat/completions',
      fetch: vi.fn(async () => new Response(body, { status: 200 })),
    });

    await expect(async () => {
      for await (const _event of provider.streamEvents(request, context())) {
        // Parsing the terminal frame must reject the incomplete tool identity.
      }
    }).rejects.toThrow('streamed tool call missing id or name');
  });
});
