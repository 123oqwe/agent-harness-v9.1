import { describe, expect, it } from 'vitest';
import { createIndexStore, addChunkToStore, removeChunkFromStore, deleteFromStore, chunkDocument } from '../../../packages/rag/src/index.js';
import type { DocumentIngestResult } from '../../../packages/rag/src/index.js';

function makeDoc(text: string, hash: string): DocumentIngestResult {
  return {
    provenance: { source_path: 'test.md', format: 'md', parser_version: '1.0', parser_name: 'test', ingested_at: '', content_hash: hash, byte_size: text.length },
    text, headings: [], tables: [], images: [], pages: undefined, metadata: {},
  };
}

describe('AH-RAG-DELETE-001: Propagate deletions to all indices', () => {
  it('removes chunk from all indices', async () => {
    const store = createIndexStore();
    const doc = makeDoc('Some searchable text content here', 'src1');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(store.chunks.size).toBe(chunks.length);
    expect(store.fts.getChunkIds().length).toBe(chunks.length);
    const removed = removeChunkFromStore(store, chunks[0]!.chunk_id);
    expect(removed).toBe(true);
    expect(store.chunks.size).toBe(chunks.length - 1);
    expect(store.fts.getChunkIds().length).toBe(chunks.length - 1);
    expect(store.metadata.getChunkIds().length).toBe(chunks.length - 1);
  });

  it('deletes all chunks by source hash', async () => {
    const store = createIndexStore();
    const doc1 = makeDoc('First document content', 'src1');
    const doc2 = makeDoc('Second document content', 'src2');
    const chunks1 = chunkDocument(doc1, { tenant_id: 't1', principal_ids: ['p1'] });
    const chunks2 = chunkDocument(doc2, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of [...chunks1, ...chunks2]) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const deleted = deleteFromStore(store, 'src1');
    expect(deleted).toBe(chunks1.length);
    expect(store.chunks.size).toBe(chunks2.length);
  });

  it('returns false for non-existent chunk', () => {
    const store = createIndexStore();
    expect(removeChunkFromStore(store, 'nonexistent')).toBe(false);
  });

  it('deleted chunk no longer appears in FTS search results', async () => {
    const store = createIndexStore();
    const doc = makeDoc('unique searchable keyword here', 'src1');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(store.fts.search('keyword').length).toBeGreaterThan(0);
    removeChunkFromStore(store, chunks[0]!.chunk_id);
    expect(store.fts.search('keyword').length).toBe(0);
  });

  it('deleting from non-existent source returns 0', async () => {
    const store = createIndexStore();
    const doc = makeDoc('test content', 'src1');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(deleteFromStore(store, 'nonexistent')).toBe(0);
  });

  it('preserves other chunks when deleting by source hash', async () => {
    const store = createIndexStore();
    const doc1 = makeDoc('first document content with keyword', 'src1');
    const doc2 = makeDoc('second document content with keyword', 'src2');
    const chunks1 = chunkDocument(doc1, { tenant_id: 't1', principal_ids: ['p1'] });
    const chunks2 = chunkDocument(doc2, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of [...chunks1, ...chunks2]) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    deleteFromStore(store, 'src1');
    const results = store.fts.search('keyword');
    expect(results.length).toBeGreaterThan(0);
  });
  it('handles deleting non-existent chunk', () => {
    const store = createIndexStore();
    const result = removeChunkFromStore(store, 'nonexistent');
    expect(result).toBe(false);
  });

  it('deletes and re-queries returns empty', async () => {
    const store = createIndexStore();
    const doc = makeDoc('test content for deletion', 'src1');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    removeChunkFromStore(store, chunks[0]!.chunk_id);
    expect(removeChunkFromStore(store, chunks[0]!.chunk_id)).toBe(false);
  });

  it('returns false when deleting non-existent chunk', async () => {
    const store = createIndexStore();
    expect(removeChunkFromStore(store, 'nonexistent')).toBe(false);
  });

  it('clears all chunks from store', async () => {
    const store = createIndexStore();
    const doc = makeDoc('searchable text content', 'src1');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(store.chunks.size).toBeGreaterThan(0);
    for (const c of chunks) removeChunkFromStore(store, c.chunk_id);
    expect(store.chunks.size).toBe(0);
  });

  it('handles delete on empty store', () => {
    const store = createIndexStore();
    expect(removeChunkFromStore(store, 'any')).toBe(false);
  });

  it('handles re-adding after deletion', async () => {
    const store = createIndexStore();
    const doc = makeDoc('searchable text', 'src1');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) await addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    removeChunkFromStore(store, chunks[0]!.chunk_id);
    await addChunkToStore(store, chunks[0]!, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(store.chunks.size).toBe(chunks.length);
  })


  it('handles deleting from empty store', async () => {
    const store = createIndexStore();
    expect(removeChunkFromStore(store, 'any')).toBe(false);
  });

  it('store has correct initial state', () => {
    const store = createIndexStore();
    expect(store.chunks.size).toBe(0);
  });

});