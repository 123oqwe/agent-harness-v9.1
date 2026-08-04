import { describe, expect, it } from 'vitest';
import { webSearch, ToolUnavailableError } from '../../../packages/tools/src/index.js';

describe('AH-TOOL-WEB-SEARCH-001: Web search returns typed unavailable', () => {
  it('throws typed unavailable when no provider', async () => {
    await expect(webSearch({ query: 'test' })).rejects.toThrow(ToolUnavailableError);
  });
});
