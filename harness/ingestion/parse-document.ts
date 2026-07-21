/** AH-TOOL-PARSE-001: Phase 1 parse_document tool. Extracts text from plain text/markdown. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface ParseDocumentInput { path: string; max_pages?: number }
export interface ParseDocumentPage { page: number; text: string }
export interface ParseDocumentOutput { path: string; pages: ParseDocumentPage[]; total_chars: number }

export async function parseDocument(vfs: VirtualFilesystem, input: ParseDocumentInput): Promise<ParseDocumentOutput> {
  const content = vfs.readText(input.path);
  // Phase 1: plain text + markdown. Split on form-feed (\f) as page boundary.
  const rawPages = content.split('\f');
  const maxPages = input.max_pages ?? rawPages.length;
  const pages = rawPages.slice(0, maxPages).map((text, i) => ({ page: i + 1, text }));
  return { path: input.path, pages, total_chars: content.length };
}
