import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const schemaPath = path.resolve(__dirname, '../../../spec/contracts/provider-adapter.schema.json');

describe('AH-GATEWAY-TESTPROVIDER-001: ScriptedTestProvider', () => {
  it('provider-adapter schema exists and defines scripted_test type', async () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    expect(schema.properties.provider_type.enum).toContain('scripted_test');
  });

  it('schema requires all ProviderAdapter interface methods', async () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const required = schema.required;
    expect(required).toContain('normalize_request');
    expect(required).toContain('parse_response');
    expect(required).toContain('normalize_tool_call');
    expect(required).toContain('stream_events');
    expect(required).toContain('map_error');
    expect(required).toContain('meter_usage');
    expect(required).toContain('check_health');
    expect(required).toContain('validate_data_policy');
  });

  it('schema has additionalProperties: false', async () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    expect(schema.additionalProperties).toBe(false);
  });

  it('valid fixture has all required fields', async () => {
    const fixturePath = path.resolve(__dirname, '../../../spec/fixtures/phase-1/valid/provider-adapter.json');
    expect(fs.existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    for (const field of schema.required) {
      expect(fixture).toHaveProperty(field);
    }
  });

  it('invalid fixture is missing a required field', async () => {
    const fixturePath = path.resolve(__dirname, '../../../spec/fixtures/phase-1/invalid/provider-adapter.json');
    expect(fs.existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const missing = schema.required.filter((f: string) => !(f in fixture));
    expect(missing.length).toBeGreaterThan(0);
  });

  it('scripted_test provider_type is distinct from real providers', async () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const types = schema.properties.provider_type.enum;
    expect(types).toContain('scripted_test');
    expect(types).toContain('openai');
    expect(types).toContain('anthropic');
    expect(types.indexOf('scripted_test')).not.toBe(types.indexOf('openai'));
  });
});

// ---------------------------------------------------------------------------
// Implementation behavior tests (Phase 1 product code)
// ---------------------------------------------------------------------------

import {
  ScriptedTestProvider,
  ScriptedResponseExhaustedError,
  ScriptedResponseMissingError,
  __hashMessages,
  type ParsedResponse,
  type ProviderRequest,
  type Message,
} from '../../gateway/scripted-provider';
import { ModelGateway } from '../../gateway/model-gateway';

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

function res(content: string, extra: Partial<ParsedResponse> = {}): ParsedResponse {
  return { content, stop_reason: 'stop', ...extra };
}

function req(messages: Message[], tools: string[] = []): ProviderRequest {
  return {
    messages,
    tools: tools.map((name) => ({ name })),
  };
}

describe('ScriptedTestProvider: queue mode', () => {
  it('returns responses in order, one per call', async () => {
    const p = new ScriptedTestProvider({
      queue: [res('first'), res('second'), res('third')],
    });
    expect(p.resolve(req([msg('user', 'hi')])).content).toBe('first');
    expect(p.resolve(req([msg('user', 'hi')])).content).toBe('second');
    expect(p.resolve(req([msg('user', 'hi')])).content).toBe('third');
  });

  it('throws ScriptedResponseExhaustedError when queue is empty (no silent pass)', async () => {
    const p = new ScriptedTestProvider({ queue: [res('only')] });
    p.resolve(req([msg('user', 'hi')]));
    expect(() => p.resolve(req([msg('user', 'hi')]))).toThrow(ScriptedResponseExhaustedError);
  });

  it('decrements remainingQueueLength as responses are consumed', async () => {
    const p = new ScriptedTestProvider({ queue: [res('a'), res('b')] });
    expect(p.remainingQueueLength).toBe(2);
    p.resolve(req([msg('user', 'x')]));
    expect(p.remainingQueueLength).toBe(1);
    p.resolve(req([msg('user', 'x')]));
    expect(p.remainingQueueLength).toBe(0);
  });
});

describe('ScriptedTestProvider: map mode', () => {
  it('returns the response matching the input hash', async () => {
    const messages = [msg('user', 'what is 2+2?')];
    const key = __hashMessages(messages);
    const p = new ScriptedTestProvider({
      map: { [key]: res('4') },
    });
    expect(p.resolve(req(messages)).content).toBe('4');
  });

  it('returns different responses for different inputs deterministically', async () => {
    const a = [msg('user', 'hello')];
    const b = [msg('user', 'goodbye')];
    const p = new ScriptedTestProvider({
      map: {
        [__hashMessages(a)]: res('hi there'),
        [__hashMessages(b)]: res('bye now'),
      },
    });
    expect(p.resolve(req(a)).content).toBe('hi there');
    expect(p.resolve(req(b)).content).toBe('bye now');
    expect(p.resolve(req(a)).content).toBe('hi there');
  });

  it('throws ScriptedResponseMissingError when no map entry matches', async () => {
    const known = [msg('user', 'known')];
    const unknown = [msg('user', 'unknown')];
    const p = new ScriptedTestProvider({ map: { [__hashMessages(known)]: res('ok') } });
    expect(() => p.resolve(req(unknown))).toThrow(ScriptedResponseMissingError);
  });
});

describe('ScriptedTestProvider: call metadata', () => {
  it('records messages, tools requested, usage, and timestamps', async () => {
    const p = new ScriptedTestProvider({
      queue: [
        res('answer', { usage: { input_tokens: 10, output_tokens: 5 } }),
      ],
    });
    const messages = [msg('user', 'q')];
    p.resolve(req(messages, ['read_file', 'edit_file']));
    const log = p.callLog;
    expect(log.length).toBe(1);
    expect(log[0].messages).toEqual(messages);
    expect(log[0].tools_requested).toEqual(['read_file', 'edit_file']);
    expect(log[0].usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(log[0].index).toBe(0);
    expect(typeof log[0].timestamp).toBe('string');
    expect(log[0].lookup_mode).toBe('queue');
  });

  it('increments call index across multiple calls', async () => {
    const p = new ScriptedTestProvider({ queue: [res('a'), res('b')] });
    p.resolve(req([msg('user', '1')]));
    p.resolve(req([msg('user', '2')]));
    expect(p.callLog[0].index).toBe(0);
    expect(p.callLog[1].index).toBe(1);
    expect(p.callCount).toBe(2);
  });

  it('records lookup_mode as map for map hits', async () => {
    const m = [msg('user', 'mapped')];
    const p = new ScriptedTestProvider({ map: { [__hashMessages(m)]: res('hit') } });
    p.resolve(req(m));
    expect(p.callLog[0].lookup_mode).toBe('map');
  });
});

describe('ScriptedTestProvider: ProviderAdapter interface', () => {
  it('implements all eight required methods', async () => {
    const p = new ScriptedTestProvider({ queue: [res('x')] });
    expect(typeof p.normalizeRequest).toBe('function');
    expect(typeof p.parseResponse).toBe('function');
    expect(typeof p.normalizeToolCall).toBe('function');
    expect(typeof p.streamEvents).toBe('function');
    expect(typeof p.mapError).toBe('function');
    expect(typeof p.meterUsage).toBe('function');
    expect(typeof p.checkHealth).toBe('function');
    expect(typeof p.validateDataPolicy).toBe('function');
  });

  it('checkHealth returns healthy without network', async () => {
    const p = new ScriptedTestProvider();
    expect(p.checkHealth()).toBe('healthy');
  });

  it('validateDataPolicy allows by default', async () => {
    const p = new ScriptedTestProvider();
    expect(p.validateDataPolicy(req([msg('user', 'x')]))).toEqual({ allowed: true });
  });

  it('normalizeToolCall normalizes a provider tool call shape', async () => {
    const p = new ScriptedTestProvider();
    const tc = p.normalizeToolCall({ id: 'tc_1', name: 'read_file', arguments: { path: '/a' } });
    expect(tc).toEqual({ id: 'tc_1', name: 'read_file', arguments: { path: '/a' } });
  });

  it('mapError classifies exhausted queue as non-retryable invalid_request', async () => {
    const p = new ScriptedTestProvider();
    const err = p.mapError(new ScriptedResponseExhaustedError());
    expect(err.kind).toBe('invalid_request');
    expect(err.retryable).toBe(false);
  });

  it('mapError classifies rate-limit and auth messages', async () => {
    const p = new ScriptedTestProvider();
    expect(p.mapError(new Error('rate limit exceeded')).kind).toBe('rate_limited');
    expect(p.mapError(new Error('invalid api key 401')).kind).toBe('auth');
    expect(p.mapError(new Error('timeout waiting for response')).kind).toBe('timeout');
  });

  it('meterUsage returns usage and estimates output tokens when absent', async () => {
    const p = new ScriptedTestProvider();
    const u = p.meterUsage(res('hello world', { usage: { input_tokens: 3, output_tokens: 0 } }));
    expect(u.input_tokens).toBe(3);
    expect(u.output_tokens).toBeGreaterThan(0);
  });

  it('streamEvents emits text_delta then message_stop in order', async () => {
    const p = new ScriptedTestProvider({
      queue: [res('chunk', { tool_calls: [{ id: 't1', name: 'run', arguments: {} }] })],
    });
    const events: string[] = [];
    for await (const e of p.streamEvents(req([msg('user', 'go')]))) {
      events.push(e.type);
    }
    expect(events).toEqual(['text_delta', 'tool_call', 'message_stop']);
  });
});

describe('ScriptedTestProvider: ModelGateway injection', () => {
  it('is injectable via ModelGateway.resolve and drivable via complete', async () => {
    const gw = new ModelGateway([new ScriptedTestProvider({ queue: [res('via-gw')] })]);
    const adapter = gw.resolve('scripted_test');
    expect(adapter).toBeInstanceOf(ScriptedTestProvider);
    expect((await gw.complete('scripted_test', req([msg('user', 'hi')]))).response.content).toBe('via-gw');
  });

  it('ModelGateway.resolve throws for an unregistered provider type', async () => {
    const gw = new ModelGateway();
    expect(() => gw.resolve('openai')).toThrow(/No provider registered/);
  });
});

describe('ScriptedTestProvider: zero network', () => {
  it('makes no fetch/http calls in any code path (smoke)', async () => {
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = () => {
      throw new Error('UNEXPECTED NETWORK CALL');
    };
    try {
      const p = new ScriptedTestProvider({ queue: [res('no-net')] });
      expect(p.checkHealth()).toBe('healthy');
      expect(p.resolve(req([msg('user', 'x')])).content).toBe('no-net');
      expect(p.validateDataPolicy(req([msg('user', 'x')])).allowed).toBe(true);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
    }
  });
});
