import { describe, expect, it } from 'vitest';
import { XlsxParser, DocumentIngestError } from '../../../packages/documents/src/index.js';
import { createZipWithEntry } from './ah-doc-ingest-docx-001.test';

describe('AH-DOC-INGEST-XLSX-001: Ingest spreadsheets extracting table cells', () => {
  const parser = new XlsxParser();

  it('rejects corrupted XLSX', () => {
    const buf = Buffer.from('not a zip', 'utf8');
    return expect(parser.parse(buf, 'fake.xlsx', {})).rejects.toThrow(DocumentIngestError);
  });

  it('extracts table cells from XLSX', () => {
    const sharedStrings = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>Name</t></si>
<si><t>Value</t></si>
<si><t>Alice</t></si>
<si><t>42</t></si>
</sst>`;
    const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>
</sheetData>
</worksheet>`;
    // Create a ZIP with both entries
    const xlsx = createMultiEntryZip([
      { name: 'xl/sharedStrings.xml', data: sharedStrings },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ]);
    return parser.parse(xlsx, 'test.xlsx', {}).then(result => {
      expect(result.provenance.format).toBe('xlsx');
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0]!.rows[0]).toEqual(['Name', 'Value']);
      expect(result.tables[0]!.rows[1]).toEqual(['Alice', '42']);
    });
  });
});

function createMultiEntryZip(entries: { name: string; data: string }[]): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  const centralDir: Buffer[] = [];
  
  for (const entry of entries) {
    const entryData = Buffer.from(entry.data, 'utf8');
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(30 + nameBuf.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(entryData.length, 18);
    header.writeUInt32LE(entryData.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    nameBuf.copy(header, 30);
    parts.push(header, entryData);
    
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(entryData.length, 20);
    cd.writeUInt32LE(entryData.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    centralDir.push(cd);
    offset += header.length + entryData.length;
  }
  
  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
