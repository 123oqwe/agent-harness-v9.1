import { describe, expect, it } from 'vitest';
import { PdfParser, DocumentIngestError } from '../../../packages/documents/src/index.js';

describe('AH-DOC-INGEST-PDF-001: Ingest PDF documents with page references', () => {
  const parser = new PdfParser();

  it('reports pdf format and handles only pdf', () => {
    expect(parser.format).toBe('pdf');
    expect(parser.canHandle('pdf')).toBe(true);
    expect(parser.canHandle('docx')).toBe(false);
  });

  it('rejects corrupted PDF (missing %PDF- header)', async () => {
    const buf = Buffer.from('not a pdf', 'utf8');
    await expect(parser.parse(buf, 'fake.pdf', {})).rejects.toThrow(DocumentIngestError);
    try {
      await parser.parse(buf, 'fake.pdf', {});
    } catch (e) {
      expect((e as DocumentIngestError).code).toBe('corrupted');
    }
  });

  it('rejects encrypted PDF with typed error', async () => {
    const pdfContent = '%PDF-1.5\n1 0 obj\n<< /Encrypt 3 0 R >>\nendobj\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    await expect(parser.parse(buf, 'encrypted.pdf', {})).rejects.toThrow(DocumentIngestError);
    try {
      await parser.parse(buf, 'encrypted.pdf', {});
    } catch (e) {
      expect((e as DocumentIngestError).code).toBe('encrypted');
    }
  });

  it('extracts text from minimal PDF using Tj operator', async () => {
    const pdfContent = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nBT /F1 12 Tf (Hello World) Tj ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    const result = await parser.parse(buf, 'test.pdf', {});
    expect(result.provenance.format).toBe('pdf');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('World');
  });

  it('extracts text from TJ array operator', async () => {
    const pdfContent = '%PDF-1.4\nBT [(Hel) (lo) ( ) (World)] TJ ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    const result = await parser.parse(buf, 'array.pdf', {});
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('World');
  });

  it('records page references when pages detected', async () => {
    const pdfContent = '%PDF-1.4\n/Type /Page\nBT (Page 1 text) Tj ET\n/Type /Page\nBT (Page 2 text) Tj ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    const result = await parser.parse(buf, 'multipage.pdf', {});
    expect(result.pages).toBeDefined();
    expect(result.pages!.length).toBe(2);
    expect(result.pages![0]!.page).toBe(1);
    expect(result.pages![1]!.page).toBe(2);
    expect(result.text).toContain('Page Break');
  });

  it('returns undefined pages when no page markers found', async () => {
    const pdfContent = '%PDF-1.4\nBT (No pages here) Tj ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    const result = await parser.parse(buf, 'nopages.pdf', {});
    expect(result.pages).toBeUndefined();
    expect(result.text).toContain('No pages');
  });

  it('records provenance with content hash and byte size', async () => {
    const pdfContent = '%PDF-1.4\nBT (Test) Tj ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    const result = await parser.parse(buf, 'prov.pdf', {});
    expect(result.provenance.source_path).toBe('prov.pdf');
    expect(result.provenance.content_hash).toHaveLength(64);
    expect(result.provenance.byte_size).toBe(buf.byteLength);
    expect(result.provenance.parser_name).toBe('pdf-native');
  });

  it('throws DocumentIngestError when content exceeds max_bytes', async () => {
    const pdfContent = '%PDF-1.4\nBT (Test) Tj ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    await expect(parser.parse(buf, 'big.pdf', { max_bytes: 5 }))
      .rejects.toThrow(DocumentIngestError);
  });

  it('handles empty text gracefully', async () => {
    const pdfContent = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    const result = await parser.parse(buf, 'empty.pdf', {});
    expect(result.text).toBe('');
  });

  it('unescapes PDF string escapes in text content', async () => {
    const pdfContent = '%PDF-1.4\nBT (Line1\\nLine2) Tj ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    const result = await parser.parse(buf, 'escape.pdf', {});
    expect(result.text).toContain('Line1\nLine2');
  });
});
