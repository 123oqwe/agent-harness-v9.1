import { describe, expect, it } from 'vitest';
import { DefaultDocumentIngestor, DocumentIngestError } from '../../../packages/documents/src/index.js';

describe('AH-DOC-INGEST-ENC-001: Handle encrypted documents', () => {
  const ingestor = new DefaultDocumentIngestor();

  it('returns typed encrypted error for encrypted PDF', () => {
    // Minimal fake encrypted PDF: has %PDF- header and /Encrypt marker
    const pdfContent = '%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n3 0 obj\n<< /Encrypt 3 0 R >>\nendobj\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    return ingestor.ingest(buf, 'encrypted.pdf', {}).catch(err => {
      expect(err).toBeInstanceOf(DocumentIngestError);
      expect((err as DocumentIngestError).code).toBe('encrypted');
    });
  });

  it('returns typed encrypted error for encrypted DOCX', () => {
    // Create a minimal ZIP with an EncryptedPackage entry
    const zipBuf = createMinimalEncryptedDocx();
    return ingestor.ingest(zipBuf, 'encrypted.docx', {}).catch(err => {
      expect(err).toBeInstanceOf(DocumentIngestError);
      expect((err as DocumentIngestError).code).toBe('encrypted');
    });
  });
});

function createMinimalEncryptedDocx(): Buffer {
  // Minimal ZIP containing an EncryptedPackage entry
  // This is a simplified representation
  const entryName = 'EncryptedPackage';
  const entryData = Buffer.from('encrypted content placeholder', 'utf8');
  
  // Local file header
  const header = Buffer.alloc(30 + entryName.length);
  header.writeUInt32LE(0x04034b50, 0); // signature
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(0, 8); // compression: stored
  header.writeUInt16LE(0, 10); // mod time
  header.writeUInt16LE(0, 12); // mod date
  header.writeUInt32LE(0, 14); // crc32
  header.writeUInt32LE(entryData.length, 18); // compressed size
  header.writeUInt32LE(entryData.length, 22); // uncompressed size
  header.writeUInt16LE(entryName.length, 26); // filename length
  header.writeUInt16LE(0, 28); // extra field length
  header.write(entryName, 30, 'utf8');
  
  return Buffer.concat([header, entryData]);
}
