/**
 * HTML/Webpage parser — AH-DOC-INGEST-WEB-001.
 *
 * Extracts text content, headings, tables, and images from HTML.
 * No external dependencies; uses regex-based extraction.
 */
import type {
  DocumentFormat, DocumentIngestOptions, DocumentIngestResult,
  DocumentParser, HeadingNode, ImageReference, SourceProvenance, TableNode,
} from '../types.js';
import { DocumentIngestError } from '../types.js';
import { sha256Hex } from './markdown-parser.js';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'html-native';

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class HtmlParser implements DocumentParser {
  readonly format: DocumentFormat = 'html';
  readonly version = PARSER_VERSION;
  readonly name = PARSER_NAME;

  canHandle(format: DocumentFormat): boolean {
    return format === 'html';
  }

  async parse(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    const maxBytes = options.max_bytes ?? 50 * 1024 * 1024;
    if (content.byteLength > maxBytes) {
      throw new DocumentIngestError(
        `html file exceeds max bytes (${content.byteLength} > ${maxBytes})`,
        'too_large',
      );
    }
    const html = content.toString('utf8');
    const headings: HeadingNode[] = [];
    const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(html)) !== null) {
      headings.push({ level: parseInt(m[1]!, 10), text: stripTags(m[2]!) });
    }
    const tables: TableNode[] = [];
    const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    while ((m = tableRe.exec(html)) !== null) {
      const tableHtml = m[1]!;
      const rows: string[][] = [];
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch: RegExpExecArray | null;
      while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
        const cells: string[] = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cellMatch: RegExpExecArray | null;
        while ((cellMatch = cellRe.exec(rowMatch[1]!)) !== null) {
          cells.push(stripTags(cellMatch[1]!));
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) tables.push({ rows });
    }
    const images: ImageReference[] = [];
    const imgRe = /<img\s+[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*\/?>/gi;
    while ((m = imgRe.exec(html)) !== null) {
      images.push({ ref: m[1]!, alt: m[2] ?? '', source_path: m[1] });
    }
    const text = stripTags(html);
    const provenance: SourceProvenance = {
      source_path, format: 'html',
      parser_version: PARSER_VERSION, parser_name: PARSER_NAME,
      ingested_at: new Date().toISOString(),
      content_hash: sha256Hex(content), byte_size: content.byteLength,
    };
    return { provenance, text, headings, tables, images, metadata: {},
      pages: undefined };
  }
}
