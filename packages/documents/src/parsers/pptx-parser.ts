/**
 * PPTX parser — AH-DOC-INGEST-PPTX-001.
 *
 * Extracts slide text from PPTX (ZIP-based OOXML). Each slide's text
 * is separated by a slide delimiter. Uses the same minimal ZIP parser
 * as the DOCX handler.
 */
import type {
  DocumentFormat, DocumentIngestOptions, DocumentIngestResult,
  DocumentParser, PageReference, SourceProvenance,
} from '../types.js';
import { DocumentIngestError } from '../types.js';
import { sha256Hex } from './markdown-parser.js';
import { inflateRawSync } from 'node:zlib';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'pptx-native-zip';
const MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024;

function extractZipEntries(zipBuf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset < zipBuf.length - 4) {
    if (offset + 30 > zipBuf.length) break;
    const sig = zipBuf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const nameLen = zipBuf.readUInt16LE(offset + 26);
    const extraLen = zipBuf.readUInt16LE(offset + 28);
    const compMethod = zipBuf.readUInt16LE(offset + 8);
    const compSize = zipBuf.readUInt32LE(offset + 18);
    const name = zipBuf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataOffset = offset + 30 + nameLen + extraLen;
    if (dataOffset + compSize > zipBuf.length) break;
    const compData = zipBuf.subarray(dataOffset, dataOffset + compSize);
    let data: Buffer;
    if (compMethod === 0) {
      if (compSize > MAX_DECOMPRESSED_SIZE) throw new DocumentIngestError('pptx entry exceeds size limit', 'too_large');
      data = compData;
    }
    else if (compMethod === 8) {
      try { data = inflateRawSync(compData, { maxOutputLength: MAX_DECOMPRESSED_SIZE }); }
      catch { throw new DocumentIngestError('pptx zip decompression failed', 'corrupted'); }
    }
    else { offset = dataOffset + compSize; continue; }
    entries.set(name, data);
    offset = dataOffset + compSize;
  }
  return entries;
}

function extractTextFromSlideXml(xml: string): string {
  const texts: string[] = [];
  const re = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    texts.push(m[1]!);
  }
  return texts.join(' ');
}

export class PptxParser implements DocumentParser {
  readonly format: DocumentFormat = 'pptx';
  readonly version = PARSER_VERSION;
  readonly name = PARSER_NAME;

  canHandle(format: DocumentFormat): boolean {
    return format === 'pptx';
  }

  async parse(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    const maxBytes = options.max_bytes ?? 100 * 1024 * 1024;
    if (content.byteLength > maxBytes) {
      throw new DocumentIngestError(`pptx exceeds max bytes`, 'too_large');
    }
    if (content.length < 4 || content.readUInt32LE(0) !== 0x04034b50) {
      throw new DocumentIngestError(`corrupted PPTX (invalid ZIP): ${source_path}`, 'corrupted');
    }
    const entries = extractZipEntries(content);
    const slideFiles = [...entries.keys()]
      .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/)![1]!, 10);
        const nb = parseInt(b.match(/slide(\d+)/)![1]!, 10);
        return na - nb;
      });
    const pages: PageReference[] = [];
    let text = '';
    for (let i = 0; i < slideFiles.length; i++) {
      const slideXml = entries.get(slideFiles[i]!)!.toString('utf8');
      const slideText = extractTextFromSlideXml(slideXml);
      const startOffset = text.length;
      if (text) text += '\n\n--- Slide Break ---\n\n';
      text += `Slide ${i + 1}: ${slideText}`;
      pages.push({ page: i + 1, start_offset: startOffset, end_offset: text.length });
    }
    const provenance: SourceProvenance = {
      source_path, format: 'pptx',
      parser_version: PARSER_VERSION, parser_name: PARSER_NAME,
      ingested_at: new Date().toISOString(),
      content_hash: sha256Hex(content), byte_size: content.byteLength,
    };
    return { provenance, text, headings: [], tables: [], images: [], pages, metadata: {} };
  }
}
