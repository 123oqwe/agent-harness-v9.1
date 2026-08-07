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
});
