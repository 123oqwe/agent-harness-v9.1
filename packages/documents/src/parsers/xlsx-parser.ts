/**
 * XLSX parser — AH-DOC-INGEST-XLSX-001.
 *
 * Extracts table cells from XLSX (ZIP-based OOXML). Reads shared strings
 * and sheet data to produce a structured TableNode per sheet.
 */
import type {
  DocumentFormat, DocumentIngestOptions, DocumentIngestResult,
  DocumentParser, SourceProvenance, TableNode,
} from '../types.js';
import { DocumentIngestError } from '../types.js';
import { sha256Hex } from './markdown-parser.js';
import { inflateRawSync } from 'node:zlib';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'xlsx-native-zip';
const MAX_DECOMPRESSED_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_DECOMPRESSED = 200 * 1024 * 1024;
const MAX_COMPRESSED_SIZE = 50 * 1024 * 1024;
const MAX_ENTRY_COUNT = 10000;

function extractZipEntries(zipBuf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let totalDecompressed = 0;
  let offset = 0;
  while (offset < zipBuf.length - 4) {
    if (offset + 30 > zipBuf.length) break;
    const sig = zipBuf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    if (entries.size >= MAX_ENTRY_COUNT) {
      throw new DocumentIngestError('xlsx zip contains too many entries', 'too_large');
    }
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
      if (compSize > MAX_DECOMPRESSED_SIZE) throw new DocumentIngestError('xlsx entry exceeds size limit', 'too_large');
      data = compData;
    }
    else if (compMethod === 8) {
      try { data = inflateRawSync(compData, { maxOutputLength: MAX_DECOMPRESSED_SIZE }); }
      catch { throw new DocumentIngestError('xlsx zip decompression failed', 'corrupted'); }
    }
    else { offset = dataOffset + compSize; continue; }
    totalDecompressed += data.length;
    if (totalDecompressed > MAX_TOTAL_DECOMPRESSED) {
      throw new DocumentIngestError('xlsx total decompressed size exceeds limit', 'too_large');
    }
    entries.set(name, data);
    offset = dataOffset + compSize;
  }
  return entries;
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const tRe = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    let text = '';
    while ((tMatch = tRe.exec(m[1]!)) !== null) {
      text += tMatch[1]!;
    }
    strings.push(text);
  }
  return strings;
}

function parseSheet(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<c\s+r="([A-Z]+\d+)"(?:\s+t="([^"]*)")?[^>]*>(?:<v>([^<]*)<\/v>)?<\/c>/g;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cellRe.exec(m[1]!)) !== null) {
      const type = cMatch[2];
      const value = cMatch[3] ?? '';
      if (type === 's') {
        cells.push(sharedStrings[parseInt(value, 10)] ?? '');
      } else {
        cells.push(value);
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

export class XlsxParser implements DocumentParser {
  readonly format: DocumentFormat = 'xlsx';
  readonly version = PARSER_VERSION;
  readonly name = PARSER_NAME;

  canHandle(format: DocumentFormat): boolean {
    return format === 'xlsx';
  }

  async parse(
    content: Buffer,
    source_path: string,
    options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    const maxBytes = Math.min(options.max_bytes ?? 50 * 1024 * 1024, MAX_COMPRESSED_SIZE);
    if (content.byteLength > maxBytes) {
      throw new DocumentIngestError(`xlsx exceeds max bytes`, 'too_large');
    }
    if (content.length < 4 || content.readUInt32LE(0) !== 0x04034b50) {
      throw new DocumentIngestError(`corrupted XLSX: ${source_path}`, 'corrupted');
    }
    const entries = extractZipEntries(content);
    const sharedStringsXml = entries.get('xl/sharedStrings.xml');
    const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml.toString('utf8')) : [];
    const sheetFiles = [...entries.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
    const tables: TableNode[] = [];
    let text = '';
    for (let i = 0; i < sheetFiles.length; i++) {
      const sheetXml = entries.get(sheetFiles[i]!)!.toString('utf8');
      const rows = parseSheet(sheetXml, sharedStrings);
      if (rows.length > 0) {
        tables.push({ rows, caption: `Sheet ${i + 1}` });
        text += `Sheet ${i + 1}:\n${rows.map(r => r.join('\t')).join('\n')}\n\n`;
      }
    }
    const provenance: SourceProvenance = {
      source_path, format: 'xlsx',
      parser_version: PARSER_VERSION, parser_name: PARSER_NAME,
      ingested_at: new Date().toISOString(),
      content_hash: sha256Hex(content), byte_size: content.byteLength,
    };
    return { provenance, text, headings: [], tables, images: [], metadata: {},
      pages: undefined };
  }
}
