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

export async function webSearch(_input: WebSearchInput): Promise<ToolResult> {
  // No search provider configured — return typed unavailable
  throw new ToolUnavailableError(
    'no web search provider configured',
    'web_search',
    'provider_unavailable',
  );
}
