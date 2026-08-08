import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAsyncTaskAdapter, getSeedanceTaskConfig } from '../../gateway/async-task-adapter.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import type { ModelBinding } from '../../gateway/capability-registry.js';

function makeBinding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  const registry = new CapabilityRegistry();
  const all = registry.listAll();
  // Find a seedance binding
  const seedance = all.find(b => b.provider === 'seedance') ?? all[0]!;
  return { ...seedance, ...overrides };
}

function mockFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
  let idx = 0;
  return vi.fn(async () => {
    const resp = responses[idx] ?? responses[responses.length - 1]!;
    idx++;
    return resp;
  }) as any;
}

function makeSubmitResponse(taskId: string): Response {
  return {
    ok: true, status: 200,
    json: async () => ({ id: taskId }),
    text: async () => JSON.stringify({ id: taskId }),
    headers: new Headers(),
  } as Response;
}

function makePollResponse(status: string, progress: number, videoUrl?: string, duration?: number): Response {
  const body: Record<string, unknown> = { status, progress };
  if (videoUrl) body['content'] = { video_url: videoUrl };
  if (duration !== undefined) (body['content'] as Record<string, unknown>)['duration'] = duration;
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as Response;
}

function makeErrorResponse(status: number, message: string): Response {
  return {
    ok: false, status,
    json: async () => ({ error: message }),
    text: async () => message,
    headers: new Headers(),
  } as Response;
}

describe('createAsyncTaskAdapter normalizeRequest', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  

  

  it('normalizeRequest returns the submit body', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const body = adapter.normalizeRequest({
      messages: [{ role: 'user', content: 'generate video' }],
      temperature: 0.5,
      max_tokens: 100,
    } as any) as Record<string, unknown>;
    expect(body['model']).toBe(binding.model_id);
    expect(body['content']).toBeDefined();
    expect(body['parameters']).toBeDefined();
  });
});

describe('createAsyncTaskAdapter resolve', () => {
  // Override pollIntervalMs to 0 for fast testing
  const originalConfig = getSeedanceTaskConfig;

  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  

  

  it('resolve submits and polls until success', () => {
    // Full resolve polling test is in async-task-adapter-deep.test.ts
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({ api_base: 'https://api.test.com' });
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    expect(adapter).toBeDefined();
    expect(adapter.provider_type).toBe('openai');
  });

  it('resolve throws on failed status', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({ api_base: 'https://api.test.com' });
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    globalThis.fetch = (mockFetchSequence([
      makeSubmitResponse('task-fail'),
      makePollResponse('failed', 0),
    ]) as any);
    await expect(adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any)).rejects.toThrow(/failed/);
  });

  it('resolve throws on error status', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({ api_base: 'https://api.test.com' });
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    globalThis.fetch = (mockFetchSequence([
      makeSubmitResponse('task-err'),
      makePollResponse('error', 0),
    ]) as any);
    await expect(adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any)).rejects.toThrow(/failed/);
  });

  it('resolve throws on success without video_url', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({ api_base: 'https://api.test.com' });
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    globalThis.fetch = (mockFetchSequence([
      makeSubmitResponse('task-novideo'),
      makePollResponse('succeeded', 100),
    ]) as any);
    await expect(adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any)).rejects.toThrow(/no video_url/);
  });

  it('resolve throws on submit HTTP error', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({ api_base: 'https://api.test.com' });
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    globalThis.fetch = vi.fn(async () => makeErrorResponse(500, 'Server error')) as any;
    await expect(adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any)).rejects.toThrow(/HTTP 500/);
  });

  it('resolve throws on submit 429 rate limit', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({ api_base: 'https://api.test.com' });
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    globalThis.fetch = vi.fn(async () => makeErrorResponse(429, 'Rate limited')) as any;
    await expect(adapter.resolve({
      messages: [{ role: 'user', content: 'test' }],
    } as any)).rejects.toThrow(/429/);
  });
});

describe('createAsyncTaskAdapter parseResponse', () => {
  
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  

  it('parseResponse returns video URL as content', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.parseResponse({
      video_url: 'https://cdn.test.com/v.mp4',
      id: 'task-1',
      duration: 10,
    }) as any;
    expect(result.content).toBe('https://cdn.test.com/v.mp4');
    expect(result.stop_reason).toBe('stop');
    expect(result.task_status).toBe('succeeded');
    expect(result.task_progress).toBe(100);
    expect(result.media_url).toBe('https://cdn.test.com/v.mp4');
    expect(result.media_type).toBe('video');
    expect(result.duration_seconds).toBe(10);
  });

  it('parseResponse throws on missing video_url', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    expect(() => adapter.parseResponse({ id: 'task-1' })).toThrow(/no video_url/);
  });

  it('parseResponse handles videoUrl (camelCase) field', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.parseResponse({
      videoUrl: 'https://cdn.test.com/v2.mp4',
    }) as any;
    expect(result.content).toBe('https://cdn.test.com/v2.mp4');
  });
});

describe('createAsyncTaskAdapter mapError', () => {
  
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  

  it('mapError classifies auth errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.mapError(new Error('HTTP 401: unauthorized')) as any;
    expect(result.kind).toBe('auth');
    expect(result.retryable).toBe(false);
  });

  it('mapError classifies rate limit errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.mapError(new Error('HTTP 429: rate limited')) as any;
    expect(result.kind).toBe('rate_limited');
    expect(result.retryable).toBe(false);
  });

  it('mapError classifies timeout errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.mapError(new Error('operation timed out')) as any;
    expect(result.kind).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('mapError classifies server errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.mapError(new Error('HTTP 502: Bad Gateway')) as any;
    expect(result.kind).toBe('server');
    expect(result.retryable).toBe(true);
  });

  it('mapError classifies invalid request errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.mapError(new Error('HTTP 400: invalid request body')) as any;
    expect(result.kind).toBe('invalid_request');
    expect(result.retryable).toBe(false);
  });

  it('mapError classifies task failed errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.mapError(new Error('Seedance task failed')) as any;
    expect(result.kind).toBe('server');
    expect(result.retryable).toBe(false);
  });

  it('mapError classifies unknown errors', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.mapError(new Error('something unexpected')) as any;
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('mapError handles non-Error values', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.mapError('string error') as any;
    expect(result.kind).toBe('unknown');
    expect(result.detail).toBe('string error');
  });
});

describe('createAsyncTaskAdapter utility methods', () => {
  
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  

  it('normalizeToolCall throws', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    expect(() => adapter.normalizeToolCall({})).toThrow(/do not support tool calls/);
  });

  it('meterUsage returns zero usage', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const usage = adapter.meterUsage({} as any);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  it('checkHealth returns healthy when key exists', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    expect(adapter.checkHealth()).toBe('healthy');
  });

  it('checkHealth returns down when no key', () => {
    const keyVault = new KeyVault();
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    expect(adapter.checkHealth()).toBe('down');
  });

  it('validateDataPolicy returns allowed', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    const result = adapter.validateDataPolicy({ messages: [] } as any);
    expect(result.allowed).toBe(true);
  });
});

describe('createAsyncTaskAdapter streamEvents', () => {
  
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  

  it('streamEvents adapter is properly configured', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({ api_base: 'https://api.test.com' });
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    // streamEvents is covered by async-task-adapter-deep.test.ts
    expect(typeof adapter.streamEvents).toBe('function');
  });

  it('streamEvents throws on failed task', async () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding({ api_base: 'https://api.test.com' });
    const adapter = createAsyncTaskAdapter(binding, keyVault);
    globalThis.fetch = (mockFetchSequence([
      makeSubmitResponse('task-fail-stream'),
      makePollResponse('failed', 0),
    ]) as any);
    await expect(async () => {
      for await (const _ of adapter.streamEvents({
        messages: [{ role: 'user', content: 'test' }],
      } as any)) {
        // consume
      }
    }).rejects.toThrow(/failed/);
  });
});

describe('seedanceParseTaskStatus edge cases', () => {
  it('parses progress as string', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    const result = config.parseTaskStatus({ status: 'running', progress: '75' });
    expect(result.progress).toBe(75);
  });

  it('parses progress as invalid string (defaults to 50)', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    const result = config.parseTaskStatus({ status: 'running', progress: 'abc' });
    expect(result.progress).toBe(50);
  });

  it('parses content array with video_url', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    const result = config.parseTaskStatus({
      status: 'succeeded',
      content: [{ video_url: 'https://test.com/v.mp4', duration: 7 }],
    });
    expect(result.videoUrl).toBe('https://test.com/v.mp4');
    expect(result.duration).toBe(7);
  });

  it('parses content object with url field', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    const result = config.parseTaskStatus({
      status: 'succeeded',
      content: { url: 'https://test.com/v2.mp4' },
    });
    expect(result.videoUrl).toBe('https://test.com/v2.mp4');
  });

  it('falls back to top-level video_url', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    const result = config.parseTaskStatus({
      status: 'succeeded',
      video_url: 'https://test.com/top.mp4',
    });
    expect(result.videoUrl).toBe('https://test.com/top.mp4');
  });

  it('handles unknown status as progress 0', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    const result = config.parseTaskStatus({ status: 'unknown' });
    expect(result.progress).toBe(0);
  });

  it('handles task_status field as status', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    const result = config.parseTaskStatus({ task_status: 'queued' });
    expect(result.status).toBe('queued');
  });

  it('handles missing status as unknown', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    const result = config.parseTaskStatus({});
    expect(result.status).toBe('unknown');
  });

  it('throws on missing task_id in submit response', () => {
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const binding = makeBinding();
    const config = getSeedanceTaskConfig(binding);
    expect(() => config.parseTaskId({})).toThrow(/no task_id/);
    expect(() => config.parseTaskId({ id: '' })).toThrow(/no task_id/);
    expect(() => config.parseTaskId({ id: 123 })).toThrow(/no task_id/);
  });
});
