/** AH-DOC-VERTICAL-001: read doc -> extract -> summarize -> cite pages. */
// @ts-nocheck

import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { parseDocument } from './parse-document.js';

export interface DocVerticalInput { path: string; max_pages?: number | undefined }
export interface DocVerticalOutput {
  pages: { page: number; text: string }[];
  summary: string;
  citations: { page: number; excerpt: string }[];
  total_chars: number;
}

export async function runDocVertical(vfs: VirtualFilesystem, input: DocVerticalInput): Promise<DocVerticalOutput> {
  const parsed = await parseDocument(vfs, { path: input.path, max_pages: input.max_pages });
  // summarize: first 200 chars of each page
  const summary = parsed.pages.map(p => `p${p.page}: ${p.text.slice(0, 200)}`).join('\n');
  // citations: first sentence of each page
  const citations = parsed.pages.map(p => {
    const first = p.text.split(/[.!?]/)[0] ?? '';
    return { page: p.page, excerpt: first.trim().slice(0, 120) };
  });
  return { pages: parsed.pages, summary, citations, total_chars: parsed.total_chars };
}
