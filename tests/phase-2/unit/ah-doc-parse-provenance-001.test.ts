import { describe, expect, it } from 'vitest';
import { DefaultDocumentIngestor } from '../../../packages/documents/src/index.js';

describe('AH-DOC-PARSE-PROVENANCE-001: Track parser version and provenance', () => {
  const ingestor = new DefaultDocumentIngestor();

  it('records parser version and name', () => {
    const buf = Buffer.from('# Test\n', 'utf8');
    return ingestor.ingest(buf, 'doc.md', {}).then(result => {
      expect(result.provenance.parser_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.provenance.parser_name).toBeTruthy();
    });
  });

  it('records content hash deterministically', () => {
    const buf = Buffer.from('# Same content\n', 'utf8');
    return Promise.all([
      ingestor.ingest(buf, 'a.md', {}),
      ingestor.ingest(buf, 'b.md', {}),
    ]).then(([r1, r2]) => {
      expect(r1.provenance.content_hash).toBe(r2.provenance.content_hash);
      expect(r1.provenance.content_hash).toHaveLength(64);
    });
  });

  it('records byte size', () => {
    const buf = Buffer.from('# Test\n\nContent here.\n', 'utf8');
    return ingestor.ingest(buf, 'doc.md', {}).then(result => {
      expect(result.provenance.byte_size).toBe(buf.length);
    });
  });

  it('records format correctly', () => {
    const buf = Buffer.from('# Test\n', 'utf8');
    return ingestor.ingest(buf, 'doc.md', {}).then(result => {
      expect(result.provenance.format).toBe('md');
    });
  });

  it('records ingested_at timestamp', () => {
    const buf = Buffer.from('# Test\n', 'utf8');
    return ingestor.ingest(buf, 'doc.md', {}).then(result => {
      expect(result.provenance.ingested_at).toBeTruthy();
      const dt = new Date(result.provenance.ingested_at);
      expect(dt.getTime()).not.toBeNaN();
    });
  });

  it('produces different content hashes for different content', async () => {
    const r1 = await ingestor.ingest(Buffer.from('# Content A\n', 'utf8'), 'a.md', {});
    const r2 = await ingestor.ingest(Buffer.from('# Content B\n', 'utf8'), 'b.md', {});
    expect(r1.provenance.content_hash).not.toBe(r2.provenance.content_hash);
  });

  it('records source path in provenance', async () => {
    const buf = Buffer.from('# Test\n', 'utf8');
    const result = await ingestor.ingest(buf, 'path/to/doc.md', {});
    expect(result.provenance.source_path).toBe('path/to/doc.md');
  });

  it('records parser name for markdown format', async () => {
    const buf = Buffer.from('# Test\n', 'utf8');
    const result = await ingestor.ingest(buf, 'doc.md', {});
    expect(result.provenance.parser_name).toBeTruthy();
    expect(typeof result.provenance.parser_name).toBe('string');
  });

  it('ingested_at is a valid ISO timestamp', async () => {
    const buf = Buffer.from('# Test\n', 'utf8');
    const result = await ingestor.ingest(buf, 'doc.md', {});
    expect(result.provenance.ingested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('byte_size matches buffer length for various sizes', async () => {
    for (const size of [10, 100, 1000]) {
      const buf = Buffer.alloc(size, 0x41);
      const result = await ingestor.ingest(buf, 'test.md', {});
      expect(result.provenance.byte_size).toBe(size);
    }
  });

  it('records source path in provenance', async () => {
    const result = await ingestor.ingest(Buffer.from('# Test\n', 'utf8'), 'custom/path.md', {});
    expect(result.provenance.source_path).toBe('custom/path.md');
  });

  it('records byte size in provenance', async () => {
    const buf = Buffer.from('# Test\nMore content.', 'utf8');
    const result = await ingestor.ingest(buf, 'size.md', {});
    expect(result.provenance.byte_size).toBe(buf.byteLength);
  });

  it('records format in provenance', async () => {
    const result = await ingestor.ingest(Buffer.from('# Test\n', 'utf8'), 'test.md', {});
    expect(result.provenance.format).toBeTruthy();
  });

  it('records ingested_at timestamp', async () => {
    const result = await ingestor.ingest(Buffer.from('# Test\n', 'utf8'), 'test.md', {});
    expect(result.provenance.ingested_at).toBeTruthy();
  });

  it('different content produces different content hashes', async () => {
    const r1 = await ingestor.ingest(Buffer.from('# Content A\n', 'utf8'), 'a.md', {});
    const r2 = await ingestor.ingest(Buffer.from('# Content B\n', 'utf8'), 'b.md', {});
    expect(r1.provenance.content_hash).not.toBe(r2.provenance.content_hash);
  });

  it('same content produces same content hash', async () => {
    const buf = Buffer.from('# Same content\n', 'utf8');
    const r1 = await ingestor.ingest(buf, 'a.md', {});
    const r2 = await ingestor.ingest(buf, 'b.md', {});
    expect(r1.provenance.content_hash).toBe(r2.provenance.content_hash);
  });

  it('records content hash as hex string', async () => {
    const result = await ingestor.ingest(Buffer.from('# Test\n', 'utf8'), 'test.md', {});
    expect(result.provenance.content_hash).toMatch(/^[0-9a-f]+$/);
  });

  it('content hash is 64 chars (SHA-256)', async () => {
    const result = await ingestor.ingest(Buffer.from('# Test\n', 'utf8'), 'test.md', {});
    expect(result.provenance.content_hash).toHaveLength(64);
  });

  it('handles empty content', async () => {
    const result = await ingestor.ingest(Buffer.alloc(0), 'empty.md', {});
    expect(result.provenance.byte_size).toBe(0);
  });

  it('handles very large content', async () => {
    const buf = Buffer.alloc(100000, 0x41);
    const result = await ingestor.ingest(buf, 'large.md', {});
    expect(result.provenance.byte_size).toBe(100000);
  });

  it('handles Unicode content', async () => {
    const result = await ingestor.ingest(Buffer.from('# 中文标题\n', 'utf8'), 'unicode.md', {});
    expect(result.provenance.byte_size).toBeGreaterThan(0);
  });

  it('parser_name is non-empty string', async () => {
    const result = await ingestor.ingest(Buffer.from('# Test\n', 'utf8'), 'test.md', {});
    expect(result.provenance.parser_name).toBeTruthy();
    expect(typeof result.provenance.parser_name).toBe('string');
  });

  it('parser_version follows semver', async () => {
    const result = await ingestor.ingest(Buffer.from('# Test\n', 'utf8'), 'test.md', {});
    expect(result.provenance.parser_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

});
