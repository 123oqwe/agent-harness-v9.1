import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:http', () => {
  throw new Error('ScriptedTestProvider attempted to load node:http');
});
vi.mock('node:https', () => {
  throw new Error('ScriptedTestProvider attempted to load node:https');
});
vi.mock('node:net', () => {
  throw new Error('ScriptedTestProvider attempted to load node:net');
});
vi.mock('node:dns', () => {
  throw new Error('ScriptedTestProvider attempted to load node:dns');
});
vi.mock('node:dns/promises', () => {
  throw new Error('ScriptedTestProvider attempted to load node:dns/promises');
});
vi.mock('node:child_process', () => {
  throw new Error('ScriptedTestProvider attempted to load node:child_process');
});

import * as providerModule from '../../gateway/scripted-provider';
import {
  ProviderHttpError,
  ProviderTimeoutError,
  ProviderValidationError,
  ScriptedResponseExhaustedError,
  ScriptedResponseMissingError,
  ScriptedTestProvider,
  hashMessages,
  scriptedProviderContract,
  type DataPolicyResult,
  type Message,
  type ParsedResponse,
  type ProviderRequest,
} from '../../gateway/scripted-provider';
import { SPEC_ROOT } from '../helpers/repository-paths.js';

const schemaPath = path.join(SPEC_ROOT, 'contracts/provider-adapter.schema.json');

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

function response(content: string, extra: Partial<ParsedResponse> = {}): ParsedResponse {
  return { content, stop_reason: 'stop', ...extra };
}

function request(messages: Message[], tools: string[] = []): ProviderRequest {
  return { messages, tools: tools.map((name) => ({ name })) };
}

describe('AH-GATEWAY-TESTPROVIDER-001: generated ProviderAdapter contract', () => {
  it('loads the registered Contract and both local fixtures', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
      required: string[];
      additionalProperties: boolean;
      properties: { provider_type: { enum: string[] } };
    };
    const valid = JSON.parse(
      fs.readFileSync(path.join(SPEC_ROOT, 'fixtures/phase-1/valid/provider-adapter.json'), 'utf8'),
    ) as Record<string, unknown>;
    const invalid = JSON.parse(
      fs.readFileSync(path.join(SPEC_ROOT, 'fixtures/phase-1/invalid/provider-adapter.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(schema.properties.provider_type.enum).toContain('scripted_test');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.every((field) => field in valid)).toBe(true);
    expect(schema.required.some((field) => !(field in invalid))).toBe(true);
  });

  it('publishes a descriptor that satisfies every generated contract feature', () => {
    expect(scriptedProviderContract).toEqual({
      provider_type: 'scripted_test',
      normalize_request: true,
      parse_response: true,
      normalize_tool_call: true,
      stream_events: true,
      map_error: true,
      meter_usage: true,
      check_health: true,
      validate_data_policy: true,
    });
    expect(Object.isFrozen(scriptedProviderContract)).toBe(true);
  });

  it('does not embed the formal ModelGateway implementation', () => {
    expect(providerModule).not.toHaveProperty('ModelGateway');
  });
});

describe('ScriptedTestProvider: recursive canonical hashing', () => {
  it('canonicalizes keys recursively without changing array order', () => {
    const first: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            name: 'write_file',
            arguments: { metadata: { z: 2, a: 1 }, lines: ['a', 'b'] },
          },
        ],
      },
    ];
    const reorderedKeys: Message[] = [
      {
        content: '',
        role: 'assistant',
        tool_calls: [
          {
            name: 'write_file',
            arguments: { lines: ['a', 'b'], metadata: { a: 1, z: 2 } },
            id: 'call-1',
          },
        ],
      },
    ];
    const reorderedArray: Message[] = structuredClone(reorderedKeys);
    const args = reorderedArray[0]!.tool_calls![0]!.arguments as { lines: string[] };
    args.lines.reverse();

    expect(hashMessages(first)).toBe(hashMessages(reorderedKeys));
    expect(hashMessages(first)).not.toBe(hashMessages(reorderedArray));
  });

  it('does not collide when nested ToolCall arguments differ', () => {
    const make = (approved: boolean): Message[] => [
      {
        role: 'assistant',
        content: 'proposal',
        tool_calls: [
          { id: 'call-1', name: 'execute', arguments: { policy: { approved } } },
        ],
      },
    ];

    expect(hashMessages(make(true))).not.toBe(hashMessages(make(false)));
  });
});

describe('ScriptedTestProvider: queue and map lookup', () => {
  it('deep-copies queue inputs and returns responses in order', () => {
    const queued = response('first', {
      tool_calls: [{ id: 'tool-1', name: 'read_file', arguments: { path: '/safe' } }],
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    const provider = new ScriptedTestProvider({ queue: [queued, response('second')] });
    (queued.tool_calls![0]!.arguments as { path: string }).path = '/mutated';
    if (queued.usage) queued.usage.input_tokens = 999;

    const first = provider.resolve(request([msg('user', 'go')]));
    expect(first.tool_calls![0]!.arguments).toEqual({ path: '/safe' });
    expect(first.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
    expect(provider.resolve(request([msg('user', 'next')])).content).toBe('second');
    expect(provider.remainingQueueLength).toBe(0);
  });

  it('maps recursively canonical messages to deterministic responses', () => {
    const messages = [msg('user', 'what is 2+2?')];
    const provider = new ScriptedTestProvider({
      map: { [hashMessages(messages)]: response('4') },
    });

    expect(provider.resolve(request(messages)).content).toBe('4');
    expect(provider.resolve(request(structuredClone(messages))).content).toBe('4');
  });

  it('fails explicitly for exhausted queues and missing map entries', () => {
    const queueProvider = new ScriptedTestProvider({ queue: [response('only')] });
    queueProvider.resolve(request([msg('user', 'one')]));
    expect(() => queueProvider.resolve(request([msg('user', 'two')]))).toThrow(
      ScriptedResponseExhaustedError,
    );

    const known = [msg('user', 'known')];
    const mapProvider = new ScriptedTestProvider({
      map: { [hashMessages(known)]: response('ok') },
    });
    expect(() => mapProvider.resolve(request([msg('user', 'unknown')]))).toThrow(
      ScriptedResponseMissingError,
    );
  });
});

describe('ScriptedTestProvider: strict normalization', () => {
  it('preserves validated nested ToolCalls, usage and model', () => {
    const provider = new ScriptedTestProvider({ model: 'fixture-model' });
    const parsed = provider.parseResponse({
      content: 'use tool',
      tool_calls: [
        {
          id: 'call-1',
          name: 'search_files',
          arguments: { query: { text: 'needle', options: { case_sensitive: false } } },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 7 },
      model: 'scripted-v1',
    });

    expect(parsed).toEqual({
      content: 'use tool',
      tool_calls: [
        {
          id: 'call-1',
          name: 'search_files',
          arguments: { query: { text: 'needle', options: { case_sensitive: false } } },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 7 },
      model: 'scripted-v1',
    });
  });

  it.each([
    null,
    [],
    {},
    { content: 1 },
    { content: 'ok', unknown: true },
    { content: 'ok', stop_reason: 'partial' },
    { content: 'ok', tool_calls: {} },
    { content: 'ok', usage: { input_tokens: -1, output_tokens: 0 } },
    { content: 'ok', usage: { input_tokens: 0, output_tokens: Number.NaN } },
    { content: 'ok', usage: { input_tokens: 0, output_tokens: 1.5 } },
    { content: 'ok', model: 7 },
  ])('rejects malformed response %#', (raw) => {
    const provider = new ScriptedTestProvider();
    expect(() => provider.parseResponse(raw)).toThrow(ProviderValidationError);
  });

  it.each([
    null,
    [],
    {},
    { id: '', name: 'read_file', arguments: {} },
    { id: 'call-1', name: '', arguments: {} },
    { id: 'call-1', name: 'read_file', arguments: null },
    { id: 'call-1', name: 'read_file', arguments: [] },
    { id: 'call-1', name: 'read_file', arguments: {}, extra: true },
  ])('rejects malformed ToolCall %#', (raw) => {
    const provider = new ScriptedTestProvider();
    expect(() => provider.normalizeToolCall(raw)).toThrow(ProviderValidationError);
  });

  it('normalizes requests into deeply immutable independent snapshots', () => {
    const provider = new ScriptedTestProvider();
    const source = request([msg('user', 'original')], ['read_file']);
    const normalized = provider.normalizeRequest(source) as {
      messages: Message[];
      tools: { name: string }[];
    };
    source.messages[0]!.content = 'mutated';

    expect(normalized.messages[0]!.content).toBe('original');
    expect(normalized.tools[0]!.name).toBe('read_file');
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.messages)).toBe(true);
  });
});

describe('ScriptedTestProvider: immutable call metadata', () => {
  it('records a deeply frozen snapshot with deterministic clock injection', () => {
    const provider = new ScriptedTestProvider({
      queue: [
        response('answer', {
          tool_calls: [{ id: 'tool-1', name: 'read_file', arguments: { path: '/a' } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ],
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    const messages = [msg('user', 'question')];
    provider.resolve(request(messages, ['read_file', 'edit_file']));
    messages[0]!.content = 'changed later';

    const log = provider.callLog;
    expect(log[0]).toMatchObject({
      index: 0,
      timestamp: '2026-01-02T03:04:05.000Z',
      tools_requested: ['read_file', 'edit_file'],
      usage: { input_tokens: 10, output_tokens: 5 },
      lookup_mode: 'queue',
    });
    expect(log[0]!.messages[0]!.content).toBe('question');
    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.isFrozen(log[0])).toBe(true);
    expect(Object.isFrozen(log[0]!.response.tool_calls![0]!.arguments)).toBe(true);
    expect(() => {
      (log[0]!.messages[0] as { content: string }).content = 'tampered';
    }).toThrow(TypeError);
  });
});

describe('ScriptedTestProvider: usage, streaming and explicit errors', () => {
  it('preserves declared zero usage and defaults missing usage to zero', () => {
    const provider = new ScriptedTestProvider();
    expect(
      provider.meterUsage(response('content', { usage: { input_tokens: 0, output_tokens: 0 } })),
    ).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(provider.meterUsage(response('content'))).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it('streams text, nested ToolCalls and final usage in order', async () => {
    const provider = new ScriptedTestProvider({
      queue: [
        response('chunk', {
          tool_calls: [{ id: 'tool-1', name: 'run', arguments: { nested: { value: 1 } } }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      ],
    });
    const events = [];
    for await (const event of provider.streamEvents(request([msg('user', 'go')]))) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'tool_call',
      'message_stop',
    ]);
    expect(events[1]).toMatchObject({
      type: 'tool_call',
      tool_call: { arguments: { nested: { value: 1 } } },
    });
    expect(events[2]).toMatchObject({ usage: { input_tokens: 3, output_tokens: 2 } });
  });

  it('maps typed errors and status codes without message substring guessing', () => {
    const provider = new ScriptedTestProvider();

    expect(provider.mapError(new ProviderHttpError(429, 'limited'))).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
    });
    expect(provider.mapError(new ProviderHttpError(401, 'do not expose credential'))).toEqual({
      kind: 'auth',
      retryable: false,
      detail: 'Provider authentication failed',
      status: 401,
    });
    expect(provider.mapError(new ProviderHttpError(400, 'bad'))).toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    });
    expect(provider.mapError(new ProviderHttpError(503, 'down'))).toMatchObject({
      kind: 'server',
      retryable: true,
    });
    expect(provider.mapError(new ProviderTimeoutError())).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    expect(provider.mapError(new Error('rate auth timeout 500'))).toMatchObject({
      kind: 'unknown',
      retryable: false,
    });
  });
});

describe('ScriptedTestProvider: zero-network boundary', () => {
  it('executes all public provider paths while fetch and network modules are denied', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => {
      throw new Error('ScriptedTestProvider attempted fetch');
    });
    try {
      const messages = [msg('user', 'mapped')];
      const provider = new ScriptedTestProvider({
        queue: [response('queued'), response('streamed')],
        map: { [hashMessages(messages)]: response('mapped') },
      });

      expect(provider.checkHealth()).toBe('healthy');
      expect(provider.validateDataPolicy(request(messages))).toEqual({ allowed: true });
      provider.normalizeRequest(request(messages));
      provider.parseResponse({ content: 'parsed' });
      provider.normalizeToolCall({ id: 'tool-1', name: 'read', arguments: {} });
      provider.meterUsage(response('metered'));
      provider.mapError(new Error('unknown'));
      provider.resolve(request(messages));
      provider.resolve(request([msg('user', 'queue')]));
      for await (const _event of provider.streamEvents(request([msg('user', 'stream')]))) {
        // Exhaust the deterministic local stream.
      }

      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('ScriptedTestProvider: validation and taxonomy boundaries', () => {
  it('publishes stable typed error identities and validates HTTP status bounds', () => {
    expect(new ProviderValidationError('invalid')).toMatchObject({
      name: 'ProviderValidationError',
      message: 'invalid',
    });
    expect(new ProviderHttpError(429)).toMatchObject({
      name: 'ProviderHttpError',
      status: 429,
      message: 'Provider returned HTTP 429',
    });
    expect(new ProviderTimeoutError()).toMatchObject({
      name: 'ProviderTimeoutError',
      message: 'Provider request timed out',
    });
    expect(new ScriptedResponseExhaustedError()).toMatchObject({
      name: 'ScriptedResponseExhaustedError',
      message: 'Scripted response queue exhausted: no response remains',
    });
    const missing = new ScriptedResponseMissingError('a'.repeat(64));
    expect(missing).toMatchObject({
      name: 'ScriptedResponseMissingError',
      key: 'a'.repeat(64),
      message: `Scripted response missing for input hash ${'a'.repeat(64)}`,
    });

    for (const invalid of [99, 600, 1.5, Number.NaN]) {
      expect(() => new ProviderHttpError(invalid)).toThrow(
        'Provider HTTP status must be an integer from 100 through 599',
      );
    }
    expect(new ProviderHttpError(100).status).toBe(100);
    expect(new ProviderHttpError(599).status).toBe(599);
  });

  it.each(['assistant', 'system', 'tool', 'user'] as const)(
    'accepts the supported %s message role',
    (role) => {
      expect(hashMessages([{ role, content: 'ok' }])).toMatch(/^[0-9a-f]{64}$/u);
    },
  );

  it.each([
    {
      value: [{ role: 'unsupported', content: 'x' }],
      message: 'messages[0].role is unsupported',
    },
    {
      value: [{ role: 'user', content: 1 }],
      message: 'messages[0].content must be a string',
    },
    {
      value: [{ role: 'tool', content: '', tool_call_id: '' }],
      message: 'messages[0].tool_call_id must be a non-empty string',
    },
    {
      value: [{ role: 'assistant', content: '', tool_calls: {} }],
      message: 'messages[0].tool_calls must be an array',
    },
    { value: {}, message: 'messages must be an array' },
  ])('rejects an invalid message boundary: $message', ({ value, message }) => {
    expect(() => hashMessages(value as unknown as Message[])).toThrow(message);
  });

  it('never coerces untrusted enum values through attacker-defined toString', () => {
    let roleCoerced = false;
    const role = {
      toString() {
        roleCoerced = true;
        return 'user';
      },
    };
    expect(() => hashMessages([{ role, content: 'x' }] as unknown as Message[])).toThrow(
      'messages[0].role is unsupported',
    );
    expect(roleCoerced).toBe(false);

    let stopCoerced = false;
    const stopReason = {
      toString() {
        stopCoerced = true;
        return 'stop';
      },
    };
    const provider = new ScriptedTestProvider();
    expect(() => provider.parseResponse({ content: 'x', stop_reason: stopReason })).toThrow(
      'response.stop_reason is unsupported',
    );
    expect(stopCoerced).toBe(false);
  });

  it('accepts null-prototype JSON objects and rejects non-finite nested JSON', () => {
    const provider = new ScriptedTestProvider();
    const argumentsWithoutPrototype = Object.create(null) as Record<string, unknown>;
    argumentsWithoutPrototype.path = '/safe';
    expect(
      provider.normalizeToolCall({
        id: 'tool-1',
        name: 'read_file',
        arguments: argumentsWithoutPrototype,
      }).arguments,
    ).toEqual({ path: '/safe' });

    expect(() =>
      provider.normalizeRequest({
        messages: [],
        tools: [{ name: 'tool', effect_model: { invalid: Number.POSITIVE_INFINITY } }],
      }),
    ).toThrow('request.tools[0].effect_model.invalid must contain only finite JSON numbers');
  });

  it('rejects invalid map hashes and invalid clocks before recording calls', () => {
    expect(
      () => new ScriptedTestProvider({ map: { short: response('invalid') } }),
    ).toThrow('response map keys must be lowercase SHA-256 hashes');
    expect(
      () => new ScriptedTestProvider({ map: { ['A'.repeat(64)]: response('invalid') } }),
    ).toThrow('response map keys must be lowercase SHA-256 hashes');

    const invalidClock = new ScriptedTestProvider({
      queue: [response('x')],
      now: () => new Date(Number.NaN),
    });
    expect(() => invalidClock.resolve(request([]))).toThrow('clock must return a valid Date');
    expect(invalidClock.callCount).toBe(0);
  });

  it.each([
    { value: null, message: 'request must be an object' },
    {
      value: { messages: [], extra: true },
      message: 'request contains unknown field: extra',
    },
    { value: { messages: {} }, message: 'messages must be an array' },
    { value: { messages: [], tools: {} }, message: 'request.tools must be an array' },
    {
      value: { messages: [], tools: [null] },
      message: 'request.tools[0] must be an object',
    },
    {
      value: { messages: [], tools: [{ name: '' }] },
      message: 'request.tools[0].name must be a non-empty string',
    },
    {
      value: { messages: [], temperature: -0.1 },
      message: 'request.temperature must be between 0 and 2',
    },
    {
      value: { messages: [], temperature: 2.1 },
      message: 'request.temperature must be between 0 and 2',
    },
    {
      value: { messages: [], temperature: Number.NaN },
      message: 'request.temperature must be between 0 and 2',
    },
    {
      value: { messages: [], max_tokens: 0 },
      message: 'request.max_tokens must be a positive integer',
    },
    {
      value: { messages: [], max_tokens: 1.5 },
      message: 'request.max_tokens must be a positive integer',
    },
    {
      value: { messages: [], model: ' ' },
      message: 'request.model must be a non-empty string',
    },
  ])('rejects an invalid request boundary: $message', ({ value, message }) => {
    const provider = new ScriptedTestProvider();
    expect(() => provider.normalizeRequest(value as ProviderRequest)).toThrow(message);
  });

  it('preserves valid request boundary values', () => {
    const provider = new ScriptedTestProvider();
    expect(
      provider.normalizeRequest({ messages: [], temperature: 2, max_tokens: 1 }),
    ).toMatchObject({ temperature: 2, max_tokens: 1 });
  });

  it.each(['content_filter', 'length', 'stop', 'tool_use'] as const)(
    'accepts and preserves stop_reason=%s',
    (stopReason) => {
      const provider = new ScriptedTestProvider();
      expect(provider.parseResponse({ content: '', stop_reason: stopReason }).stop_reason).toBe(
        stopReason,
      );
    },
  );

  it('uses deterministic response defaults and omits empty stream events', async () => {
    const provider = new ScriptedTestProvider({ queue: [{ content: '' }] });
    expect(provider.parseResponse({ content: '' })).toEqual({
      content: '',
      stop_reason: 'stop',
      model: 'scripted-test',
    });
    const events = [];
    for await (const event of provider.streamEvents(request([]))) events.push(event);
    expect(events).toEqual([
      {
        type: 'message_stop',
        stop_reason: 'stop',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    expect(provider.callCount).toBe(1);
  });

  it('maps every explicit error branch including boundary HTTP statuses', () => {
    const provider = new ScriptedTestProvider();
    const validation = new ProviderValidationError('bad fixture');
    const exhausted = new ScriptedResponseExhaustedError();
    const missing = new ScriptedResponseMissingError('b'.repeat(64));

    expect(provider.mapError(validation)).toEqual({
      kind: 'invalid_request',
      retryable: false,
      detail: 'bad fixture',
    });
    expect(provider.mapError(exhausted).kind).toBe('invalid_request');
    expect(provider.mapError(missing).kind).toBe('invalid_request');
    expect(provider.mapError(new ProviderHttpError(403))).toEqual({
      kind: 'auth',
      retryable: false,
      detail: 'Provider authentication failed',
      status: 403,
    });
    expect(provider.mapError(new ProviderHttpError(408))).toEqual({
      kind: 'timeout',
      retryable: true,
      detail: 'Provider request timed out',
      status: 408,
    });
    expect(provider.mapError(new ProviderHttpError(500))).toEqual({
      kind: 'server',
      retryable: true,
      detail: 'Provider server error (500)',
      status: 500,
    });
    expect(provider.mapError(new ProviderHttpError(418))).toEqual({
      kind: 'invalid_request',
      retryable: false,
      detail: 'Provider rejected request (418)',
      status: 418,
    });
    expect(provider.mapError(new ProviderHttpError(100))).toEqual({
      kind: 'unknown',
      retryable: false,
      detail: 'Unexpected provider HTTP status (100)',
      status: 100,
    });
    expect(provider.mapError(new Error('arbitrary'))).toEqual({
      kind: 'unknown',
      retryable: false,
      detail: 'Unknown provider failure',
    });
  });

  it.each([
    { value: null, message: 'dataPolicy must be an object' },
    { value: {}, message: 'dataPolicy.allowed must be a boolean' },
    {
      value: { allowed: true, extra: true },
      message: 'dataPolicy contains unknown field: extra',
    },
    {
      value: { allowed: true, reason: 1 },
      message: 'dataPolicy.reason must be a string',
    },
  ])('rejects an invalid data policy: $message', ({ value, message }) => {
    expect(
      () => new ScriptedTestProvider({ dataPolicy: value as DataPolicyResult }),
    ).toThrow(message);
  });

  it('deep-copies, preserves and freezes a configured data policy reason', () => {
    const policy: { allowed: boolean; reason?: string } = {
      allowed: false,
      reason: 'local fixture denied',
    };
    const provider = new ScriptedTestProvider({ dataPolicy: policy });
    policy.reason = 'mutated';
    const result = provider.validateDataPolicy(request([]));
    expect(result).toEqual({ allowed: false, reason: 'local fixture denied' });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
