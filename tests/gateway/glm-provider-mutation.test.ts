import { describe, expect, it, vi } from 'vitest';

import { createGlmGateway } from '../../gateway/glm-gateway-bridge.js';
import {
  GlmProvider,
  GlmProviderError,
  glmProviderRuntime,
  type GlmProviderOptions,
} from '../../gateway/glm-provider.js';
import type {
  ParsedResponse,
  ProviderRequest,
} from '../../gateway/scripted-provider.js';
import {
  ProviderHttpError,
  ProviderTimeoutError,
} from '../../gateway/scripted-provider.js';

function provider(overrides: Partial<GlmProviderOptions> = {}): GlmProvider {
  return new GlmProvider({
    model: 'glm-5.2',
    reasoningEffort: 'xhigh',
    endpoint: 'https://provider.invalid/chat/completions',
    fetch: vi.fn(),
    ...overrides,
  });
}

function gateway() {
  return createGlmGateway({
    model: 'glm-5.2',
    reasoningEffort: 'xhigh',
    fetch: vi.fn(),
    secretsBroker: {
      exchangeCredential: async ({ audience }) => ({
        lease_id: 'lease',
        audience,
        expires_at: '2030-01-01T00:00:00.000Z',
        secret: 'test-only-secret',
      }),
    },
    egressPolicy: {
      authorize: async () => ({ allowed: true }),
    },
  });
}

describe('GlmProvider mutation-killing tests', () => {
  it('requires injected model configuration', () => {
    expect(() => new GlmProvider({ model: '' })).toThrow('model is required');
    expect(() => new GlmProvider({ model: '   ' })).toThrow(
      'GLM model is required',
    );
    expect(provider().checkHealth()).toBe('healthy');
    expect(provider().provider_type).toBe('openai');
    const error = new GlmProviderError('typed failure');
    expect({ name: error.name, message: error.message }).toEqual({
      name: 'GlmProviderError',
      message: 'typed failure',
    });
  });

  it('rejects a non-HTTPS endpoint', () => {
    expect(() => provider({ endpoint: 'http://provider.invalid' })).toThrow(
      'HTTPS',
    );
  });

  it('normalizes model, reasoning, messages and defaults', () => {
    expect(
      provider().normalizeRequest({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).toEqual({
      model: 'glm-5.2',
      reasoning_effort: 'xhigh',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.1,
      max_tokens: 4096,
    });
  });

  it('normalizes explicit temperature and max tokens', () => {
    expect(
      provider().normalizeRequest({
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
        max_tokens: 2048,
      }),
    ).toMatchObject({ temperature: 0.5, max_tokens: 2048 });
    expect(
      provider({ reasoningEffort: 'high' }).normalizeRequest({
        messages: [],
      }),
    ).toEqual({
      model: 'glm-5.2',
      reasoning_effort: 'high',
      messages: [],
      temperature: 0.1,
      max_tokens: 4096,
    });
  });

  it('maps full tools and omits an empty tool list', () => {
    const schema = {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
    };
    const normalized = provider().normalizeRequest({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'read_file',
          risk_feature_extractor: 'read',
          input_schema: schema,
        },
      ],
    }) as {
      tools: Array<{
        type: string;
        function: { name: string; description: string; parameters: unknown };
      }>;
    };
    expect(normalized.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'read',
        parameters: schema,
      },
    });
    expect(
      provider().normalizeRequest({ messages: [], tools: [] }),
    ).not.toHaveProperty('tools');
  });

  it('parses text, usage, model and finish reasons', () => {
    const parsed = provider().parseResponse({
      choices: [{ message: { content: 'hello' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
      model: 'response-model',
    });
    expect(parsed).toMatchObject({
      content: 'hello',
      stop_reason: 'length',
      usage: { input_tokens: 5, output_tokens: 3 },
      model: 'response-model',
    });
    expect(
      provider().parseResponse({
        choices: [
          { message: { content: 'blocked' }, finish_reason: 'content_filter' },
        ],
      }).stop_reason,
    ).toBe('content_filter');
    expect(
      provider().parseResponse({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      }).stop_reason,
    ).toBe('stop');
  });

  it('parses tool calls and default response fields', () => {
    const parsed = provider().parseResponse({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call-1',
                function: { name: 'read_file', arguments: '{"path":"/f"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(parsed.content).toBe('');
    expect(parsed.stop_reason).toBe('tool_use');
    expect(parsed.tool_calls?.[0]).toEqual({
      id: 'call-1',
      name: 'read_file',
      arguments: { path: '/f' },
    });
    expect(parsed.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(parsed.model).toBe('glm-5.2');
  });

  it('fails closed on missing choices', () => {
    expect(() => provider().parseResponse({})).toThrow(GlmProviderError);
    expect(() => provider().parseResponse({ choices: [] })).toThrow(
      GlmProviderError,
    );
  });

  it('normalizes tool calls and rejects missing identity', () => {
    expect(
      provider().normalizeToolCall({
        id: 'call-1',
        function: { name: 'tool', arguments: '{"a":1}' },
      }),
    ).toEqual({ id: 'call-1', name: 'tool', arguments: { a: 1 } });
    expect(() => provider().normalizeToolCall(null)).toThrow(GlmProviderError);
    expect(() =>
      provider().normalizeToolCall({ id: 'call-1' }),
    ).toThrow(GlmProviderError);
    expect(() =>
      provider().normalizeToolCall({
        id: '',
        function: { name: 'tool', arguments: '{}' },
      }),
    ).toThrow('tool call missing id or name');
    expect(() =>
      provider().normalizeToolCall({
        id: 'call-1',
        function: { name: '', arguments: '{}' },
      }),
    ).toThrow('tool call missing id or name');
    expect(
      provider().normalizeToolCall({
        id: 'call-2',
        function: { name: 'tool' },
      }),
    ).toEqual({ id: 'call-2', name: 'tool', arguments: {} });
  });

  it.each([
    [new ProviderHttpError(401), 'auth', false],
    [new ProviderHttpError(429), 'rate_limited', true],
    [new ProviderTimeoutError(), 'timeout', true],
    [new ProviderHttpError(500), 'server', true],
    [new ProviderHttpError(400), 'invalid_request', false],
    [new Error('weird'), 'unknown', false],
  ] as const)('maps typed provider error to %s', (error, kind, retryable) => {
    expect(provider().mapError(error)).toMatchObject({
      kind,
      retryable,
    });
  });

  it('maps exact provider errors including status and non-Error values', () => {
    expect(provider().mapError(new ProviderHttpError(403))).toEqual({
      kind: 'auth',
      retryable: false,
      detail: 'Provider authentication failed',
      status: 403,
    });
    expect(provider().mapError(new ProviderHttpError(502))).toEqual({
      kind: 'server',
      retryable: true,
      detail: 'Provider server failure',
      status: 502,
    });
    expect(provider().mapError(new ProviderHttpError(418))).toEqual({
      kind: 'invalid_request',
      retryable: false,
      detail: 'Provider rejected request',
      status: 418,
    });
    expect(provider().mapError(new Error('specific failure'))).toEqual({
      kind: 'unknown',
      retryable: false,
      detail: 'specific failure',
    });
    expect(provider().mapError('plain failure')).toEqual({
      kind: 'unknown',
      retryable: false,
      detail: 'plain failure',
    });
  });

  it('meters explicit and absent usage', () => {
    expect(
      provider().meterUsage({
        content: 'x',
        usage: { input_tokens: 5, output_tokens: 3 },
      } as ParsedResponse),
    ).toEqual({ input_tokens: 5, output_tokens: 3 });
    expect(
      provider().meterUsage({ content: 'x' } as ParsedResponse),
    ).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('leaves remote authorization to ModelGateway', () => {
    expect(
      provider().validateDataPolicy({ messages: [] } as ProviderRequest),
    ).toEqual({
      allowed: true,
      reason: 'remote policy is enforced by ModelGateway',
    });
  });

  it('builds bound runtime functions from injected configuration', () => {
    const runtime = glmProviderRuntime({
      model: 'glm-5.2',
      fetch: vi.fn(),
    });
    expect(runtime.provider_type).toBe('openai');
    expect(typeof runtime.normalizeRequest).toBe('function');
    expect(typeof runtime.resolve).toBe('function');
  });

  it('runtime resolve preserves the bound provider instance', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const runtime = glmProviderRuntime({
      model: 'glm-bound',
      endpoint: 'https://provider.invalid/chat',
      fetch: fetchImpl,
    });
    const raw = await runtime.resolve(
      { messages: [] },
      {
        operation_id: 'operation',
        credential: {
          lease_id: 'lease',
          audience: 'provider',
          expires_at: '2030-01-01T00:00:00.000Z',
          secret: 'secret',
        },
      },
    );

    expect(raw).toEqual({ choices: [] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('glm-gateway-bridge mutation-killing tests', () => {
  it('registers a remote, metered GLM provider', () => {
    const result = gateway();
    const registered = result.registry.snapshot.providers[0]!;
    expect(result.gateway.registrySnapshotHash).toBe(
      result.registry.snapshot.hash,
    );
    expect(registered).toMatchObject({
      provider_id: 'glm',
      provider_type: 'openai',
      max_context_tokens: 128_000,
      structured_output: true,
      tool_calling: true,
      data_policy: {
        execution: 'remote',
        regions: ['cn'],
        training_allowed: false,
      },
      pricing: {
        currency: 'USD',
        input_per_million: 0.5,
        output_per_million: 1.5,
      },
      network: {
        required: true,
        destination: 'https://open.bigmodel.cn',
      },
      credentials: {
        required: true,
        audience: 'https://open.bigmodel.cn',
      },
      health: 'healthy',
    });
    expect(registered.capabilities).toEqual(
      expect.arrayContaining([
        'text_reasoning',
        'tool_calling',
        'structured_output',
      ]),
    );
  });

  it('records usage without exposing the mutable backing array', async () => {
    const meter = gateway().usageMeter;
    await meter.record({
      provider_id: 'glm',
      operation_id: 'operation',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(meter.getRecords()).toHaveLength(1);
    expect(meter.getRecords()).not.toBe(meter.getRecords());
  });
});
