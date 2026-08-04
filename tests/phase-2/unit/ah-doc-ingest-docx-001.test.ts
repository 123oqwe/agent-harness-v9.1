import { describe, expect, it } from 'vitest';
import { DocxParser, DocumentIngestError } from '../../../packages/documents/src/index.js';

describe('AH-DOC-INGEST-DOCX-001: Ingest DOCX documents preserving structure', () => {
  const parser = new DocxParser();

  it('rejects corrupted DOCX (invalid ZIP signature)', () => {
    const buf = Buffer.from('not a zip', 'utf8');
    return expect(parser.parse(buf, 'fake.docx', {})).rejects.toThrow(DocumentIngestError);
  });

  it('records provenance for valid DOCX', () => {
    const docx = createMinimalDocx();
    return parser.parse(docx, 'test.docx', {}).then(result => {
      expect(result.provenance.format).toBe('docx');
      expect(result.provenance.parser_name).toBe('docx-native-zip');
      expect(result.provenance.content_hash).toHaveLength(64);
    });
  });

  it('extracts text from DOCX document.xml', () => {
    const docx = createMinimalDocx();
    return parser.parse(docx, 'test.docx', {}).then(result => {
      expect(result.text).toContain('Hello');
    });
  });
});

function createMinimalDocx(): Buffer {
  // Create a minimal ZIP with word/document.xml
  const xmlContent = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Heading Text</w:t></w:r></w:p>
</w:body>
</w:document>`;
  return createZipWithEntry('word/document.xml', xmlContent);
}

export function createZipWithEntry(entryName: string, content: string): Buffer {
  const entryData = Buffer.from(content, 'utf8');
  const nameBuf = Buffer.from(entryName, 'utf8');
  
  // Local file header (30 bytes + name)
  const header = Buffer.alloc(30 + nameBuf.length);
  header.writeUInt32LE(0x04034b50, 0); // signature
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(0, 8); // compression: stored (no compression)
  header.writeUInt16LE(0, 10); // mod time
  header.writeUInt16LE(0, 12); // mod date
  header.writeUInt32LE(0, 14); // crc32 (not computed for test)
  header.writeUInt32LE(entryData.length, 18); // compressed size
  header.writeUInt32LE(entryData.length, 22); // uncompressed size
  header.writeUInt16LE(nameBuf.length, 26); // filename length
  header.writeUInt16LE(0, 28); // extra field length
  nameBuf.copy(header, 30);
  
  // Central directory
  const cdOffset = header.length + entryData.length;
  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0); // signature
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8); // flags
  cd.writeUInt16LE(0, 10); // compression
  cd.writeUInt16LE(0, 12); // mod time
  cd.writeUInt16LE(0, 14); // mod date
  cd.writeUInt32LE(0, 16); // crc32
  cd.writeUInt32LE(entryData.length, 20); // compressed size
  cd.writeUInt32LE(entryData.length, 24); // uncompressed size
  cd.writeUInt16LE(nameBuf.length, 28); // filename length
  cd.writeUInt16LE(0, 30); // extra field length
  cd.writeUInt16LE(0, 32); // comment length
  cd.writeUInt16LE(0, 34); // disk number
  cd.writeUInt16LE(0, 36); // internal attrs
  cd.writeUInt32LE(0, 38); // external attrs
  cd.writeUInt32LE(0, 42); // local header offset
  nameBuf.copy(cd, 46);
  
  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(cd.length, 12); // CD size
  eocd.writeUInt32LE(cdOffset, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment length
  
  return Buffer.concat([header, entryData, cd, eocd]);
}
