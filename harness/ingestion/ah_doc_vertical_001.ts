/** AH-DOC-001: Document vertical - parse PDF, summarize, cite pages */
import { parseDocument } from './parse-document.js';

export interface DocVerticalInput {
  document_path: string;
  content: string;
  format?: 'txt' | 'md' | 'json' | 'csv';
}

export interface DocVerticalResult {
  summary: string;
  citations: { page: number; text: string }[];
  total_pages: number;
}

export function runDocVertical(input: DocVerticalInput): DocVerticalResult {
  const parsed = parseDocument(input.content, {
    path: input.document_path,
    format: input.format ?? 'txt',
  });

  const summary = parsed.sections.map((s) => s.text.slice(0, 100)).join(' ');
  const citations = parsed.sections.map((s) => ({ page: s.page, text: s.text.slice(0, 200) }));

  return { summary, citations, total_pages: parsed.total_pages };
}
