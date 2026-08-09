import { describe, expect, it } from 'vitest';
import { MetadataIndex } from '../../../packages/rag/src/index.js';
import type { RagChunk } from '../../../packages/rag/src/index.js';

function makeChunk(id: string, meta: Record<string, unknown>, opts?: { source_hash?: string; page?: number }): RagChunk {
  return {
    chunk_id: id,
    source_hash: opts?.source_hash ?? 'src1',
    provenance: { source_path: 'test.md', format: 'md', parser_version: '1.0', parser_name: 'test', ingested_at: '', content_hash: 'abc', byte_size: 10 },
    text: 'test', chunk_index: 0, start_offset: 0, end_offset: 4,
    content_hash: 'chunk-hash', page: opts?.page, metadata: meta,
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

  it('returns all chunks when no filter provided', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'a' }));
    index.addChunk(makeChunk('c2', { category: 'b' }));
    const result = index.filter({});
    expect(result.size).toBe(2);
  });

  it('returns empty set for non-matching filter', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'science' }));
    const result = index.filter({ category: 'nonexistent' });
    expect(result.size).toBe(0);
  });

  it('indexes source_hash for filtering', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', {}, { source_hash: 'doc-a' }));
    index.addChunk(makeChunk('c2', {}, { source_hash: 'doc-b' }));
    const result = index.filter({ source_hash: 'doc-a' });
    expect(result.size).toBe(1);
    expect(result.has('c1')).toBe(true);
  });

  it('indexes page number for filtering', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', {}, { page: 1 }));
    index.addChunk(makeChunk('c2', {}, { page: 2 }));
    const result = index.filter({ page: '1' });
    expect(result.size).toBe(1);
    expect(result.has('c1')).toBe(true);
  });

  it('retrieves chunk by ID', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'science' }));
    const chunk = index.getChunk('c1');
    expect(chunk).toBeDefined();
    expect(chunk!.chunk_id).toBe('c1');
    expect(chunk!.metadata.category).toBe('science');
  });

  it('returns undefined for non-existent chunk ID', () => {
    const index = new MetadataIndex();
    expect(index.getChunk('nonexistent')).toBeUndefined();
  });

  it('lists all chunk IDs', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { x: 1 }));
    index.addChunk(makeChunk('c2', { x: 2 }));
    const ids = index.getChunkIds();
    expect(ids.length).toBe(2);
    expect(ids).toContain('c1');
    expect(ids).toContain('c2');
  });

  it('handles removal of non-existent chunk gracefully', () => {
    const index = new MetadataIndex();
    expect(() => index.removeChunk('nonexistent')).not.toThrow();
  });

  it('handles numeric and boolean metadata values', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { count: 42, active: true }));
    index.addChunk(makeChunk('c2', { count: 10, active: false }));
    expect(index.filter({ count: 42 }).size).toBe(1);
    expect(index.filter({ active: true }).size).toBe(1);
  });

  it('returns empty set for non-existent field value', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'tech' }));
    expect(index.filter({ category: 'nonexistent' }).size).toBe(0);
  });

  it('returns empty set for non-existent field name', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'tech' }));
    expect(index.filter({ nonexistent: 'value' }).size).toBe(0);
  });

  it('handles multiple values for same field', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { tag: 'alpha' }));
    index.addChunk(makeChunk('c2', { tag: 'alpha' }));
    index.addChunk(makeChunk('c3', { tag: 'beta' }));
    expect(index.filter({ tag: 'alpha' }).size).toBe(2);
    expect(index.filter({ tag: 'beta' }).size).toBe(1);
  });

  it('handles special characters in field values', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { path: '/usr/local/bin' }));
    expect(index.filter({ path: '/usr/local/bin' }).size).toBe(1);
  });

  it('handles numeric metadata values', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { priority: 5 }));
    expect(index.filter({ priority: 5 }).size).toBe(1);
  });

  it('handles boolean metadata values', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { published: true }));
    expect(index.filter({ published: true }).size).toBe(1);
  });

  it('removes chunk from index', () => {
    const index = new MetadataIndex();
    index.addChunk(makeChunk('c1', { category: 'tech' }));
    expect(index.filter({ category: 'tech' }).size).toBe(1);
    index.removeChunk('c1');
    expect(index.filter({ category: 'tech' }).size).toBe(0);
  });

  it('handles removing non-existent chunk', () => {
    const index = new MetadataIndex();
    index.removeChunk('nonexistent');
  });

});
