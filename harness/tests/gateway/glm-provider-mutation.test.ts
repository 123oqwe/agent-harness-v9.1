import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GlmProvider, GlmProviderError, glmProviderRuntime } from '../../gateway/glm-provider.js';
import { createGlmGateway } from '../../gateway/glm-gateway-bridge.js';
import type { ProviderRequest, ParsedResponse } from '../../gateway/scripted-provider.js';

describe('GlmProvider mutation-killing tests', () => {
  let origEnv: Record<string, string | undefined>;
  beforeEach(() => {
    origEnv = { ...process.env };
    process.env.GLM_API_KEY = 'test-key';
    process.env.GLM_MODEL = 'glm-5.2';
    process.env.GLM_REASONING_EFFORT = 'xhigh';
    delete process.env.GLM_ALLOW_REMOTE;
  });
  afterEach(() => { process.env = origEnv; });

  it('reads apiKey from env and is healthy', () => {
    const p = new GlmProvider();
    expect(p.checkHealth()).toBe('healthy');
  });
  it('returns down when API key not set', () => {
    delete process.env.GLM_API_KEY;
    const p = new GlmProvider();
    expect(p.checkHealth()).toBe('down');
  });
  it('provider_type is openai', () => { expect(new GlmProvider().provider_type).toBe('openai'); });
  it('normalizeRequest includes model from env', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }] }) as Record<string, unknown>;
    expect(n.model).toBe('glm-5.2');
    expect(n.reasoning_effort).toBe('xhigh');
  });
  it('normalizeRequest defaults reasoning_effort to xhigh', () => {
    delete process.env.GLM_REASONING_EFFORT;
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }] }) as Record<string, unknown>;
    expect(n.reasoning_effort).toBe('xhigh');
  });
  it('normalizeRequest includes messages', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hello' }] }) as { messages: unknown[] };
    expect(n.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
  it('normalizeRequest uses default temperature 0.1', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }] }) as { temperature: number };
    expect(n.temperature).toBe(0.1);
  });
  it('normalizeRequest uses provided temperature', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 }) as { temperature: number };
    expect(n.temperature).toBe(0.5);
  });
  it('normalizeRequest uses default max_tokens 4096', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }] }) as { max_tokens: number };
    expect(n.max_tokens).toBe(4096);
  });
  it('normalizeRequest uses provided max_tokens', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 2048 }) as { max_tokens: number };
    expect(n.max_tokens).toBe(2048);
  });
  it('normalizeRequest includes tools when provided', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read_file' }] }) as { tools: Array<{ type: string; function: { name: string } }> };
    expect(n.tools).toBeDefined();
    expect(n.tools[0]!.type).toBe('function');
    expect(n.tools[0]!.function.name).toBe('read_file');
  });
  it('normalizeRequest omits tools when empty', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [] }) as Record<string, unknown>;
    expect(n.tools).toBeUndefined();
  });
  it('normalizeRequest omits tools when undefined', () => {
    const n = new GlmProvider().normalizeRequest({ messages: [{ role: 'user', content: 'hi' }] }) as Record<string, unknown>;
    expect(n.tools).toBeUndefined();
  });
  it('parseResponse parses simple text', () => {
    const r = new GlmProvider().parseResponse({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, model: 'glm-5.2' });
    expect(r.content).toBe('hello');
    expect(r.stop_reason).toBe('stop');
    expect(r.model).toBe('glm-5.2');
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });
  it('parseResponse parses tool_calls', () => {
    const r = new GlmProvider().parseResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"/f"}' } }] }, finish_reason: 'tool_calls' }] });
    expect(r.tool_calls).toHaveLength(1);
    expect(r.tool_calls![0]!.name).toBe('read_file');
    expect(r.tool_calls![0]!.arguments).toEqual({ path: '/f' });
    expect(r.stop_reason).toBe('tool_use');
  });
  it('parseResponse maps length finish_reason', () => {
    expect(new GlmProvider().parseResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }).stop_reason).toBe('length');
  });
  it('parseResponse maps unknown finish_reason to stop', () => {
    expect(new GlmProvider().parseResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'unknown' }] }).stop_reason).toBe('stop');
  });
  it('parseResponse maps null finish_reason to stop', () => {
    expect(new GlmProvider().parseResponse({ choices: [{ message: { content: 'x' }, finish_reason: null }] }).stop_reason).toBe('stop');
  });
  it('parseResponse throws on no choices', () => {
    expect(() => new GlmProvider().parseResponse({})).toThrow(GlmProviderError);
    expect(() => new GlmProvider().parseResponse({ choices: [] })).toThrow(GlmProviderError);
  });
  it('parseResponse defaults content to empty', () => {
    expect(new GlmProvider().parseResponse({ choices: [{ message: {}, finish_reason: 'stop' }] }).content).toBe('');
  });
  it('parseResponse defaults usage to zeros', () => {
    expect(new GlmProvider().parseResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
  it('parseResponse uses response model', () => {
    expect(new GlmProvider().parseResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], model: 'custom' }).model).toBe('custom');
  });
  it('parseResponse falls back to provider model', () => {
    expect(new GlmProvider().parseResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }).model).toBe('glm-5.2');
  });
  it('parseResponse handles empty arguments string', () => {
    const r = new GlmProvider().parseResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 't', arguments: '' } }] }, finish_reason: 'tool_calls' }] });
    expect(r.tool_calls![0]!.arguments).toEqual({});
  });
  it('normalizeToolCall normalizes valid call', () => {
    const tc = new GlmProvider().normalizeToolCall({ id: 'c1', function: { name: 'tool', arguments: '{"a":1}' } });
    expect(tc.id).toBe('c1'); expect(tc.name).toBe('tool'); expect(tc.arguments).toEqual({ a: 1 });
  });
  it('normalizeToolCall throws on null', () => { expect(() => new GlmProvider().normalizeToolCall(null)).toThrow(GlmProviderError); });
  it('normalizeToolCall throws on missing id', () => { expect(() => new GlmProvider().normalizeToolCall({ function: { name: 'x' } })).toThrow(GlmProviderError); });
  it('normalizeToolCall throws on missing name', () => { expect(() => new GlmProvider().normalizeToolCall({ id: 'c1' })).toThrow(GlmProviderError); });
  it('normalizeToolCall defaults arguments to empty', () => {
    expect(new GlmProvider().normalizeToolCall({ id: 'c1', function: { name: 't' } }).arguments).toEqual({});
  });
  it('mapError maps auth 401', () => { const e = new GlmProvider().mapError(new Error('401 unauthorized')); expect(e.kind).toBe('auth'); expect(e.retryable).toBe(false); });
  it('mapError maps rate 429', () => { const e = new GlmProvider().mapError(new Error('429 rate')); expect(e.kind).toBe('rate_limited'); expect(e.retryable).toBe(true); });
  it('mapError maps timeout', () => { const e = new GlmProvider().mapError(new Error('timed out')); expect(e.kind).toBe('timeout'); expect(e.retryable).toBe(true); });
  it('mapError maps server 500', () => { const e = new GlmProvider().mapError(new Error('500 server')); expect(e.kind).toBe('server'); expect(e.retryable).toBe(true); });
  it('mapError maps 503', () => { const e = new GlmProvider().mapError(new Error('503 unavailable')); expect(e.kind).toBe('server'); expect(e.retryable).toBe(true); });
  it('mapError maps invalid 400', () => { const e = new GlmProvider().mapError(new Error('400 invalid')); expect(e.kind).toBe('invalid_request'); expect(e.retryable).toBe(false); });
  it('mapError maps unknown', () => { const e = new GlmProvider().mapError(new Error('weird')); expect(e.kind).toBe('unknown'); expect(e.retryable).toBe(false); });
  it('mapError maps non-Error', () => { const e = new GlmProvider().mapError('str'); expect(e.kind).toBe('unknown'); expect(e.detail).toBe('str'); });
  it('meterUsage returns usage from response', () => { expect(new GlmProvider().meterUsage({ content: 'x', usage: { input_tokens: 5, output_tokens: 3 } } as ParsedResponse)).toEqual({ input_tokens: 5, output_tokens: 3 }); });
  it('meterUsage defaults to zeros', () => { expect(new GlmProvider().meterUsage({ content: 'x' } as ParsedResponse)).toEqual({ input_tokens: 0, output_tokens: 0 }); });
  it('validateDataPolicy denies by default', () => { expect(new GlmProvider().validateDataPolicy({ messages: [] } as ProviderRequest).allowed).toBe(false); });
  it('validateDataPolicy allows when GLM_ALLOW_REMOTE true', () => { process.env.GLM_ALLOW_REMOTE = 'true'; expect(new GlmProvider().validateDataPolicy({ messages: [] } as ProviderRequest).allowed).toBe(true); });
  it('GlmProviderError has correct name and prototype', () => { const e = new GlmProviderError('x'); expect(e.name).toBe('GlmProviderError'); expect(e).toBeInstanceOf(Error); expect(e).toBeInstanceOf(GlmProviderError); });
  it('glmProviderRuntime returns bound functions', () => { const r = glmProviderRuntime(); expect(r.provider_type).toBe('openai'); expect(typeof r.normalizeRequest).toBe('function'); expect(typeof r.resolve).toBe('function'); });
});

describe('glm-gateway-bridge mutation-killing tests', () => {
  let origEnv: Record<string, string | undefined>;
  beforeEach(() => { origEnv = { ...process.env }; process.env.GLM_API_KEY = 'test-key'; process.env.GLM_MODEL = 'glm-5.2'; delete process.env.GLM_ALLOW_REMOTE; });
  afterEach(() => { process.env = origEnv; });
  it('createGlmGateway returns gateway, registry, usageMeter', () => { const r = createGlmGateway(); expect(r.gateway).toBeDefined(); expect(r.registry).toBeDefined(); expect(r.usageMeter).toBeDefined(); });
  it('registry has glm provider', () => { expect(createGlmGateway().registry.snapshot.providers[0]!.provider_id).toBe('glm'); });
  it('gateway hash matches registry', () => { const r = createGlmGateway(); expect(r.gateway.registrySnapshotHash).toBe(r.registry.snapshot.hash); });
  it('provider has text_reasoning capability', () => { expect(createGlmGateway().registry.snapshot.providers[0]!.capabilities).toContain('text_reasoning'); });
  it('provider has remote execution', () => { expect(createGlmGateway().registry.snapshot.providers[0]!.data_policy.execution).toBe('remote'); });
  it('provider has network required', () => { const p = createGlmGateway().registry.snapshot.providers[0]!; expect(p.network.required).toBe(true); expect(p.network.destination).toBe('https://open.bigmodel.cn'); });
  it('provider has credentials required', () => { const p = createGlmGateway().registry.snapshot.providers[0]!; expect(p.credentials.required).toBe(true); expect(p.credentials.audience).toBe('https://open.bigmodel.cn'); });
  it('provider pricing is USD 0.5/1.5', () => { const p = createGlmGateway().registry.snapshot.providers[0]!; expect(p.pricing.currency).toBe('USD'); expect(p.pricing.input_per_million).toBe(0.5); expect(p.pricing.output_per_million).toBe(1.5); });
  it('provider has 128k context', () => { expect(createGlmGateway().registry.snapshot.providers[0]!.max_context_tokens).toBe(128_000); });
  it('provider is healthy', () => { expect(createGlmGateway().registry.snapshot.providers[0]!.health).toBe('healthy'); });
  it('provider has structured_output and tool_calling', () => { const p = createGlmGateway().registry.snapshot.providers[0]!; expect(p.structured_output).toBe(true); expect(p.tool_calling).toBe(true); });
  it('provider data_policy regions include cn', () => { expect(createGlmGateway().registry.snapshot.providers[0]!.data_policy.regions).toContain('cn'); });
  it('provider training not allowed', () => { expect(createGlmGateway().registry.snapshot.providers[0]!.data_policy.training_allowed).toBe(false); });
  it('usageMeter records entries', async () => { const m = createGlmGateway().usageMeter; await m.record({ provider_id: 'glm', operation_id: 'op1', usage: { input_tokens: 1, output_tokens: 2 } }); expect(m.getRecords()).toHaveLength(1); });
  it('usageMeter getRecords returns copies', () => { const m = createGlmGateway().usageMeter; const r1 = m.getRecords(); const r2 = m.getRecords(); expect(r1).not.toBe(r2); });
});
