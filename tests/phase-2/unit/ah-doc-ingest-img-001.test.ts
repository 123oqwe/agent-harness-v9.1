import { describe, expect, it } from 'vitest';
import { ImageParser, DocumentIngestError } from '../../../packages/documents/src/index.js';

describe('AH-DOC-INGEST-IMG-001: Ingest images with OCR fallback policy', () => {
  const parser = new ImageParser();

  it('extracts basic image metadata', () => {
    // Minimal PNG: 8-byte signature + IHDR chunk
    const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.from([
      0x00, 0x00, 0x00, 0x0D, // length
      0x49, 0x48, 0x44, 0x52, // "IHDR"
      0x00, 0x00, 0x00, 0x0A, // width=10
      0x00, 0x00, 0x00, 0x14, // height=20
      0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, etc.
    ]);
    const png = Buffer.concat([pngSig, ihdr]);
    return parser.parse(png, 'test.png', {}).then(result => {
      expect(result.provenance.format).toBe('image');
      expect(result.metadata.mime_type).toBe('image/png');
      expect(result.metadata.width).toBe(10);
      expect(result.metadata.height).toBe(20);
    });
  });

  it('returns typed OCR unavailable status without faking success', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    return parser.parse(png, 'test.png', {}).then(result => {
      expect(result.metadata.ocr_available).toBe(false);
      expect(result.metadata.ocr_reason).toBeTruthy();
    });
  });

  it('records provenance with content hash', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    return parser.parse(png, 'test.png', {}).then(result => {
      expect(result.provenance.content_hash).toHaveLength(64);
    });
  });

  it('rejects files exceeding max bytes', () => {
    const buf = Buffer.alloc(200);
    return expect(parser.parse(buf, 'big.png', { max_bytes: 100 })).rejects.toThrow(DocumentIngestError);
  });
});
