/**
 * AH-TOOL-BEHAVIOR-VERIFY-001: Playwright-based UI behavior verification.
 * Supports provider injection; falls back to typed unavailable when no provider configured.
 */
import type { ToolResult } from './types.js';
import { ToolUnavailableError } from './types.js';

interface BehaviorVerifyInput {
  url: string;
  steps: Array<{ action: string; selector?: string; value?: string }>;
  assertions: Array<{ type: string; selector?: string; expected?: string }>;
}

/** Provider port for behavior verification. Implementations drive a browser. */
export interface BehaviorVerifyProviderPort {
  verify(url: string, steps: BehaviorVerifyInput['steps'], assertions: BehaviorVerifyInput['assertions']): Promise<{
    passed: boolean;
    screenshot?: Buffer;
    failures: Array<{ assertion: string; actual: string }>;
    duration_ms: number;
  }>;
}

let behaviorVerifyProvider: BehaviorVerifyProviderPort | undefined;

/** Configure the behavior verification provider. */
export function setBehaviorVerifyProvider(provider: BehaviorVerifyProviderPort | undefined): void {
  behaviorVerifyProvider = provider;
}

export async function behaviorVerify(input: BehaviorVerifyInput): Promise<ToolResult> {
  if (!behaviorVerifyProvider) {
    throw new ToolUnavailableError(
      'Playwright not configured for behavior verification',
      'behavior_verify',
      'provider_unavailable',
    );
  }
  const result = await behaviorVerifyProvider.verify(input.url, input.steps, input.assertions);
  if (result.passed) {
    return {
      success: true,
      output: {
        passed: result.passed,
        failures: result.failures,
        duration_ms: result.duration_ms,
        has_screenshot: !!result.screenshot,
      },
    };
  }
  return {
    success: false,
    output: {
      passed: result.passed,
      failures: result.failures,
      duration_ms: result.duration_ms,
      has_screenshot: !!result.screenshot,
    },
    error: `${result.failures.length} assertion(s) failed`,
  };
}
