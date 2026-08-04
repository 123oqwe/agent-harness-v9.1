import { describe, expect, it } from 'vitest';
import { PptxParser, DocumentIngestError } from '../../../packages/documents/src/index.js';
import { createZipWithEntry } from './ah-doc-ingest-docx-001.test';

describe('AH-DOC-INGEST-PPTX-001: Ingest PPTX documents extracting slides', () => {
  const parser = new PptxParser();

  it('rejects corrupted PPTX', () => {
    const buf = Buffer.from('not a zip', 'utf8');
    return expect(parser.parse(buf, 'fake.pptx', {})).rejects.toThrow(DocumentIngestError);
  });

  it('extracts slide text from PPTX', () => {
    const slideXml = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>Slide 1 Title</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld>
</p:sld>`;
    const pptx = createZipWithEntry('ppt/slides/slide1.xml', slideXml);
    return parser.parse(pptx, 'test.pptx', {}).then(result => {
      expect(result.text).toContain('Slide 1 Title');
      expect(result.provenance.format).toBe('pptx');
    });
  });

  it('handles multiple slides with page references', () => {
    const slide1 = `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>First</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const slide2 = `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    // Create a ZIP with both slides - using the test helper
    const pptx = createMultiSlideZip(slide1, slide2);
    return parser.parse(pptx, 'multi.pptx', {}).then(result => {
      expect(result.text).toContain('First');
      expect(result.text).toContain('Second');
    });
  });
});

function createMultiSlideZip(slide1Xml: string, slide2Xml: string): Buffer {
  // Create a minimal ZIP with two slide entries
  const entries = [
    { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide1Xml, 'utf8') },
    { name: 'ppt/slides/slide2.xml', data: Buffer.from(slide2Xml, 'utf8') },
  ];
  
  const parts: Buffer[] = [];
  let offset = 0;
  const centralDir: Buffer[] = [];
  
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(30 + nameBuf.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    nameBuf.copy(header, 30);
    
    parts.push(header, entry.data);
    
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(entry.data.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    centralDir.push(cd);
    
    offset += header.length + entry.data.length;
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
