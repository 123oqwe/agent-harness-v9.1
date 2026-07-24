import { describe, it, expect } from 'vitest';
import { ScriptedTestProvider, scriptedProviderContract, ProviderHttpError, ProviderTimeoutError, type ParsedResponse } from '../../gateway/scripted-provider.js';

describe('ScriptedProvider mutation kills', () => {
  it('isPlainRecord: rejects arrays as non-record (kills L155 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's', stop_reason: 'stop' }] });
    // parseResponse with array input should throw
    expect(() => p.parseResponse([])).toThrow();
  });

  it('isPlainRecord: rejects null as non-record', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    expect(() => p.parseResponse(null)).toThrow();
  });

  it('isPlainRecord: rejects string as non-record', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    expect(() => p.parseResponse('string')).toThrow();
  });

  it('isPlainRecord: rejects number as non-record', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    expect(() => p.parseResponse(42)).toThrow();
  });

  it('isPlainRecord: accepts plain object', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    const result = p.parseResponse({ content: 'ok', model: 's' });
    expect(result.content).toBe('ok');
  });

  it('cloneJson: rejects Infinity as non-finite number (kills L130 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    // Pass an object with Infinity in usage to trigger cloneJson
    const raw = { content: 'ok', model: 's', usage: { input_tokens: Infinity, output_tokens: 1 } };
    expect(() => p.parseResponse(raw)).toThrow();
  });

  it('cloneJson: rejects NaN as non-finite number (kills L132 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    const raw = { content: 'ok', model: 's', usage: { input_tokens: NaN, output_tokens: 1 } };
    expect(() => p.parseResponse(raw)).toThrow();
  });

  it('cloneJson: rejects nested array (kills L136 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    const raw = { content: 'ok', model: 's', usage: [1, 2] };
    expect(() => p.parseResponse(raw)).toThrow();
  });

  it('normalizeUsage: rejects null usage (kills L146 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    const raw = { content: 'ok', model: 's', usage: null };
    expect(() => p.parseResponse(raw)).toThrow();
  });

  it('normalizeUsage: rejects string usage (kills L179 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    const raw = { content: 'ok', model: 's', usage: 'invalid' };
    expect(() => p.parseResponse(raw)).toThrow();
  });

  it('normalizeUsage: rejects unknown keys in usage (kills L213 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    const raw = { content: 'ok', model: 's', usage: { input_tokens: 1, output_tokens: 1, extra: true } };
    expect(() => p.parseResponse(raw)).toThrow();
  });

  it('normalizeUsage: rejects missing input_tokens (kills L216 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    const raw = { content: 'ok', model: 's', usage: { output_tokens: 1 } };
    expect(() => p.parseResponse(raw)).toThrow();
  });

  it('normalizeToolCall: rejects null (kills L250 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    expect(() => p.normalizeToolCall(null)).toThrow();
  });

  it('normalizeToolCall: rejects object missing id (kills L251 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's' }] });
    expect(() => p.normalizeToolCall({ function: { name: 'test', arguments: '{}' } })).toThrow();
  });

  it('mapError: rate limited error returns retryable (kills L304 regex)', () => {
    const p = new ScriptedTestProvider({ queue: [] });
    const err = p.mapError(new ProviderHttpError(429, 'rate limited'));
    expect(err.kind).toBe('rate_limited');
    expect(err.retryable).toBe(true);
  });

  it('mapError: 401 auth error returns non-retryable (kills L329 block)', () => {
    const p = new ScriptedTestProvider({ queue: [] });
    const err = p.mapError(new ProviderHttpError(401, 'auth failed'));
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('mapError: 429 rate error returns retryable (kills L332 conditional)', () => {
    const p = new ScriptedTestProvider({ queue: [] });
    const err = p.mapError(new ProviderHttpError(429, 'too many requests'));
    expect(err.kind).toBe('rate_limited');
    expect(err.retryable).toBe(true);
  });

  it('callIndex increments on each resolve (kills L348 assignment)', () => {
    const p = new ScriptedTestProvider({ queue: [
      { content: 'first', model: 's', stop_reason: 'stop' },
      { content: 'second', model: 's', stop_reason: 'stop' },
    ] });
    const r1 = p.resolve({ messages: [] });
    const r2 = p.resolve({ messages: [] });
    expect(r1.content).toBe('first');
    expect(r2.content).toBe('second');
  });

  it('stop_reason: content_filter mapped correctly (kills L441 logical)', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's', stop_reason: 'content_filter' }] });
    const result = p.parseResponse({ content: 'ok', model: 's', stop_reason: 'content_filter' });
    expect(result.stop_reason).toBe('content_filter');
  });

  it('meterUsage: returns zero usage when response has no usage field', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'hello world', model: 's' }] });
    const result = p.resolve({ messages: [] });
    const usage = p.meterUsage(result);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  it('meterUsage: returns actual usage when provided in response', () => {
    const p = new ScriptedTestProvider({ queue: [{ content: 'ok', model: 's', usage: { input_tokens: 5, output_tokens: 3 } }] });
    const result = p.resolve({ messages: [] });
    const usage = p.meterUsage(result);
    expect(usage.input_tokens).toBe(5);
    expect(usage.output_tokens).toBe(3);
  });
});
