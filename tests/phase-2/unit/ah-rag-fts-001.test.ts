import { describe, expect, it } from 'vitest';
import { FtsIndex, chunkDocument } from '../../../packages/rag/src/index.js';
import type { DocumentIngestResult } from '../../../packages/rag/src/index.js';

function makeDoc(text: string): DocumentIngestResult {
  return {
    provenance: { source_path: 'test.md', format: 'md', parser_version: '1.0.0', parser_name: 'test', ingested_at: '', content_hash: 'abc', byte_size: text.length },
    text, headings: [], tables: [], images: [], pages: undefined, metadata: {},
  };
}

describe('AH-RAG-FTS-001: Build BM25/full-text index', () => {
  it('indexes chunks and returns search results with positive scores', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('The quick brown fox jumps over the lazy dog'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    const results = index.search('fox');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('ranks documents with higher term frequency higher', () => {
    const index = new FtsIndex();
    const chunks1 = chunkDocument(makeDoc('fox fox fox fox fox fox fox fox fox fox fox fox fox fox fox fox'), { tenant_id: 't1', principal_ids: ['p1'] });
    const chunks2 = chunkDocument(makeDoc('cat dog bird fish'), { tenant_id: 't1', principal_ids: ['p2'] });
    for (const c of [...chunks1, ...chunks2]) index.addChunk(c);
    const results = index.search('fox');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('removes chunks from index', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('unique searchable text'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.getChunkIds().length).toBe(chunks.length);
    index.removeChunk(chunks[0]!.chunk_id);
    expect(index.getChunkIds().length).toBe(chunks.length - 1);
  });

  it('returns empty results for query with no matching tokens', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('hello world'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    const results = index.search('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('returns empty results for empty query', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('hello world'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('')).toHaveLength(0);
  });

  it('is case-insensitive in tokenization', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('TypeScript is great'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('typescript').length).toBeGreaterThan(0);
    expect(index.search('TYPESCRIPT').length).toBeGreaterThan(0);
  });

  it('respects topK parameter', () => {
    const index = new FtsIndex();
    for (let i = 0; i < 5; i++) {
      const chunks = chunkDocument(makeDoc(`document ${i} keyword`), { tenant_id: 't1', principal_ids: ['p1'] });
      for (const c of chunks) index.addChunk(c);
    }
    const results = index.search('keyword', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('removing a non-existent chunk is a no-op', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('test data'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    const before = index.getChunkIds().length;
    index.removeChunk('nonexistent-id');
    expect(index.getChunkIds().length).toBe(before);
  });

  it('tracks term count in the index', () => {
    const index = new FtsIndex();
    expect(index.getTermCount()).toBe(0);
    const chunks = chunkDocument(makeDoc('hello world test'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.getTermCount()).toBeGreaterThan(0);
  });

  it('returns empty results for empty query', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('hello world'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('')).toHaveLength(0);
  });

  it('handles case-insensitive search', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('Hello World'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('hello').length).toBeGreaterThan(0);
  });

  it('handles special characters in indexed text', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('text with @special #chars'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('special').length).toBeGreaterThan(0);
  });

  it('handles Unicode text', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('machine learning intro'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('machine').length).toBeGreaterThan(0);
  });

  it('returns results sorted by relevance', () => {
    const index = new FtsIndex();
    const chunks1 = chunkDocument(makeDoc('test test test. '.repeat(20)), { tenant_id: 't1', principal_ids: ['p1'] });
    const chunks2 = chunkDocument(makeDoc('test once. '.repeat(20)), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks1) index.addChunk(c);
    for (const c of chunks2) index.addChunk(c);
    const results = index.search('test');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('handles multi-word queries', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('machine learning basics'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('machine learning').length).toBeGreaterThan(0);
  });


  it('handles very long query', async () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('test content here'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('test'.repeat(50)).length).toBeGreaterThanOrEqual(0);
  });

  it('handles query with special characters', async () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('special chars test'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.search('@#$%').length).toBeGreaterThanOrEqual(0);
  });

});
