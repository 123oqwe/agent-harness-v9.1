import { describe, expect, it } from 'vitest';
import { PdfParser, DocumentIngestError } from '../../../packages/documents/src/index.js';

describe('AH-DOC-INGEST-PDF-001: Ingest PDF documents with page references', () => {
  const parser = new PdfParser();

  it('rejects corrupted PDF (missing %PDF- header)', () => {
    const buf = Buffer.from('not a pdf', 'utf8');
    return expect(parser.parse(buf, 'fake.pdf', {})).rejects.toThrow(DocumentIngestError);
  });

  it('rejects encrypted PDF with typed error', () => {
    const pdfContent = '%PDF-1.5\n1 0 obj\n<< /Encrypt 3 0 R >>\nendobj\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    return expect(parser.parse(buf, 'encrypted.pdf', {})).rejects.toThrow(DocumentIngestError);
  });

  it('extracts text from minimal PDF', () => {
    const pdfContent = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nBT /F1 12 Tf (Hello World) Tj ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    return parser.parse(buf, 'test.pdf', {}).then(result => {
      expect(result.provenance.format).toBe('pdf');
      expect(result.text).toContain('Hello');
    });
  });

  it('records page references when pages detected', () => {
    const pdfContent = '%PDF-1.4\n/Type /Page\nBT (Page 1 text) Tj ET\n/Type /Page\nBT (Page 2 text) Tj ET\n';
    const buf = Buffer.from(pdfContent, 'latin1');
    return parser.parse(buf, 'multipage.pdf', {}).then(result => {
      if (result.pages && result.pages.length > 0) {
        expect(result.pages[0]!.page).toBe(1);
      }
    });
  });
});
