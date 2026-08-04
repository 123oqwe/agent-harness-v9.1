/**
 * Document ingestion and parsing types for Phase 2.
 *
 * All parsers produce a unified DocumentIngestResult with provenance tracking.
 * Unsupported formats return a typed error, never a silent success.
 */

export type DocumentFormat =
  | 'docx'
  | 'pdf'
  | 'pptx'
  | 'xlsx'
  | 'md'
  | 'html'
  | 'image'
  | 'unsupported';

export interface SourceProvenance {
  readonly source_path: string;
  readonly format: DocumentFormat;
  readonly parser_version: string;
  readonly parser_name: string;
  readonly ingested_at: string;
  readonly content_hash: string;
  readonly byte_size: number;
}

export interface HeadingNode {
  readonly level: number;
  readonly text: string;
  readonly position?: number;
}

export interface TableNode {
  readonly rows: readonly (readonly string[])[];
  readonly caption?: string;
}

export interface ImageReference {
  readonly ref: string;
  readonly alt: string;
  readonly source_path: string | undefined;
}

export interface PageReference {
  readonly page: number;
  readonly start_offset: number;
  readonly end_offset: number;
}

export interface DocumentIngestResult {
  readonly provenance: SourceProvenance;
  readonly text: string;
  readonly headings: readonly HeadingNode[];
  readonly tables: readonly TableNode[];
  readonly images: readonly ImageReference[];
  readonly pages: readonly PageReference[] | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export class DocumentIngestError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'encrypted' | 'corrupted' | 'not_found' | 'permission' | 'too_large',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DocumentIngestError';
    Object.setPrototypeOf(this, DocumentIngestError.prototype);
  }
}

export interface DocumentIngestOptions {
  readonly local_only?: boolean;
  readonly max_bytes?: number;
  readonly ocr_fallback?: boolean;
}

export interface DocumentParser {
  readonly format: DocumentFormat;
  readonly version: string;
  readonly name: string;
  canHandle(format: DocumentFormat): boolean;
  parse(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult>;
}
