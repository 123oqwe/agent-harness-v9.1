/**
 * PDF document parser — AH-DOC-INGEST-PDF-001.
 *
 * Extracts text from PDF files with page references. Uses a lightweight
 * approach: parses PDF content streams to extract text operators and
 * tracks page boundaries via /Type /Page markers.
 *
 * No external dependencies; handles unencrypted PDFs only. Encrypted PDFs
 * return typed DocumentIngestError('encrypted').
 */
import type {
  DocumentFormat, DocumentIngestOptions, DocumentIngestResult,
  DocumentParser, PageReference, SourceProvenance,
} from '../types.js';
import { DocumentIngestError } from '../types.js';
import { sha256Hex } from './markdown-parser.js';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'pdf-native';

function extractPdfText(content: Buffer): { text: string; pages: PageReference[] } {
  const pages: PageReference[] = [];
  let text = '';
  // Find all page object boundaries via /Type /Page (not /Pages)
  const pageRe = /\/Type\s*\/Page[^s]/g;
  const pageStarts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = pageRe.exec(content.toString("latin1"))) !== null) {
    pageStarts.push(m.index);
  }
  if (pageStarts.length === 0) {
    // Fallback: extract text from entire content stream
    text = extractTextFromStream(content);
    return { text, pages: [] };
  }
  for (let i = 0; i < pageStarts.length; i++) {
    const start = pageStarts[i]!;
    const end = i + 1 < pageStarts.length ? pageStarts[i + 1]! : content.length;
    const pageContent = content.subarray(start, end);
    const pageText = extractTextFromStream(pageContent);
    if (text) text += '\n\n--- Page Break ---\n\n';
    const startOffset = text.length;
    text += pageText;
    pages.push({ page: i + 1, start_offset: startOffset, end_offset: text.length });
  }
  return { text, pages };
}

function extractTextFromStream(buf: Buffer): string {
  const str = buf.toString('latin1');
  let result = '';
  // Extract text from Tj and TJ operators
  // Simple text: (text) Tj
  const tjRe = /\(([^)]*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tjRe.exec(str)) !== null) {
    result += unescapePdfString(m[1]!) + ' ';
  }
  // Array text: [(t1) (t2) ...] TJ
  const tjArrayRe = /\[([^\]]*)\]\s*TJ/g;
  while ((m = tjArrayRe.exec(str)) !== null) {
    const inner = m[1]!;
    const textParts = inner.match(/\(([^)]*)\)/g);
    if (textParts) {
      for (const part of textParts) {
        result += unescapePdfString(part.slice(1, -1));
      }
      result += ' ';
    }
  }
  return result.trim();
}

function unescapePdfString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

export class PdfParser implements DocumentParser {
  readonly format: DocumentFormat = 'pdf';
  readonly version = PARSER_VERSION;
  readonly name = PARSER_NAME;

  canHandle(format: DocumentFormat): boolean {
    return format === 'pdf';
  }

  async parse(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    const maxBytes = options.max_bytes ?? 100 * 1024 * 1024;
    if (content.byteLength > maxBytes) {
      throw new DocumentIngestError(
        `pdf file exceeds max bytes (${content.byteLength} > ${maxBytes})`,
        'too_large',
      );
    }
    // Check PDF signature
    if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new DocumentIngestError(
        `corrupted PDF file (missing %PDF- header): ${source_path}`,
        'corrupted',
      );
    }
    // Check for encryption
    const encRe = /\/Encrypt\s+\d+\s+0\s+R/;
    if (encRe.test(content.toString('latin1'))) {
      throw new DocumentIngestError(
        `encrypted PDF file requires password: ${source_path}`,
        'encrypted',
      );
    }
    const { text, pages } = extractPdfText(content);
    const provenance: SourceProvenance = {
      source_path,
      format: 'pdf',
      parser_version: PARSER_VERSION,
      parser_name: PARSER_NAME,
      ingested_at: new Date().toISOString(),
      content_hash: sha256Hex(content),
      byte_size: content.byteLength,
    };
    return {
      provenance, text, headings: [], tables: [], images: [],
      pages: pages.length > 0 ? pages : undefined,
      metadata: {},
    };
  }
}
