/**
 * DOCX document parser — AH-DOC-INGEST-DOCX-001.
 *
 * DOCX files are ZIP archives containing XML. This parser uses Node.js
 * built-in zlib to decompress and regex-extract text from word/document.xml.
 * No external dependencies required for basic text extraction.
 *
 * For encrypted DOCX files, returns typed DocumentIngestError('encrypted').
 */
import { createHash } from 'node:crypto';
import { gunzipSync, unzipSync } from 'node:zlib';
import type {
  DocumentFormat,
  DocumentIngestOptions,
  DocumentIngestResult,
  DocumentParser,
  HeadingNode,
  SourceProvenance,
  TableNode,
  ImageReference,
} from '../types.js';
import { DocumentIngestError } from '../types.js';
import { sha256Hex } from './markdown-parser.js';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'docx-native-zip';

function extractZipEntry(zipBuf: Buffer, entryName: string): Buffer | null {
  // Minimal ZIP parser: find local file header for entryName
  let offset = 0;
  while (offset < zipBuf.length - 4) {
    const sig = zipBuf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // PK\x03\x04
    const nameLen = zipBuf.readUInt16LE(offset + 26);
    const extraLen = zipBuf.readUInt16LE(offset + 28);
    const compMethod = zipBuf.readUInt16LE(offset + 8);
    const compSize = zipBuf.readUInt32LE(offset + 18);
    const name = zipBuf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataOffset = offset + 30 + nameLen + extraLen;
    if (name === entryName) {
      const compData = zipBuf.subarray(dataOffset, dataOffset + compSize);
      if (compMethod === 0) return compData; // stored, no compression
      if (compMethod === 8) return unzipSync(compData); // deflate
      return null;
    }
    offset = dataOffset + compSize;
  }
  return null;
}

function extractTextFromXml(xml: string): { text: string; headings: HeadingNode[] } {
  const headings: HeadingNode[] = [];
  let text = '';
  let inParagraph = false;
  let paragraphText = '';
  let headingLevel = 0;

  // Extract paragraphs and heading styles
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = paraRe.exec(xml)) !== null) {
    const paraContent = match[1]!;
    paragraphText = '';
    // Check for heading style
    const styleMatch = /<w:pStyle\s+w:val="Heading(\d)"/.exec(paraContent);
    headingLevel = styleMatch ? parseInt(styleMatch[1]!, 10) : 0;
    // Extract text runs
    const runRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let runMatch: RegExpExecArray | null;
    while ((runMatch = runRe.exec(paraContent)) !== null) {
      paragraphText += runMatch[1]!;
    }
    if (paragraphText) {
      if (text) text += '\n';
      text += paragraphText;
      if (headingLevel > 0) {
        headings.push({ level: headingLevel, text: paragraphText });
      }
    }
  }
  return { text, headings };
}

export class DocxParser implements DocumentParser {
  readonly format: DocumentFormat = 'docx';
  readonly version = PARSER_VERSION;
  readonly name = PARSER_NAME;

  canHandle(format: DocumentFormat): boolean {
    return format === 'docx';
  }

  async parse(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    const maxBytes = options.max_bytes ?? 100 * 1024 * 1024;
    if (content.byteLength > maxBytes) {
      throw new DocumentIngestError(
        `docx file exceeds max bytes (${content.byteLength} > ${maxBytes})`,
        'too_large',
      );
    }
    // Check if encrypted: Encrypted DOCX has an EncryptionInfo entry
    const encryptionInfo = extractZipEntry(content, 'EncryptedPackage');
    if (encryptionInfo) {
      throw new DocumentIngestError(
        `encrypted DOCX file requires password: ${source_path}`,
        'encrypted',
      );
    }
    // Check for valid ZIP signature
    if (content.length < 4 || content.readUInt32LE(0) !== 0x04034b50) {
      throw new DocumentIngestError(
        `corrupted DOCX file (invalid ZIP signature): ${source_path}`,
        'corrupted',
      );
    }
    const documentXml = extractZipEntry(content, 'word/document.xml');
    if (!documentXml) {
      throw new DocumentIngestError(
        `corrupted DOCX file (missing word/document.xml): ${source_path}`,
        'corrupted',
      );
    }
    const xmlStr = documentXml.toString('utf8');
    const { text, headings } = extractTextFromXml(xmlStr);
    const provenance: SourceProvenance = {
      source_path,
      format: 'docx',
      parser_version: PARSER_VERSION,
      parser_name: PARSER_NAME,
      ingested_at: new Date().toISOString(),
      content_hash: sha256Hex(content),
      byte_size: content.byteLength,
    };
    return {
      provenance,
      text,
      headings,
      tables: [],
      images: [],
      metadata: {},
      pages: undefined,
    };
  }
}
