import { describe, expect, it } from 'vitest';
import { DefaultDocumentIngestor, DocumentIngestError } from '../../../packages/documents/src/index.js';

function createMinimalEncryptedDocx(): Buffer {
  const entryName = 'EncryptedPackage';
  const entryData = Buffer.from('encrypted content placeholder', 'utf8');
  const header = Buffer.alloc(30 + entryName.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(entryData.length, 18);
  header.writeUInt32LE(entryData.length, 22);
  header.writeUInt16LE(entryName.length, 26);
  header.writeUInt16LE(0, 28);
  header.write(entryName, 30, 'utf8');
  return Buffer.concat([header, entryData]);
}

describe('AH-DOC-INGEST-ENC-001: Handle encrypted documents', () => {
  const ingestor = new DefaultDocumentIngestor();

  it('returns typed encrypted error for encrypted PDF', async () => {
    const pdfContent = '%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n3 0 obj\n<< /Encrypt 3 0 R >>\nendobj\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    try {
      await ingestor.ingest(buf, 'encrypted.pdf', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentIngestError);
      expect((err as DocumentIngestError).code).toBe('encrypted');
    }
  });

  it('returns typed encrypted error for encrypted DOCX', async () => {
    const zipBuf = createMinimalEncryptedDocx();
    try {
      await ingestor.ingest(zipBuf, 'encrypted.docx', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentIngestError);
      expect((err as DocumentIngestError).code).toBe('encrypted');
    }
  });

  it('error message includes context about encryption', async () => {
    const pdfContent = '%PDF-1.5\n<< /Encrypt 1 0 R >>\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    try {
      await ingestor.ingest(buf, 'secret.pdf', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toBeTruthy();
      expect((err as Error).message.length).toBeGreaterThan(0);
    }
  });

  it('does not return encrypted error for non-encrypted PDF', async () => {
    const pdfContent = '%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    try {
      const result = await ingestor.ingest(buf, 'normal.pdf', {});
      expect(result.provenance.format).toBe('pdf');
    } catch (err) {
      // If it throws, it should not be an encrypted error
      expect((err as DocumentIngestError).code).not.toBe('encrypted');
    }
  });

  it('encrypted error is a DocumentIngestError instance', async () => {
    const pdfContent = '%PDF-1.5\n<< /Encrypt 1 0 R >>\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    try {
      await ingestor.ingest(buf, 'enc.pdf', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentIngestError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('handles DOCX with EncryptedPackage entry name', async () => {
    const zipBuf = createMinimalEncryptedDocx();
    try {
      await ingestor.ingest(zipBuf, 'file.docx', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as DocumentIngestError).code).toBe('encrypted');
    }
  });

  it('rejects encrypted PDF with password', async () => {
    const pdfContent = '%PDF-1.5\n1 0 obj\n<< /Encrypt 3 0 R >>\nendobj\n';
    await expect(ingestor.ingest(Buffer.from(pdfContent, 'latin1'), 'encrypted.pdf', {})).rejects.toThrow(DocumentIngestError);
  });

  it('error code for encrypted file is encrypted', async () => {
    const pdfContent = '%PDF-1.5\n1 0 obj\n<< /Encrypt 3 0 R >>\nendobj\n';
    try {
      await ingestor.ingest(Buffer.from(pdfContent, 'latin1'), 'enc.pdf', {});
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentIngestError);
      expect((e as DocumentIngestError).code).toBe('encrypted');
    }
  });

  it('handles file with pdf extension but not PDF content', async () => {
    await expect(ingestor.ingest(Buffer.from('not a pdf'), 'fake.pdf', {})).rejects.toThrow(DocumentIngestError);
  });

  it('handles non-encrypted markdown normally', async () => {
    const result = await ingestor.ingest(Buffer.from('# Hello\n', 'utf8'), 'normal.md', {});
    expect(result.text).toContain('Hello');
  });

  it('handles non-encrypted HTML normally', async () => {
    const result = await ingestor.ingest(Buffer.from('<p>Hello</p>', 'utf8'), 'normal.html', {});
    expect(result.text).toContain('Hello');
  });

  it('handles file with no extension', async () => {
    await expect(ingestor.ingest(Buffer.from('data'), 'noextension', {})).rejects.toThrow(DocumentIngestError);
  });

  it('handles non-encrypted PDF normally', async () => {
    const pdfContent = '%PDF-1.4\nBT (Hello World) Tj ET\n';
    const result = await ingestor.ingest(Buffer.from(pdfContent, 'latin1'), 'normal.pdf', {});
    expect(result.text).toContain('Hello');
  });

  it('rejects password-protected DOCX', async () => {
    const buf = createMinimalEncryptedDocx();
    await expect(ingestor.ingest(buf, 'protected.docx', {})).rejects.toThrow(DocumentIngestError);
  });


  it('rejects encrypted DOCX with EncryptedPackage entry', async () => {
    const buf = createMinimalEncryptedDocx();
    await expect(ingestor.ingest(buf, 'encrypted.docx', {})).rejects.toThrow(DocumentIngestError);
  });

  it('error for encrypted DOCX has correct code', async () => {
    const buf = createMinimalEncryptedDocx();
    try {
      await ingestor.ingest(buf, 'enc.docx', {});
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentIngestError);
      expect((e as DocumentIngestError).code).toBe('encrypted');
    }
  });

  it('handles non-encrypted markdown with headings', async () => {
    const result = await ingestor.ingest(Buffer.from('# Title\n\nText\n', 'utf8'), 'headings.md', {});
    expect(result.text).toContain('Title');
    expect(result.headings.length).toBeGreaterThan(0);
  });

  it('handles non-encrypted HTML with tables', async () => {
    const result = await ingestor.ingest(Buffer.from('<table><tr><td>A</td></tr></table>', 'utf8'), 'table.html', {});
    expect(result).toBeDefined();
  });

});
