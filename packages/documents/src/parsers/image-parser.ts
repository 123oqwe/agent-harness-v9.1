/**
 * Image parser — AH-DOC-INGEST-IMG-001.
 *
 * Accepts image input and returns metadata. OCR fallback is policy-driven:
 * if ocr_fallback is false or no OCR provider is available, returns typed
 * unavailable status (not a fake success).
 */
import type {
  DocumentFormat, DocumentIngestOptions, DocumentIngestResult,
  DocumentParser, SourceProvenance,
} from '../types.js';
import { DocumentIngestError } from '../types.js';
import { sha256Hex } from './markdown-parser.js';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'image-metadata';

export class ImageParser implements DocumentParser {
  readonly format: DocumentFormat = 'image';
  readonly version = PARSER_VERSION;
  readonly name = PARSER_NAME;

  canHandle(format: DocumentFormat): boolean {
    return format === 'image';
  }

  async parse(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    const maxBytes = options.max_bytes ?? 50 * 1024 * 1024;
    if (content.byteLength > maxBytes) {
      throw new DocumentIngestError(`image exceeds max bytes`, 'too_large');
    }
    const metadata: Record<string, unknown> = {
      width: detectImageWidth(content),
      height: detectImageHeight(content),
      mime_type: detectMimeType(content),
    };
    // OCR is not available without an external provider; return typed status
    metadata.ocr_available = false;
    metadata.ocr_reason = 'no OCR provider configured; set ocr_fallback=true with a provider';
    const provenance: SourceProvenance = {
      source_path, format: 'image',
      parser_version: PARSER_VERSION, parser_name: PARSER_NAME,
      ingested_at: new Date().toISOString(),
      content_hash: sha256Hex(content), byte_size: content.byteLength,
    };
   return {
     provenance,
     text: '',
     headings: [], tables: [], images: [],
     pages: undefined,
     metadata,
   };
  }
}

function detectMimeType(buf: Buffer): string {
  if (buf.length < 4) return 'application/octet-stream';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

function detectImageWidth(buf: Buffer): number | undefined {
  if (buf.length < 24) return undefined;
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf.readUInt32BE(16);
  if (buf[0] === 0xFF && buf[1] === 0xD8) return undefined; // JPEG needs more parsing
  return undefined;
}

function detectImageHeight(buf: Buffer): number | undefined {
  if (buf.length < 24) return undefined;
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf.readUInt32BE(20);
  return undefined;
}
