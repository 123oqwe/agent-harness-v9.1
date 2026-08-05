/** AH-TOOL-PARSE-001: Phase 1 parse_document tool. Extracts text from plain text/markdown. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export type ParseDocumentFormat = 'txt' | 'md' | 'json' | 'csv' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'html' | 'audio' | 'video';

export interface ParseDocumentInput { path: string; max_pages?: number | undefined; format?: ParseDocumentFormat }
export interface ParseDocumentPage { page: number; text: string }
export interface ParseDocumentOutput { path: string; pages: ParseDocumentPage[]; total_chars: number; format: string; needs_external_parser?: boolean | undefined; external_parser?: string | undefined }

export function detectFormat(path: string): ParseDocumentFormat {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'txt': return 'txt';
    case 'md': case 'markdown': return 'md';
    case 'json': return 'json';
    case 'csv': return 'csv';
    case 'pdf': return 'pdf';
    case 'docx': case 'doc': return 'docx';
    case 'pptx': case 'ppt': return 'pptx';
    case 'xlsx': case 'xls': return 'xlsx';
    case 'html': case 'htm': return 'html';
    case 'mp3': case 'wav': case 'flac': case 'aac': case 'ogg': case 'm4a': return 'audio';
    case 'mp4': case 'avi': case 'mov': case 'mkv': case 'webm': return 'video';
    default: return 'txt';
  }
}

export async function parseDocument(vfs: VirtualFilesystem, input: ParseDocumentInput): Promise<ParseDocumentOutput> {
  const content = vfs.readText(input.path);
  const format = input.format ?? detectFormat(input.path);
  const maxPages = input.max_pages ?? 100;

  // Binary formats require external parsers (P2-13/P2-22)
  const binaryFormats: ParseDocumentFormat[] = ['pdf', 'docx', 'pptx', 'xlsx', 'audio', 'video'];
  if (binaryFormats.includes(format)) {
    const parserMap: Record<string, string> = {
      pdf: 'pdf-parse', docx: 'mammoth', pptx: 'pptxgenjs', xlsx: 'exceljs',
     audio: 'transcribe_audio', video: 'ffmpeg+transcribe_audio',
   };
    const parser = parserMap[format];
    return parser === undefined
      ? { path: input.path, pages: [], total_chars: 0, format, needs_external_parser: true }
      : { path: input.path, pages: [], total_chars: 0, format, needs_external_parser: true, external_parser: parser };
 }

  // HTML: strip tags for text extraction
  if (format === 'html') {
    const text = content.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const rawPages = text.split('\f');
    const pages = rawPages.slice(0, maxPages).map((t, i) => ({ page: i + 1, text: t }));
    return { path: input.path, pages, total_chars: text.length, format };
  }

  // Markdown: split on ## headers
  if (format === 'md') {
    const lines = content.split('\n');
    const pages: ParseDocumentPage[] = [];
    let current: string[] = [];
    let pageNum = 0;
    for (const line of lines) {
      if (/^#{1,3} /.test(line) && current.length > 0) {
        pageNum++;
        if (pageNum > maxPages) break;
        pages.push({ page: pageNum, text: current.join('\n') });
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0 && pages.length < maxPages) pages.push({ page: pages.length + 1, text: current.join('\n') });
    return { path: input.path, pages, total_chars: content.length, format };
  }

  // JSON: pretty-print as single page
  if (format === 'json') {
    try {
      const parsed = JSON.parse(content);
      const text = JSON.stringify(parsed, null, 2);
      return { path: input.path, pages: [{ page: 1, text }], total_chars: text.length, format };
    } catch { /* fall through to text */ }
  }

  // CSV: each line is a page
  if (format === 'csv') {
    const lines = content.split('\n').filter(l => l.trim());
    const pages = lines.slice(0, maxPages).map((text, i) => ({ page: i + 1, text }));
    return { path: input.path, pages, total_chars: content.length, format };
  }

  // Default: plain text, split on form-feed
  const rawPages = content.split('\f');
  const pages = rawPages.slice(0, maxPages).map((text, i) => ({ page: i + 1, text }));
  return { path: input.path, pages, total_chars: content.length, format };
}
