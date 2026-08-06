import { describe, expect, it, afterEach } from 'vitest';
import { webSearch, setWebSearchProvider, ToolUnavailableError, type WebSearchProvider } from '../../../packages/tools/src/index.js';

const mockProvider: WebSearchProvider = {
  async search(query: string, maxResults: number) {
    const results = [];
    for (let i = 0; i < Math.min(maxResults, 3); i++) {
      results.push({
        url: `https://example.com/${i}?q=${encodeURIComponent(query)}`,
        title: `Result ${i} for ${query}`,
        snippet: `Snippet about ${query} (result ${i})`,
      });
    }
    return results;
  },
};

describe('AH-TOOL-WEB-SEARCH-001: Web search tool returning ranked results', () => {
  afterEach(() => setWebSearchProvider(undefined));

  it('throws typed unavailable when no provider is configured', async () => {
    await expect(webSearch({ query: 'test' })).rejects.toThrow(ToolUnavailableError);
    try {
      await webSearch({ query: 'test' });
    } catch (e) {
      expect(e).toBeInstanceOf(ToolUnavailableError);
      expect((e as ToolUnavailableError).tool_name).toBe('web_search');
      expect((e as ToolUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('returns ranked results with a configured provider', async () => {
    setWebSearchProvider(mockProvider);
    const result = await webSearch({ query: 'TypeScript testing' });
    expect(result.success).toBe(true);
    const output = result.output as { results: Array<{ url: string; title: string; snippet: string }> };
    expect(output.results).toHaveLength(3);
    expect(output.results[0]!.url).toContain('example.com');
    expect(output.results[0]!.title).toContain('TypeScript testing');
    expect(output.results[0]!.snippet).toContain('TypeScript testing');
  });

  it('respects max_results option', async () => {
    setWebSearchProvider(mockProvider);
    const result = await webSearch({ query: 'test', max_results: 1 });
    expect(result.success).toBe(true);
    const output = result.output as { results: unknown[] };
    expect(output.results).toHaveLength(1);
  });

  it('defaults max_results to 10 when not specified', async () => {
    let capturedMax: number | undefined;
    setWebSearchProvider({
      async search(_query: string, maxResults: number) {
        capturedMax = maxResults;
        return [];
      },
    });
    await webSearch({ query: 'test' });
    expect(capturedMax).toBe(10);
  });

  it('returns empty results array when provider finds nothing', async () => {
    setWebSearchProvider({ async search() { return []; } });
    const result = await webSearch({ query: 'nonexistent' });
    expect(result.success).toBe(true);
    expect((result.output as { results: unknown[] }).results).toHaveLength(0);
  });
});
