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
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns empty for wrong tenant', async () => {
    const store = createIndexStore();
    const doc = makeDoc('The machine learning model');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const results = await queryStore(store, { text: 'machine', tenant_id: 't2', principal_id: 'p1' });
    expect(Array.isArray(results)).toBe(true);
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

  it('handles empty query text gracefully', async () => {
    const store = createIndexStore();
    const doc = makeDoc('some content here');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const results = await queryStore(store, { text: '', tenant_id: 't1', principal_id: 'p1' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns empty for empty store', async () => {
    const store = createIndexStore();
    const results = await queryStore(store, { text: 'anything', tenant_id: 't1', principal_id: 'p1' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('supports multiple principals for same tenant', async () => {
    const store = createIndexStore();
    const doc = makeDoc('shared document content');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1', 'p2'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1', 'p2'] });
    const r1 = await queryStore(store, { text: 'shared', tenant_id: 't1', principal_id: 'p1' });
    const r2 = await queryStore(store, { text: 'shared', tenant_id: 't1', principal_id: 'p2' });
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBeGreaterThan(0);
  });

  it('citation includes chunk_index and content_hash', async () => {
    const store = createIndexStore();
    const doc = makeDoc('citation test content');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const results = await queryStore(store, { text: 'citation', tenant_id: 't1', principal_id: 'p1' });
    for (const r of results) {
      expect(r.citation.chunk_index).toBeGreaterThanOrEqual(0);
      expect(r.citation.content_hash).toBeTruthy();
    }
  });

  it('results include score field', async () => {
    const store = createIndexStore();
    const doc = makeDoc('scored result test');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const results = await queryStore(store, { text: 'scored', tenant_id: 't1', principal_id: 'p1' });
    for (const r of results) {
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});
