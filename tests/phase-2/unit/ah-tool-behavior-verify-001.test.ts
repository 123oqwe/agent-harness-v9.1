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
});
