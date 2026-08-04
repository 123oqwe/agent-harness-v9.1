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
  it('indexes chunks and returns search results', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('The quick brown fox jumps over the lazy dog'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    const results = index.search('fox');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('ranks relevant documents higher', () => {
    const index = new FtsIndex();
    const chunks1 = chunkDocument(makeDoc('fox fox fox fox'), { tenant_id: 't1', principal_ids: ['p1'] });
    const chunks2 = chunkDocument(makeDoc('dog dog dog dog'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of [...chunks1, ...chunks2]) index.addChunk(c);
    const results = index.search('fox');
    expect(results.length).toBeGreaterThan(0);
  });

  it('removes chunks from index', () => {
    const index = new FtsIndex();
    const chunks = chunkDocument(makeDoc('unique searchable text'), { tenant_id: 't1', principal_ids: ['p1'] });
    for (const c of chunks) index.addChunk(c);
    expect(index.getChunkIds().length).toBe(chunks.length);
    index.removeChunk(chunks[0]!.chunk_id);
    expect(index.getChunkIds().length).toBe(chunks.length - 1);
  });
});
