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
import { unzipSync } from 'node:zlib';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'xlsx-native-zip';

function extractZipEntries(zipBuf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset < zipBuf.length - 4) {
    const sig = zipBuf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const nameLen = zipBuf.readUInt16LE(offset + 26);
    const extraLen = zipBuf.readUInt16LE(offset + 28);
    const compMethod = zipBuf.readUInt16LE(offset + 8);
    const compSize = zipBuf.readUInt32LE(offset + 18);
    const name = zipBuf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataOffset = offset + 30 + nameLen + extraLen;
    const compData = zipBuf.subarray(dataOffset, dataOffset + compSize);
    let data: Buffer;
    if (compMethod === 0) data = compData;
    else if (compMethod === 8) data = unzipSync(compData);
    else { offset = dataOffset + compSize; continue; }
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
    const maxBytes = options.max_bytes ?? 100 * 1024 * 1024;
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
