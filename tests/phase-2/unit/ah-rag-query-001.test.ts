import { describe, expect, it } from 'vitest';
import { createIndexStore, addChunkToStore, queryStore, chunkDocument } from '../../../packages/rag/src/index.js';
import type { DocumentIngestResult } from '../../../packages/rag/src/index.js';

function makeDoc(text: string): DocumentIngestResult {
  return {
    provenance: { source_path: 'test.md', format: 'md', parser_version: '1.0', parser_name: 'test', ingested_at: '', content_hash: 'abc', byte_size: text.length },
    text, headings: [], tables: [], images: [], pages: undefined, metadata: {},
  };
}

describe('AH-RAG-QUERY-001: ACL-filtered hybrid retrieval', () => {
  it('returns results for authorized principal', async () => {
    const store = createIndexStore();
    const doc = makeDoc('The machine learning model achieves high accuracy');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const results = await queryStore(store, { text: 'machine learning', tenant_id: 't1', principal_id: 'p1' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns empty for unauthorized principal', async () => {
    const store = createIndexStore();
    const doc = makeDoc('The machine learning model achieves high accuracy');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const results = await queryStore(store, { text: 'machine learning', tenant_id: 't1', principal_id: 'p2' });
    expect(results).toHaveLength(0);
  });

  it('returns empty for wrong tenant', async () => {
    const store = createIndexStore();
    const doc = makeDoc('The machine learning model');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const results = await queryStore(store, { text: 'machine', tenant_id: 't2', principal_id: 'p1' });
    expect(results).toHaveLength(0);
  });

  it('includes citations in results', async () => {
    const store = createIndexStore();
    const doc = makeDoc('The machine learning model');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const results = await queryStore(store, { text: 'machine', tenant_id: 't1', principal_id: 'p1' });
    for (const r of results) {
      expect(r.citation.source_path).toBe('test.md');
      expect(r.citation.source_hash).toBe('abc');
    }
  });
});
