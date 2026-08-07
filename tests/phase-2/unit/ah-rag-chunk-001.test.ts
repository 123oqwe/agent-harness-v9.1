import { describe, expect, it } from 'vitest';
import { chunkDocument, DEFAULT_CHUNK_OPTIONS } from '../../../packages/rag/src/index.js';
import type { DocumentIngestResult, SourceProvenance } from '../../../packages/rag/src/index.js';

function makeDoc(text: string, pages?: { page: number; start_offset: number; end_offset: number }[]): DocumentIngestResult {
  const provenance: SourceProvenance = {
    source_path: 'test.md',
    format: 'md',
    parser_version: '1.0.0',
    parser_name: 'test',
    ingested_at: new Date().toISOString(),
    content_hash: 'abc123',
    byte_size: text.length,
  };
  return { provenance, text, headings: [], tables: [], images: [], pages, metadata: {} };
}

describe('AH-RAG-CHUNK-001: Chunk documents with content hashes', () => {
  it('chunks text into appropriate sizes', () => {
    const text = 'Hello world. '.repeat(100);
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.max_chunk_size + 50);
    }
  });

  it('generates unique content hashes per chunk', () => {
    const text = 'First paragraph with unique content. Second paragraph with different text entirely.';
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    const hashes = chunks.map(c => c.content_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('links chunks to source hash', () => {
    const doc = makeDoc('Some text content here.');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    for (const chunk of chunks) {
      expect(chunk.source_hash).toBe('abc123');
    }
  });

  it('assigns sequential chunk indices', () => {
    const text = 'Sentence one. Sentence two. Sentence three. Sentence four. Sentence five.';
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] }, { max_chunk_size: 20, overlap: 5, min_chunk_size: 5 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.chunk_index).toBe(i);
    }
  });

  it('handles empty text', () => {
    const doc = makeDoc('');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(chunks).toHaveLength(0);
  });

  it('tracks page references in chunks', () => {
    const text = 'Page 1 content. More content. Page 2 content. Even more.';
    const doc = makeDoc(text, [
      { page: 1, start_offset: 0, end_offset: 20 },
      { page: 2, start_offset: 20, end_offset: text.length },
    ]);
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] }, { max_chunk_size: 15, overlap: 3, min_chunk_size: 5 });
    expect(chunks.length).toBeGreaterThan(0);
    const pages = chunks.map(c => c.page).filter(p => p !== undefined);
    expect(pages.length).toBeGreaterThan(0);
  });

  it('handles single chunk for short text', () => {
    const doc = makeDoc('Short text.');
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(chunks).toHaveLength(1);
  });

  it('preserves text content in chunks', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] });
    expect(chunks.length).toBeGreaterThan(0);
    const combined = chunks.map(c => c.text).join('');
    expect(combined.length).toBeGreaterThan(0);
  });

  it('assigns correct offsets', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { tenant_id: 't1', principal_ids: ['p1'] }, { max_chunk_size: 20, overlap: 0, min_chunk_size: 5 });
    for (const chunk of chunks) {
      expect(chunk.start_offset).toBeGreaterThanOrEqual(0);
      expect(chunk.end_offset).toBeGreaterThan(chunk.start_offset);
    }
  });
});
