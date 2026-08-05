/** AH-TOOL-009: parse_document - parse local formats and return text with anchors */
export interface ParseDocumentInput {
  path: string;
  format?: 'txt' | 'md' | 'json' | 'csv' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'html' | 'audio' | 'video';
  max_pages?: number;
}

export interface ParsedSection {
  page: number;
  text: string;
  source: string;
}

export interface ParseDocumentResult {
  path: string;
  format: string;
  sections: ParsedSection[];
  total_pages: number;
  total_chars: number;
  needs_external_parser?: boolean;
  external_parser?: string;
}

export function detectFormat(path: string): ParseDocumentInput['format'] {
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

export function parseDocument(content: string, input: ParseDocumentInput): ParseDocumentResult {
  const format = input.format ?? detectFormat(input.path);
  const maxPages = input.max_pages ?? 100;

  switch (format) {
    case 'json':
      return parseJson(content, input.path);
    case 'csv':
      return parseCsv(content, input.path);
    case 'md':
      return parseMarkdown(content, input.path, maxPages);
    case 'html':
      return parseHtml(content, input.path, maxPages);
    case 'pdf':
      return { path: input.path, format: 'pdf', sections: [], total_pages: 0, total_chars: 0, needs_external_parser: true, external_parser: 'pdf-parse' };
    case 'docx':
      return { path: input.path, format: 'docx', sections: [], total_pages: 0, total_chars: 0, needs_external_parser: true, external_parser: 'mammoth' };
    case 'pptx':
      return { path: input.path, format: 'pptx', sections: [], total_pages: 0, total_chars: 0, needs_external_parser: true, external_parser: 'pptxgenjs' };
    case 'xlsx':
      return { path: input.path, format: 'xlsx', sections: [], total_pages: 0, total_chars: 0, needs_external_parser: true, external_parser: 'exceljs' };
    case 'audio':
      return { path: input.path, format: 'audio', sections: [], total_pages: 0, total_chars: 0, needs_external_parser: true, external_parser: 'transcribe_audio' };
    case 'video':
      return { path: input.path, format: 'video', sections: [], total_pages: 0, total_chars: 0, needs_external_parser: true, external_parser: 'ffmpeg+transcribe_audio' };
    case 'txt':
    default:
      return parseText(content, input.path, maxPages);
  }
}

function parseHtml(content: string, path: string, maxPages: number): ParseDocumentResult {
  const text = content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return parseText(text, path, maxPages);
}

function parseText(content: string, path: string, maxPages: number): ParseDocumentResult {
  // Split by form feed or every 1000 chars as "pages"
  const pageBreak = '\f';
  const rawPages = content.split(pageBreak);
  const pages = rawPages.length > 0 ? rawPages : [content];
  const sections = pages.slice(0, maxPages).map((text, i) => ({
    page: i + 1,
    text,
    source: path,
  }));
  return {
    path,
    format: 'txt',
    sections,
    total_pages: pages.length,
    total_chars: content.length,
  };
}

function parseMarkdown(content: string, path: string, maxPages: number): ParseDocumentResult {
  // Split by ## headers as "pages"
  const sections: ParsedSection[] = [];
  const lines = content.split('\n');
  let currentPage = 0;
  let currentText: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ') && currentText.length > 0) {
      currentPage++;
      if (currentPage > maxPages) break;
      sections.push({ page: currentPage, text: currentText.join('\n'), source: path });
      currentText = [];
    }
    currentText.push(line);
  }

  if (currentText.length > 0 && sections.length < maxPages) {
    sections.push({ page: sections.length + 1, text: currentText.join('\n'), source: path });
  }

  return {
    path,
    format: 'md',
    sections,
    total_pages: sections.length,
    total_chars: content.length,
  };
}

function parseJson(content: string, path: string): ParseDocumentResult {
  const parsed = JSON.parse(content);
  const text = JSON.stringify(parsed, null, 2);
  return {
    path,
    format: 'json',
    sections: [{ page: 1, text, source: path }],
    total_pages: 1,
    total_chars: text.length,
  };
}

function parseCsv(content: string, path: string): ParseDocumentResult {
  const lines = content.split('\n').filter((l) => l.trim());
  const sections: ParsedSection[] = lines.map((line, i) => ({
    page: i + 1,
    text: line,
    source: path,
  }));
  return {
    path,
    format: 'csv',
    sections,
    total_pages: lines.length,
    total_chars: content.length,
  };
}
