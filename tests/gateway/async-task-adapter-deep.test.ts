import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createProviderAdapter } from '../../gateway/provider-adapters.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry, type ModelBinding } from '../../gateway/capability-registry.js';

const originalFetch = globalThis.fetch;

function mockResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body), headers: new Headers(),
  } as Response;
}

function getSeedanceBinding(): ModelBinding {
  const cr = new CapabilityRegistry();
  return cr.listAll().find(b => b.provider === 'seedance' && b.model_id === 'seedance-1-0-pro')!;
}

function makeReq(): any {
  return { messages: [{ role: 'user', content: 'generate video' }], temperature: 0.3, max_tokens: 100 };
}

describe('async-task-adapter (Seedance)', () => {
  let kv: KeyVault;
  let binding: ModelBinding;

  beforeEach(() => {
    kv = new KeyVault();
    kv.addKey('seedance', 'test-seedance-key');
    binding = getSeedanceBinding();
  });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  // -- seedanceParseTaskId --

  it('parseTaskId extracts id field', async () => {
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockResp({ id: 'task-123', status: 'queued' })) as any;
    // Trigger via resolve which calls submitTask internally
    // We'll test via streamEvents which yields progress
    const events: any[] = [];
    const gen = adapter.streamEvents!(makeReq());
    // Mock poll to return succeeded immediately
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return mockResp({ id: 'task-123' });
      return mockResp({ status: 'succeeded', content: { video_url: 'https://example.com/v.mp4' } });
    }) as any;
    for await (const e of adapter.streamEvents!(makeReq())) { events.push(e); }
    expect(events.some(e => e.type === 'media_complete')).toBe(true);
  });

  // -- submitTask error handling --

  it('resolve throws on HTTP 429 from submit', async () => {
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockResp({ error: 'rate' }, 429)) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('HTTP 429 rate limited');
  });

  it('resolve throws on HTTP 500 from submit', async () => {
    const adapter = createProviderAdapter(binding, kv);
    globalThis.fetch = vi.fn(async () => mockResp({ error: 'server' }, 500)) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('HTTP 500');
  });

  it('resolve throws No API key when key missing', async () => {
    const kvNoKey = new KeyVault();
    const adapter = createProviderAdapter(binding, kvNoKey);
    globalThis.fetch = vi.fn(async () => mockResp({})) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('No API key for seedance');
  });

  // -- resolve success path --

  it('resolve returns video_url on succeeded', async () => {
    const adapter = createProviderAdapter(binding, kv);
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return mockResp({ id: 'task-abc' });
      return mockResp({ status: 'succeeded', content: { video_url: 'https://cdn.example.com/v.mp4', duration: 30 } });
    }) as any;
    const result = await adapter.resolve(makeReq());
    const r = result as unknown as Record<string, unknown>;
    expect(r['status']).toBe('succeeded');
    expect(r['video_url']).toBe('https://cdn.example.com/v.mp4');
    expect(r['duration']).toBe(30);
  });

  it('resolve throws when succeeded but no video_url', async () => {
    const adapter = createProviderAdapter(binding, kv);
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return mockResp({ id: 'task-xyz' });
      return mockResp({ status: 'succeeded' });
    }) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('no video_url');
  });

  it('resolve throws on failed status', async () => {
    const adapter = createProviderAdapter(binding, kv);
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return mockResp({ id: 'task-fail' });
      return mockResp({ status: 'failed' });
    }) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('failed');
  });

  // -- pollTask error handling --

  it('resolve throws on poll HTTP error', async () => {
    const adapter = createProviderAdapter(binding, kv);
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return mockResp({ id: 'task-poll-err' });
      return mockResp({ error: 'not found' }, 404);
    }) as any;
    await expect(adapter.resolve(makeReq())).rejects.toThrow('Poll HTTP 404');
  });

  // -- parseResponse --

  it('parseResponse extracts video_url and duration', () => {
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({ video_url: 'https://v.test/v.mp4', duration: 60, id: 't1' }) as any;
    expect(result.content).toBe('https://v.test/v.mp4');
    expect(result.stop_reason).toBe('stop');
    expect(result.task_id).toBe('t1');
    expect(result.media_url).toBe('https://v.test/v.mp4');
    expect(result.duration_seconds).toBe(60);
  });

  it('parseResponse throws when no video_url', () => {
    const adapter = createProviderAdapter(binding, kv);
    expect(() => adapter.parseResponse({ id: 't1' })).toThrow('no video_url');
  });

  it('parseResponse handles videoUrl (camelCase)', () => {
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.parseResponse({ videoUrl: 'https://v.test/camel.mp4' }) as any;
    expect(result.content).toBe('https://v.test/camel.mp4');
  });

  // -- normalizeToolCall --

  it('normalizeToolCall throws (async_task does not support tools)', () => {
    const adapter = createProviderAdapter(binding, kv);
    expect(() => adapter.normalizeToolCall({})).toThrow('do not support tool calls');
  });

  // -- mapError --

  it('mapError classifies auth errors', () => {
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('HTTP 401 unauthorized')) as any;
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('mapError classifies rate limit errors', () => {
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('HTTP 429 rate limited')) as any;
    expect(err.kind).toBe('rate_limited');
  });

  it('mapError classifies timeout errors', () => {
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('task timed out')) as any;
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('mapError classifies server errors', () => {
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('HTTP 500 server error')) as any;
    expect(err.kind).toBe('server');
  });

  it('mapError classifies invalid request errors', () => {
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('HTTP 400 invalid request')) as any;
    expect(err.kind).toBe('invalid_request');
  });

  it('mapError classifies task failed as server', () => {
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('Seedance task failed')) as any;
    expect(err.kind).toBe('server');
    expect(err.retryable).toBe(false);
  });

  it('mapError classifies unknown errors', () => {
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError(new Error('something weird')) as any;
    expect(err.kind).toBe('unknown');
  });

  it('mapError handles non-Error values', () => {
    const adapter = createProviderAdapter(binding, kv);
    const err = adapter.mapError('string error') as any;
    expect(err.kind).toBe('unknown');
    expect(err.detail).toBe('string error');
  });

  // -- meterUsage --

  it('meterUsage returns zero tokens', () => {
    const adapter = createProviderAdapter(binding, kv);
    const usage = adapter.meterUsage({} as any);
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  // -- checkHealth --

  it('checkHealth returns healthy when key present', () => {
    const adapter = createProviderAdapter(binding, kv);
    expect(adapter.checkHealth()).toBe('healthy');
  });

  it('checkHealth returns down when key missing', () => {
    const kvNoKey = new KeyVault();
    const adapter = createProviderAdapter(binding, kvNoKey);
    expect(adapter.checkHealth()).toBe('down');
  });

  // -- validateDataPolicy --

  it('validateDataPolicy always returns allowed', () => {
    const adapter = createProviderAdapter(binding, kv);
    const result = adapter.validateDataPolicy(makeReq());
    expect(result.allowed).toBe(true);
  });
});
