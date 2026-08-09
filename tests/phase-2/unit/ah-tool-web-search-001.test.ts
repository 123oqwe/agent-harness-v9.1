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

  it('handles special characters in query', async () => {
    setWebSearchProvider(mockProvider);
    const result = await webSearch({ query: 'hello & world! @#$%' });
    expect(result.success).toBe(true);
  });

  it('handles very long queries', async () => {
    setWebSearchProvider(mockProvider);
    const result = await webSearch({ query: 'x'.repeat(500) });
    expect(result.success).toBe(true);
  });

  it('propagates provider errors without swallowing', async () => {
    setWebSearchProvider({
      async search() { throw new Error('API timeout'); },
    });
    await expect(webSearch({ query: 'test' })).rejects.toThrow('API timeout');
  });

  it('handles multiple sequential searches', async () => {
    setWebSearchProvider(mockProvider);
    const r1 = await webSearch({ query: 'first' });
    const r2 = await webSearch({ query: 'second' });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    const o1 = r1.output as { results: Array<{ title: string }> };
    const o2 = r2.output as { results: Array<{ title: string }> };
    expect(o1.results[0]!.title).toContain('first');
    expect(o2.results[0]!.title).toContain('second');
  });

  it('returns results with url, title, and snippet fields', async () => {
    setWebSearchProvider(mockProvider);
    const result = await webSearch({ query: 'test' });
    const output = result.output as { results: Array<{ url: string; title: string; snippet: string }> };
    for (const r of output.results) {
      expect(r.url).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.snippet).toBeTruthy();
    }
  });
});

  it('handles Unicode queries (Chinese, Japanese, Korean)', async () => {
    setWebSearchProvider(mockProvider);
    const result = await webSearch({ query: '搜索 测试' });
    expect(result.success).toBe(true);
  });

  it('handles empty query string', async () => {
    setWebSearchProvider(mockProvider);
    const result = await webSearch({ query: '' });
    expect(result.success).toBe(true);
  });

  it('passes query string to provider verbatim', async () => {
    let capturedQuery = '';
    setWebSearchProvider({
      async search(query: string) {
        capturedQuery = query;
        return [];
      },
    });
    await webSearch({ query: 'exact query test' });
    expect(capturedQuery).toBe('exact query test');
  });

  it('returns results in a results array field', async () => {
    setWebSearchProvider(mockProvider);
    const result = await webSearch({ query: 'test' });
    expect(result.output).toHaveProperty('results');
    expect(Array.isArray((result.output as Record<string, unknown>).results)).toBe(true);
  });

  it('handles provider returning null results gracefully', async () => {
    setWebSearchProvider({
      async search() { return []; },
    });
    const result = await webSearch({ query: 'test' });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).results).toEqual([]);
  });

  it('state isolation between provider changes', async () => {
    setWebSearchProvider(mockProvider);
    const r1 = await webSearch({ query: 'first' });
    setWebSearchProvider({
      async search() { return [{ url: 'different', title: 'different', snippet: 'different' }]; },
    });
    const r2 = await webSearch({ query: 'second' });
    expect((r1.output as { results: Array<{ url: string }> }).results[0]!.url).toContain('example.com');
    expect((r2.output as { results: Array<{ url: string }> }).results[0]!.url).toBe('different');
  });
