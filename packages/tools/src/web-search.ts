/**
 * AH-TOOL-WEB-SEARCH-001: Web search tool returning ranked results.
 * Returns typed unavailable when no search provider is configured.
 */
import type { ToolResult } from './types.js';
import { ToolUnavailableError } from './types.js';

interface WebSearchInput {
  query: string;
  max_results?: number;
}

export interface WebSearchProvider {
  search(query: string, maxResults: number): Promise<Array<{ url: string; title: string; snippet: string }>>;
}

let webSearchProvider: WebSearchProvider | undefined;

/** Configure the web search provider. */
export function setWebSearchProvider(provider: WebSearchProvider | undefined): void {
  webSearchProvider = provider;
}

export async function webSearch(_input: WebSearchInput): Promise<ToolResult> {
  if (!webSearchProvider) {
    throw new ToolUnavailableError(
      'no web search provider configured',
      'web_search',
      'provider_unavailable',
    );
  }
  const results = await webSearchProvider.search(_input.query, _input.max_results ?? 10);
  return { success: true, output: { results } };
}
