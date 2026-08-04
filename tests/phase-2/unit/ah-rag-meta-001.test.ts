import { describe, expect, it } from 'vitest';
import { MetadataIndex } from '../../../packages/rag/src/index.js';
import type { RagChunk } from '../../../packages/rag/src/index.js';

function makeChunk(id: string, meta: Record<string, unknown>): RagChunk {
  return {
    chunk_id: id,
    source_hash: 'src1',
    provenance: { source_path: 'test.md', format: 'md', parser_version: '1.0', parser_name: 'test', ingested_at: '', content_hash: 'abc', byte_size: 10 },
    text: 'test', chunk_index: 0, start_offset: 0, end_offset: 4,
    content_hash: 'chunk-hash', page: undefined, metadata: meta,
  };
}

describe('AH-RAG-META-001: Build metadata index for filtering', () => {
  it('filters chunks by metadata field', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'science' }));
    index.addChunk(makeChunk('c2', { category: 'history' }));
    index.addChunk(makeChunk('c3', { category: 'science' }));
    const result = index.filter({ category: 'science' });
    expect(result.size).toBe(2);
    expect(result.has('c1')).toBe(true);
    expect(result.has('c3')).toBe(true);
  });

  it('combines multiple filters with AND', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'science', year: '2024' }));
    index.addChunk(makeChunk('c2', { category: 'science', year: '2023' }));
    const result = index.filter({ category: 'science', year: '2024' });
    expect(result.size).toBe(1);
    expect(result.has('c1')).toBe(true);
  });

  it('removes chunks from index', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'science' }));
    index.removeChunk('c1');
    const result = index.filter({ category: 'science' });
    expect(result.size).toBe(0);
  });
});
