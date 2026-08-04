/**
 * Markdown document parser — AH-DOC-INGEST-MD-001.
 *
 * Parses heading hierarchy, tables, image references, and inline text
 * from Markdown source. No external dependencies required.
 */
import { createHash } from 'node:crypto';
import type {
  DocumentFormat,
  DocumentIngestOptions,
  DocumentIngestResult,
  DocumentParser,
  HeadingNode,
  ImageReference,
  SourceProvenance,
  TableNode,
} from '../types.js';
import { DocumentIngestError } from '../types.js';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'markdown-native';

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;
const TABLE_ROW_RE = /^\|(.+)\|$/gm;
const TABLE_SEPARATOR_RE = /^\|[\s:|-]+\|$/;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const HTML_IMG_RE = /<img\s+[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*\/?>/gi;

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function detectFormat(path: string): DocumentFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.pptx')) return 'pptx';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.match(/\.(png|jpg|jpeg|gif|bmp|webp|tiff?)$/)) return 'image';
  return 'unsupported';
}

export class MarkdownParser implements DocumentParser {
  readonly format: DocumentFormat = 'md';
  readonly version = PARSER_VERSION;
  readonly name = PARSER_NAME;

  canHandle(format: DocumentFormat): boolean {
    return format === 'md';
  }

  async parse(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    const maxBytes = options.max_bytes ?? 50 * 1024 * 1024;
    if (content.byteLength > maxBytes) {
      throw new DocumentIngestError(
        `markdown file exceeds max bytes (${content.byteLength} > ${maxBytes})`,
        'too_large',
      );
    }
    const text = content.toString('utf8');
    const headings = this.parseHeadings(text);
    const tables = this.parseTables(text);
    const images = this.parseImages(text);
    const provenance: SourceProvenance = {
      source_path,
      format: 'md',
      parser_version: PARSER_VERSION,
      parser_name: PARSER_NAME,
      ingested_at: new Date().toISOString(),
      content_hash: sha256Hex(content),
      byte_size: content.byteLength,
    };
    return { provenance, text, headings, tables, images, metadata: {},
      pages: undefined };
  }

  parseHeadings(text: string): HeadingNode[] {
    const headings: HeadingNode[] = [];
    let match: RegExpExecArray | null;
    HEADING_RE.lastIndex = 0;
    while ((match = HEADING_RE.exec(text)) !== null) {
      const level = match[1]!.length;
      const headingText = match[2]!.trim();
      const position = match.index;
      headings.push({ level, text: headingText, position });
    }
    return headings;
  }

  parseTables(text: string): TableNode[] {
    const tables: TableNode[] = [];
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const separator = lines[i + 1];
        if (separator && TABLE_SEPARATOR_RE.test(separator.trim())) {
          const rows: string[][] = [];
          const headerCells = line.trim().slice(1, -1).split('|').map(c => c.trim());
          rows.push(headerCells);
          i += 2;
          while (i < lines.length) {
            const rowLine = lines[i]!;
            if (!rowLine.trim().startsWith('|') || !rowLine.trim().endsWith('|')) break;
            const cells = rowLine.trim().slice(1, -1).split('|').map(c => c.trim());
            rows.push(cells);
            i++;
          }
          tables.push({ rows });
          continue;
        }
      }
      i++;
    }
    return tables;
  }

  parseImages(text: string): ImageReference[] {
    const images: ImageReference[] = [];
    let match: RegExpExecArray | null;
    IMAGE_RE.lastIndex = 0;
    while ((match = IMAGE_RE.exec(text)) !== null) {
      images.push({ ref: match[2]!, alt: match[1] ?? '', source_path: match[2] });
    }
    HTML_IMG_RE.lastIndex = 0;
    while ((match = HTML_IMG_RE.exec(text)) !== null) {
      images.push({ ref: match[1]!, alt: match[2] ?? '', source_path: match[1] });
    }
    return images;
  }
}

export { detectFormat, sha256Hex };
