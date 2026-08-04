import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../../../packages/rag/src/index.js';
import type { RagChunk } from '../../../packages/rag/src/index.js';

function makeChunk(id: string, sourceHash: string, index: number, page?: number): RagChunk {
  return {
    chunk_id: id, source_hash: sourceHash,
    provenance: { source_path: 'test.md', format: 'md', parser_version: '1.0', parser_name: 'test', ingested_at: '', content_hash: sourceHash, byte_size: 10 },
    text: 'test', chunk_index: index, start_offset: 0, end_offset: 4,
    content_hash: 'chunk-hash', page, metadata: {},
  };
}

describe('AH-RAG-GRAPH-001: Build optional graph index for relationships', () => {
  it('links sequential chunks', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    const c1 = makeChunk('src-1', 'src', 1);
    index.addChunk(c0, [c0]);
    index.addChunk(c1, [c0, c1]);
    const neighbors = index.getNeighbors('src-0');
    expect(neighbors.has('src-1')).toBe(true);
  });

  it('links chunks on the same page', () => {
    const index = new GraphIndex();
    const c1 = makeChunk('a-0', 'a', 0, 5);
    const c2 = makeChunk('b-0', 'b', 0, 5);
    index.addChunk(c1, [c1]);
    index.addChunk(c2, [c1, c2]);
    const neighbors = index.getNeighbors('a-0');
    expect(neighbors.has('b-0')).toBe(true);
  });

  it('removes chunk from graph', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    const c1 = makeChunk('src-1', 'src', 1);
    index.addChunk(c0, [c0]);
    index.addChunk(c1, [c0, c1]);
    expect(index.getNodeCount()).toBe(2);
    index.removeChunk('src-1');
    expect(index.getNodeCount()).toBe(1);
  });
});
