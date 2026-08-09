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

  it('does not link first chunk to previous (no sequential edge)', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    index.addChunk(c0, [c0]);
    expect(index.getEdgeCount()).toBe(0);
  });

  it('removes edges when chunk is removed', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    const c1 = makeChunk('src-1', 'src', 1);
    index.addChunk(c0, [c0]);
    index.addChunk(c1, [c0, c1]);
    expect(index.getEdgeCount()).toBeGreaterThan(0);
    index.removeChunk('src-1');
    expect(index.getEdgeCount()).toBe(0);
  });

  it('returns empty neighbors for isolated node', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('iso-0', 'iso', 0);
    index.addChunk(c0, [c0]);
    const neighbors = index.getNeighbors('iso-0');
    expect(neighbors.size).toBe(0);
  });

  it('returns empty neighbors for non-existent node', () => {
    const index = new GraphIndex();
    const neighbors = index.getNeighbors('nonexistent');
    expect(neighbors.size).toBe(0);
  });

  it('supports multi-depth traversal', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    const c1 = makeChunk('src-1', 'src', 1);
    const c2 = makeChunk('src-2', 'src', 2);
    index.addChunk(c0, [c0]);
    index.addChunk(c1, [c0, c1]);
    index.addChunk(c2, [c0, c1, c2]);
    const depth1 = index.getNeighbors('src-0', 1);
    const depth2 = index.getNeighbors('src-0', 2);
    expect(depth2.size).toBeGreaterThan(depth1.size);
  });

  it('tracks edge and node counts correctly', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('s-0', 's', 0);
    const c1 = makeChunk('s-1', 's', 1);
    index.addChunk(c0, [c0]);
    expect(index.getNodeCount()).toBe(1);
    expect(index.getEdgeCount()).toBe(0);
    index.addChunk(c1, [c0, c1]);
    expect(index.getNodeCount()).toBe(2);
    expect(index.getEdgeCount()).toBe(1);
  });

  it('does not create same_page edges for chunks without page', () => {
    const index = new GraphIndex();
    const c1 = makeChunk('a-0', 'a', 0);
    const c2 = makeChunk('b-0', 'b', 0);
    index.addChunk(c1, [c1]);
    index.addChunk(c2, [c1, c2]);
    const neighbors = index.getNeighbors('a-0');
    expect(neighbors.has('b-0')).toBe(false);
  });

  it('getNeighbors returns empty set for isolated node', () => {
    const index = new GraphIndex();
    index.addChunk(makeChunk('c1', 'isolated', 0), []);
    expect(index.getNeighbors('isolated').size).toBe(0);
  });

  it('getNeighbors returns empty set for non-existent node', () => {
    const index = new GraphIndex();
    expect(index.getNeighbors('nonexistent').size).toBe(0);
  });

  it('getNeighbors returns neighbors for sequential chunks', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    const c1 = makeChunk('src-1', 'src', 1);
    index.addChunk(c0, [c0]);
    index.addChunk(c1, [c0, c1]);
    const neighbors = index.getNeighbors('src-0');
    expect(neighbors.size).toBeGreaterThan(0);
    expect(neighbors.has('src-1')).toBe(true);
  });

  it('getNeighbors respects maxDepth parameter', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    const c1 = makeChunk('src-1', 'src', 1);
    const c2 = makeChunk('src-2', 'src', 2);
    index.addChunk(c0, [c0]);
    index.addChunk(c1, [c0, c1]);
    index.addChunk(c2, [c1, c2]);
    const depth1 = index.getNeighbors('src-0', 1);
    const depth2 = index.getNeighbors('src-0', 2);
    expect(depth2.size).toBeGreaterThanOrEqual(depth1.size);
  });

  it('handles multiple chunks from same source', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('shared-0', 'shared', 0);
    const c1 = makeChunk('shared-1', 'shared', 1);
    const c2 = makeChunk('shared-2', 'shared', 2);
    index.addChunk(c0, [c0]);
    index.addChunk(c1, [c0, c1]);
    index.addChunk(c2, [c1, c2]);
    expect(index.getNeighbors('shared-1').size).toBeGreaterThan(0);
  });

  it('removeChunk removes edges', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    const c1 = makeChunk('src-1', 'src', 1);
    index.addChunk(c0, [c0]);
    index.addChunk(c1, [c0, c1]);
    expect(index.getNeighbors('src-0').size).toBeGreaterThan(0);
    index.removeChunk('src-1');
    expect(index.getNeighbors('src-0').has('src-1')).toBe(false);
  });

  it('getEdgeCount returns correct count', () => {
    const index = new GraphIndex();
    const c0 = makeChunk('src-0', 'src', 0);
    const c1 = makeChunk('src-1', 'src', 1);
    index.addChunk(c0, [c0]);
    expect(index.getEdgeCount()).toBe(0);
    index.addChunk(c1, [c0, c1]);
    expect(index.getEdgeCount()).toBeGreaterThan(0);
  });

  it('getNodeCount returns correct count', () => {
    const index = new GraphIndex();
    expect(index.getNodeCount()).toBe(0);
    index.addChunk(makeChunk('src-0', 'src', 0), []);
    expect(index.getNodeCount()).toBe(1);
    index.addChunk(makeChunk('src-1', 'src', 1), []);
    expect(index.getNodeCount()).toBe(2);
  });

});
