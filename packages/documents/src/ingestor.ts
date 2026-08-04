/**
 * Document ingestion orchestrator.
 *
 * Routes files to the appropriate parser based on file extension,
 * handles all registered formats, and returns typed errors for
 * unsupported or encrypted files.
 */
import type {
  DocumentFormat, DocumentIngestOptions, DocumentIngestResult, DocumentParser,
} from './types.js';
import { DocumentIngestError } from './types.js';
import { detectFormat } from './parsers/markdown-parser.js';
import { MarkdownParser } from './parsers/markdown-parser.js';
import { DocxParser } from './parsers/docx-parser.js';
import { PdfParser } from './parsers/pdf-parser.js';
import { HtmlParser } from './parsers/html-parser.js';
import { PptxParser } from './parsers/pptx-parser.js';
import { XlsxParser } from './parsers/xlsx-parser.js';
import { ImageParser } from './parsers/image-parser.js';
import { UnsupportedParser } from './parsers/unsupported-parser.js';

export interface DocumentIngestor {
  ingest(content: Buffer, source_path: string, options?: DocumentIngestOptions): Promise<DocumentIngestResult>;
  getSupportedFormats(): readonly DocumentFormat[];
}

export class DefaultDocumentIngestor implements DocumentIngestor {
  private readonly parsers: ReadonlyMap<DocumentFormat, DocumentParser>;
  private readonly fallback: DocumentParser;

  constructor(customParsers?: readonly DocumentParser[]) {
    const defaults: readonly DocumentParser[] = [
      new MarkdownParser(),
      new DocxParser(),
      new PdfParser(),
      new HtmlParser(),
      new PptxParser(),
      new XlsxParser(),
      new ImageParser(),
    ];
    const all = customParsers ?? defaults;
    const map = new Map<DocumentFormat, DocumentParser>();
    for (const p of all) {
      map.set(p.format, p);
    }
    this.parsers = map;
    this.fallback = new UnsupportedParser();
  }

  getSupportedFormats(): readonly DocumentFormat[] {
    return [...this.parsers.keys()];
  }

  async ingest(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions = {},
  ): Promise<DocumentIngestResult> {
    const format = detectFormat(source_path);
    const parser = this.parsers.get(format) ?? this.fallback;
    return parser.parse(content, source_path, options);
  }
}
