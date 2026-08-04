import { describe, expect, it } from 'vitest';
import { behaviorVerify, ToolUnavailableError } from '../../../packages/tools/src/index.js';

describe('AH-TOOL-BEHAVIOR-VERIFY-001: Behavior verify returns typed unavailable', () => {
  it('throws typed unavailable when Playwright not configured', async () => {
    await expect(behaviorVerify({ url: 'http://example.com', steps: [], assertions: [] }))
      .rejects.toThrow(ToolUnavailableError);
  });
});
