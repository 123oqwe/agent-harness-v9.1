/** AH-DOC-VERTICAL-001: read doc -> extract -> LLM summarize -> cite pages. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { parseDocument } from './parse-document.js';

export interface DocVerticalInput { path: string; max_pages?: number }
export interface DocVerticalOutput {
  pages: { page: number; text: string }[];
  summary: string;
  citations: { page: number; excerpt: string }[];
  total_chars: number;
}

export type ModelCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export async function runDocVertical(
  vfs: VirtualFilesystem,
  input: DocVerticalInput,
  modelCall?: ModelCallFn,
): Promise<DocVerticalOutput> {
  const parsed = await parseDocument(vfs, { path: input.path, max_pages: input.max_pages });
  const fullText = parsed.pages.map(p => `[Page ${p.page}] ${p.text}`).join('\n\n');

  let summary: string;
  if (modelCall) {
    summary = await modelCall(
      'You are a document summarizer. Summarize the document concisely, citing page numbers as [Page N].',
      `Document:\n${fullText.slice(0, 8000)}`,
    );
  } else {
    summary = parsed.pages.map(p => `p${p.page}: ${p.text.slice(0, 200)}`).join('\n');
  }

  const citations = parsed.pages.map(p => {
    const first = p.text.split(/[.!?]/)[0] ?? '';
    return { page: p.page, excerpt: first.trim().slice(0, 120) };
  });
  return { pages: parsed.pages, summary, citations, total_chars: parsed.total_chars };
}
