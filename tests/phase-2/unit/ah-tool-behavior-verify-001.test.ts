import { describe, expect, it, afterEach } from 'vitest';
import { behaviorVerify, setBehaviorVerifyProvider } from '../../../packages/tools/src/behavior-verify.js';
import type { BehaviorVerifyProviderPort } from '../../../packages/tools/src/behavior-verify.js';
import { ToolUnavailableError } from '../../../packages/tools/src/types.js';
import { Buffer } from 'node:buffer';

const mockProvider: BehaviorVerifyProviderPort = {
  async verify(url, steps, assertions) {
    const passed = steps.length > 0 && assertions.length > 0;
    const result: { passed: boolean; screenshot?: Buffer; failures: Array<{ assertion: string; actual: string }>; duration_ms: number } = {
      passed,
      failures: passed ? [] : [{ assertion: 'element visible', actual: 'not found' }],
      duration_ms: 150,
    };
    if (passed) result.screenshot = Buffer.from('screenshot-png-data');
    return result;
  },
};

describe('AH-TOOL-BEHAVIOR-VERIFY-001: Playwright-based UI behavior verification', () => {
  afterEach(() => setBehaviorVerifyProvider(undefined));

  it('throws typed unavailable when Playwright not configured', async () => {
    await expect(behaviorVerify({ url: 'http://example.com', steps: [], assertions: [] }))
      .rejects.toThrow(ToolUnavailableError);
    try {
      await behaviorVerify({ url: 'http://example.com', steps: [], assertions: [] });
    } catch (e) {
      expect(e).toBeInstanceOf(ToolUnavailableError);
      expect((e as ToolUnavailableError).tool_name).toBe('behavior_verify');
      expect((e as ToolUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('verifies passing behavior with a configured provider', async () => {
    setBehaviorVerifyProvider(mockProvider);
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'click', selector: '#btn' }],
      assertions: [{ type: 'visible', selector: '#result' }],
    });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.passed).toBe(true);
    expect(output.failures).toHaveLength(0);
    expect(output.has_screenshot).toBe(true);
    expect(output.duration_ms).toBe(150);
  });

  it('returns failure result when assertions fail', async () => {
    setBehaviorVerifyProvider(mockProvider);
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [],
      assertions: [],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('assertion(s) failed');
    const output = result.output as Record<string, unknown>;
    expect(output.passed).toBe(false);
    expect(output.has_screenshot).toBe(false);
  });

  it('passes url, steps, and assertions to the provider', async () => {
    let capturedUrl = '';
    let capturedSteps: unknown;
    let capturedAssertions: unknown;
    setBehaviorVerifyProvider({
      async verify(url, steps, assertions) {
        capturedUrl = url;
        capturedSteps = steps;
        capturedAssertions = assertions;
        return { passed: true, failures: [], duration_ms: 1 };
      },
    });
    await behaviorVerify({
      url: 'http://test.example.com',
      steps: [{ action: 'navigate' }],
      assertions: [{ type: 'title', expected: 'Test' }],
    });
    expect(capturedUrl).toBe('http://test.example.com');
    expect(capturedSteps).toHaveLength(1);
    expect(capturedAssertions).toHaveLength(1);
  });

  it('propagates provider errors without swallowing', async () => {
    setBehaviorVerifyProvider({
      async verify() { throw new Error('browser launch failed'); },
    });
    await expect(behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'click' }],
      assertions: [{ type: 'visible' }],
    })).rejects.toThrow('browser launch failed');
  });

  it('returns screenshot data when verification passes', async () => {
    setBehaviorVerifyProvider(mockProvider);
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'navigate' }],
      assertions: [{ type: 'title', expected: 'Test' }],
    });
    const output = result.output as Record<string, unknown>;
    expect(output.has_screenshot).toBe(true);
  });

  it('handles multiple steps and assertions', async () => {
    setBehaviorVerifyProvider(mockProvider);
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [
        { action: 'navigate' },
        { action: 'click', selector: '#btn1' },
        { action: 'click', selector: '#btn2' },
      ],
      assertions: [
        { type: 'visible', selector: '#result1' },
        { type: 'visible', selector: '#result2' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('records duration_ms from provider', async () => {
    setBehaviorVerifyProvider(mockProvider);
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'click' }],
      assertions: [{ type: 'visible' }],
    });
    const output = result.output as Record<string, unknown>;
    expect(output.duration_ms).toBe(150);
  });
});

  it('returns failures array with assertion and actual fields', async () => {
    setBehaviorVerifyProvider({
      async verify() {
        return {
          passed: false,
          failures: [
            { assertion: 'title matches', actual: 'got different title' },
            { assertion: 'element visible', actual: 'element not found' },
          ],
          duration_ms: 200,
        };
      },
    });
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'click' }],
      assertions: [{ type: 'title' }],
    });
    expect(result.success).toBe(false);
    const output = result.output as Record<string, unknown>;
    const failures = output.failures as Array<{ assertion: string; actual: string }>;
    expect(failures).toHaveLength(2);
    expect(failures[0]!.assertion).toBe('title matches');
    expect(failures[1]!.actual).toBe('element not found');
  });

  it('returns screenshot when provided even on failure', async () => {
    setBehaviorVerifyProvider({
      async verify() {
        return {
          passed: false,
          screenshot: Buffer.from('failure-screenshot'),
          failures: [{ assertion: 'test', actual: 'failed' }],
          duration_ms: 50,
        };
      },
    });
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'click' }],
      assertions: [{ type: 'visible' }],
    });
    const output = result.output as Record<string, unknown>;
    expect(output.has_screenshot).toBe(true);
  });

  it('returns has_screenshot=false when no screenshot on failure', async () => {
    setBehaviorVerifyProvider({
      async verify() {
        return {
          passed: false,
          failures: [{ assertion: 'test', actual: 'failed' }],
          duration_ms: 50,
        };
      },
    });
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'click' }],
      assertions: [{ type: 'visible' }],
    });
    const output = result.output as Record<string, unknown>;
    expect(output.has_screenshot).toBe(false);
  });

  it('error message includes failure count', async () => {
    setBehaviorVerifyProvider({
      async verify() {
        return {
          passed: false,
          failures: [
            { assertion: 'a', actual: 'b' },
            { assertion: 'c', actual: 'd' },
            { assertion: 'e', actual: 'f' },
          ],
          duration_ms: 100,
        };
      },
    });
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'click' }],
      assertions: [{ type: 'visible' }],
    });
    expect(result.error).toContain('3');
  });

  it('handles provider with zero duration', async () => {
    setBehaviorVerifyProvider({
      async verify() {
        return { passed: true, failures: [], duration_ms: 0 };
      },
    });
    const result = await behaviorVerify({
      url: 'http://example.com',
      steps: [{ action: 'click' }],
      assertions: [{ type: 'visible' }],
    });
    const output = result.output as Record<string, unknown>;
    expect(output.duration_ms).toBe(0);
  });

  it('passes step values to provider', async () => {
    let capturedSteps: unknown;
    setBehaviorVerifyProvider({
      async verify(_url, steps) {
        capturedSteps = steps;
        return { passed: true, failures: [], duration_ms: 1 };
      },
    });
    await behaviorVerify({
      url: 'http://example.com',
      steps: [
        { action: 'type', selector: '#input', value: 'hello world' },
        { action: 'click', selector: '#submit' },
      ],
      assertions: [{ type: 'visible', selector: '#result' }],
    });
    expect((capturedSteps as Array<{ value?: string }>)[0]!.value).toBe('hello world');
  });
