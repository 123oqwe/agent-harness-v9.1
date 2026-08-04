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
  it('removes chunk from all indices', () => {
    const store = createIndexStore();
    const doc = makeDoc('Some searchable text content here', 'src1');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(store.chunks.size).toBe(chunks.length);
    expect(store.fts.getChunkIds().length).toBe(chunks.length);
    const removed = removeChunkFromStore(store, chunks[0]!.chunk_id);
    expect(removed).toBe(true);
    expect(store.chunks.size).toBe(chunks.length - 1);
    expect(store.fts.getChunkIds().length).toBe(chunks.length - 1);
    expect(store.metadata.getChunkIds().length).toBe(chunks.length - 1);
  });

  it('deletes all chunks by source hash', () => {
    const store = createIndexStore();
    const doc1 = makeDoc('First document content', 'src1');
    const doc2 = makeDoc('Second document content', 'src2');
    const chunks1 = chunkDocument(doc1, { tenant_id: 't1', principal_ids: ['p1'] });
    const chunks2 = chunkDocument(doc2, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of [...chunks1, ...chunks2]) addChunkToStore(store, c, { tenant_id: 't1', principal_ids: ['p1'] });
    const deleted = deleteFromStore(store, 'src1');
    expect(deleted).toBe(chunks1.length);
    expect(store.chunks.size).toBe(chunks2.length);
  });

  it('returns false for non-existent chunk', () => {
    const store = createIndexStore();
    expect(removeChunkFromStore(store, 'nonexistent')).toBe(false);
  });
});
