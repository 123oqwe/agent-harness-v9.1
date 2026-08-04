import { describe, expect, it } from 'vitest';
import { generateCitation, formatCitation } from '../../../packages/rag/src/index.js';
import type { RagChunk } from '../../../packages/rag/src/index.js';

function makeChunk(page?: number): RagChunk {
  return {
    chunk_id: 'c1', source_hash: 'abc123',
    provenance: { source_path: 'report.pdf', format: 'pdf', parser_version: '1.0', parser_name: 'pdf-native', ingested_at: '', content_hash: 'abc123', byte_size: 100 },
    text: 'This is the cited content.', chunk_index: 3, start_offset: 0, end_offset: 24,
    content_hash: 'chunk-hash-123', page, metadata: {},
  };
}

describe('AH-RAG-CITE-001: Generate citations with page references', () => {
  it('generates citation with page reference', () => {
    const chunk = makeChunk(5);
    const citation = generateCitation(chunk);
    expect(citation.source_path).toBe('report.pdf');
    expect(citation.page).toBe(5);
    expect(citation.chunk_index).toBe(3);
    expect(citation.content_hash).toBe('chunk-hash-123');
  });

  it('generates citation without page reference', () => {
    const chunk = makeChunk(undefined);
    const citation = generateCitation(chunk);
    expect(citation.page).toBeUndefined();
  });

  it('includes excerpt in citation', () => {
    const chunk = makeChunk(1);
    const citation = generateCitation(chunk);
    expect(citation.excerpt).toContain('cited content');
  });

  it('formats citation as readable string', () => {
    const chunk = makeChunk(5);
    const citation = generateCitation(chunk);
    const formatted = formatCitation(citation);
    expect(formatted).toContain('report.pdf');
    expect(formatted).toContain('page 5');
  });
});
