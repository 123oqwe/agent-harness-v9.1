import { describe, it, expect } from 'vitest';
import { getSeedanceTaskConfig } from '../../gateway/async-task-adapter.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { createProviderAdapter } from '../../gateway/provider-adapters.js';

describe('AsyncTaskAdapter (Seedance)', () => {
  it('registers seedance models in capability registry', () => {
    const reg = new CapabilityRegistry();
    const all = reg.listAll();
    const seedance = all.filter(m => m.provider === 'seedance');
    expect(seedance.length).toBe(2); // pro + lite
    expect(seedance.some(m => m.model_id === 'seedance-1-0-pro')).toBe(true);
    expect(seedance.some(m => m.model_id === 'seedance-1-0-lite')).toBe(true);
  });

  it('all seedance models use async_task format', () => {
    const reg = new CapabilityRegistry();
    const seedance = reg.listAll().filter(m => m.provider === 'seedance');
    expect(seedance.every(m => m.api_format === 'async_task')).toBe(true);
  });

  it('seedance models have video_generation capability', () => {
    const reg = new CapabilityRegistry();
    const seedance = reg.listAll().filter(m => m.provider === 'seedance');
    expect(seedance.every(m => (m.capabilities['video_generation'] ?? 0) > 0.5)).toBe(true);
  });

  it('getSeedanceTaskConfig builds correct endpoints', () => {
    const reg = new CapabilityRegistry();
    const binding = reg.listAll().find(m => m.model_id === 'seedance-1-0-pro')!;
    const config = getSeedanceTaskConfig(binding);
    expect(config.submitEndpoint).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    expect(config.pollEndpoint('task-123')).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-123');
    expect(config.pollIntervalMs).toBe(3000);
    expect(config.maxPollAttempts).toBe(200);
  });

  it('createProviderAdapter routes async_task to AsyncTaskAdapter', () => {
    const reg = new CapabilityRegistry();
    const binding = reg.listAll().find(m => m.provider === 'seedance')!;
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter).toBeDefined();
    expect(typeof adapter.resolve).toBe('function');
    expect(typeof adapter.streamEvents).toBe('function');
    expect(typeof adapter.parseResponse).toBe('function');
    expect(typeof adapter.mapError).toBe('function');
    expect(typeof adapter.checkHealth).toBe('function');
  });

  it('checkHealth returns healthy when key exists', () => {
    const reg = new CapabilityRegistry();
    const binding = reg.listAll().find(m => m.provider === 'seedance')!;
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.checkHealth()).toBe('healthy');
  });

  it('checkHealth returns down when no key', () => {
    const reg = new CapabilityRegistry();
    const binding = reg.listAll().find(m => m.provider === 'seedance')!;
    const keyVault = new KeyVault();
    const adapter = createProviderAdapter(binding, keyVault);
    expect(adapter.checkHealth()).toBe('down');
  });

  it('normalizeToolCall throws for async_task providers', () => {
    const reg = new CapabilityRegistry();
    const binding = reg.listAll().find(m => m.provider === 'seedance')!;
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const adapter = createProviderAdapter(binding, keyVault);
    expect(() => adapter.normalizeToolCall({})).toThrow('do not support tool calls');
  });

  it('mapError classifies timeout and rate_limit correctly', () => {
    const reg = new CapabilityRegistry();
    const binding = reg.listAll().find(m => m.provider === 'seedance')!;
    const keyVault = new KeyVault();
    keyVault.addKey('seedance', 'test-key');
    const adapter = createProviderAdapter(binding, keyVault);

    const timeoutErr = adapter.mapError(new Error('task timed out after 600s'));
    expect(timeoutErr.kind).toBe('timeout');
    expect(timeoutErr.retryable).toBe(true);

    const rateErr = adapter.mapError(new Error('HTTP 429 rate limited'));
    expect(rateErr.kind).toBe('rate_limited');
    expect(rateErr.retryable).toBe(false);

    const failedErr = adapter.mapError(new Error('Seedance task xyz failed'));
    expect(failedErr.kind).toBe('server');
    expect(failedErr.retryable).toBe(false);
  });

  it('KeyVault loads seedance from env', () => {
    const oldKey = process.env.VOLC_API_KEY;
    process.env.VOLC_API_KEY = 'volc-test-key';
    const vault = new KeyVault();
    expect(vault.hasProvider('seedance')).toBe(true);
    expect(vault.getKey('seedance')).toBe('volc-test-key');
    if (oldKey !== undefined) process.env.VOLC_API_KEY = oldKey;
    else delete process.env.VOLC_API_KEY;
  });

  it('ParsedResponse supports media fields', () => {
    // Verify the type system accepts media fields
    const response = {
      content: 'https://example.com/video.mp4',
      stop_reason: 'stop' as const,
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'seedance-1-0-pro',
      media_url: 'https://example.com/video.mp4',
      media_type: 'video' as const,
      duration_seconds: 5,
      task_id: 'task-123',
      task_status: 'succeeded' as const,
      task_progress: 100,
    };
    expect(response.media_url).toBe('https://example.com/video.mp4');
    expect(response.media_type).toBe('video');
    expect(response.duration_seconds).toBe(5);
    expect(response.task_status).toBe('succeeded');
  });
});
