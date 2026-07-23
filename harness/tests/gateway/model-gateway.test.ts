import { describe, it, expect, beforeEach } from 'vitest';
import { ModelGateway } from '../../gateway/model-gateway.js';
import { ScriptedTestProvider, ScriptedResponseExhaustedError } from '../../gateway/scripted-provider.js';

describe('AH-GATEWAY-001: ModelGateway', () => {
  let gateway: ModelGateway;
  let provider: ScriptedTestProvider;

  beforeEach(() => {
    provider = new ScriptedTestProvider({
      queue: [{ content: 'hello', stop_reason: 'stop', usage: { input_tokens: 5, output_tokens: 3 } }],
    });
    gateway = new ModelGateway([provider]);
  });

  it('registers a provider', () => {
    expect(gateway.list()).toContain('scripted_test');
  });

  it('resolves a registered provider', () => {
    const resolved = gateway.resolve('scripted_test');
    expect(resolved).toBe(provider);
  });

  it('throws on unregistered provider type', () => {
    expect(() => gateway.resolve('openai')).toThrow(/No provider registered/);
  });

  it('completes a request and returns response with usage', () => {
    const result = gateway.complete('scripted_test', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.response.content).toBe('hello');
    expect(result.usage.input_tokens).toBe(5);
    expect(result.usage.output_tokens).toBe(3);
    expect(result.provider_type).toBe('scripted_test');
    expect(result.retried).toBe(false);
  });

  it('tracks total usage across calls', () => {
    provider = new ScriptedTestProvider({
      queue: [
        { content: 'a', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: 'b', stop_reason: 'stop', usage: { input_tokens: 20, output_tokens: 10 } },
      ],
    });
    gateway = new ModelGateway([provider]);
    gateway.complete('scripted_test', { messages: [{ role: 'user', content: 'x' }] });
    gateway.complete('scripted_test', { messages: [{ role: 'user', content: 'y' }] });
    const usage = gateway.getTotalUsage('scripted_test');
    expect(usage.input_tokens).toBe(30);
    expect(usage.output_tokens).toBe(15);
  });

  it('records telemetry with metadata only (no content)', () => {
    gateway.complete('scripted_test', { messages: [{ role: 'user', content: 'secret-content' }] });
    const telemetry = gateway.getTelemetry();
    expect(telemetry.length).toBe(1);
    expect(telemetry[0].provider_type).toBe('scripted_test');
    expect(telemetry[0].input_tokens).toBe(5);
    // Telemetry must NOT contain request/response content
    expect(JSON.stringify(telemetry)).not.toContain('secret-content');
  });

  it('throws ScriptedResponseExhaustedError when queue runs out', () => {
    expect(() => gateway.complete('scripted_test', {
      messages: [{ role: 'user', content: 'first' }],
    })).not.toThrow(); // consumes the one response
    expect(() => gateway.complete('scripted_test', {
      messages: [{ role: 'user', content: 'second' }],
    })).toThrow(ScriptedResponseExhaustedError);
  });

  it('checks provider health', () => {
    expect(gateway.checkHealth('scripted_test')).toBe('healthy');
  });

  it('registers model profiles', () => {
    gateway.registerProfile({
      model_id: 'scripted-test',
      provider_type: 'scripted_test',
      max_input_tokens: 4096,
      max_output_tokens: 2048,
      supports_tools: true,
      supports_streaming: true,
    });
    expect(gateway.getProfile('scripted-test')).toBeDefined();
    expect(gateway.getProfile('scripted-test')?.max_input_tokens).toBe(4096);
  });

  it('all model calls go through gateway (no direct provider access)', () => {
    // The gateway is the single entry point. The provider's resolve()
    // is only called through gateway.complete(), never directly.
    const result = gateway.complete('scripted_test', {
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(result.response.content).toBe('hello');
    expect(provider.callCount).toBe(1);
  });
});
