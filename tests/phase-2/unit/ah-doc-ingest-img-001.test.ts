import { describe, expect, it } from 'vitest';
import { ImageParser, DocumentIngestError } from '../../../packages/documents/src/index.js';

function makePng(width = 10, height = 20): Buffer {
  const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.from([
    0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52,
    (width >> 24) & 0xFF, (width >> 16) & 0xFF, (width >> 8) & 0xFF, width & 0xFF,
    (height >> 24) & 0xFF, (height >> 16) & 0xFF, (height >> 8) & 0xFF, height & 0xFF,
    0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
  return Buffer.concat([pngSig, ihdr]);
}

describe('AH-DOC-INGEST-IMG-001: Ingest images with OCR fallback policy', () => {
  const parser = new ImageParser();

  it('extracts basic PNG image metadata', async () => {
    const result = await parser.parse(makePng(10, 20), 'test.png', {});
    expect(result.provenance.format).toBe('image');
    expect(result.metadata.mime_type).toBe('image/png');
    expect(result.metadata.width).toBe(10);
    expect(result.metadata.height).toBe(20);
  });

  it('returns typed OCR unavailable status without faking success', async () => {
    const result = await parser.parse(makePng(), 'test.png', {});
    expect(result.metadata.ocr_available).toBe(false);
    expect(result.metadata.ocr_reason).toBeTruthy();
  });

  it('records provenance with content hash', async () => {
    const result = await parser.parse(makePng(), 'test.png', {});
    expect(result.provenance.content_hash).toHaveLength(64);
  });

  it('rejects files exceeding max bytes', () => {
    const buf = Buffer.alloc(200);
    return expect(parser.parse(buf, 'big.png', { max_bytes: 100 })).rejects.toThrow(DocumentIngestError);
  });

  it('detects JPEG mime type', async () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const result = await parser.parse(jpeg, 'photo.jpg', {});
    expect(result.metadata.mime_type).toBe('image/jpeg');
  });

  it('detects GIF mime type', async () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0A, 0x00, 0x0A, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x21, 0xF9, 0x04, 0x00, 0x00]);
    const result = await parser.parse(gif, 'anim.gif', {});
    expect(result.metadata.mime_type).toBe('image/gif');
  });

  it('detects WebP mime type', async () => {
    const webp = Buffer.alloc(26, 0);
    webp.write('RIFF', 0, 'ascii');
    webp.writeUInt32LE(0, 4);
    webp.write('WEBP', 8, 'ascii');
    const result = await parser.parse(webp, 'img.webp', {});
    expect(result.metadata.mime_type).toBe('image/webp');
  });

  it('returns octet-stream for unknown format', async () => {
    const unknown = Buffer.alloc(24, 0x42);
    const result = await parser.parse(unknown, 'unknown.xyz', {});
    expect(result.metadata.mime_type).toBe('application/octet-stream');
  });

  it('records byte_size in provenance', async () => {
    const png = makePng(5, 5);
    const result = await parser.parse(png, 'test.png', {});
    expect(result.provenance.byte_size).toBe(png.length);
  });

  it('records source_path in provenance', async () => {
    const result = await parser.parse(makePng(), 'path/to/img.png', {});
    expect(result.provenance.source_path).toBe('path/to/img.png');
  });

  it('records parser version and name', async () => {
    const result = await parser.parse(makePng(), 'test.png', {});
    expect(result.provenance.parser_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.provenance.parser_name).toBeTruthy();
  });

  it('returns empty text for images', async () => {
    const result = await parser.parse(makePng(), 'test.png', {});
    expect(result.text).toBe('');
  });

  it('defaults max_bytes to 50MB when not specified', async () => {
    const buf = Buffer.alloc(100);
    const result = await parser.parse(buf, 'test.png', {});
    expect(result).toBeDefined();
  });

  it('produces deterministic content hash for same input', async () => {
    const png = makePng(10, 20);
    const r1 = await parser.parse(png, 'a.png', {});
    const r2 = await parser.parse(png, 'b.png', {});
    expect(r1.provenance.content_hash).toBe(r2.provenance.content_hash);
  });
});
