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
});
