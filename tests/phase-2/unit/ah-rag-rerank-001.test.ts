import { describe, expect, it } from 'vitest';
import { rerankResults } from '../../../packages/rag/src/index.js';
import type { RagRetrievalResult } from '../../../packages/rag/src/index.js';

function makeResult(id: string, score: number, text: string): RagRetrievalResult {
  return {
    chunk: {
      chunk_id: id, source_hash: 'src',
      provenance: { source_path: 'test.md', format: 'md', parser_version: '1.0', parser_name: 'test', ingested_at: '', content_hash: 'abc', byte_size: text.length },
      text, chunk_index: 0, start_offset: 0, end_offset: text.length,
      content_hash: 'hash', page: undefined, metadata: {},
    },
    score,
    source: 'fts',
    citation: { source_path: 'test.md', source_hash: 'src', page: undefined, chunk_index: 0, content_hash: 'hash', excerpt: text.slice(0, 100) },
  };
}

describe('AH-RAG-RERANK-001: Rerank retrieval results', () => {
  it('preserves top results', () => {
    const results = [
      makeResult('a', 0.9, 'machine learning'),
      makeResult('b', 0.7, 'deep learning'),
      makeResult('c', 0.5, 'cooking recipes'),
    ];
    const reranked = rerankResults(results, { top_k: 3 });
    expect(reranked).toHaveLength(3);
    expect(reranked[0]!.chunk.chunk_id).toBe('a');
  });

  it('limits to top_k', () => {
    const results = Array.from({ length: 20 }, (_, i) => makeResult(`c${i}`, 1 - i * 0.05, `text ${i}`));
    const reranked = rerankResults(results, { top_k: 5 });
    expect(reranked).toHaveLength(5);
  });

  it('promotes diversity', () => {
    const results = [
      makeResult('a', 0.9, 'machine learning model'),
      makeResult('b', 0.85, 'machine learning model'),
      makeResult('c', 0.5, 'cooking recipes pasta'),
    ];
    const reranked = rerankResults(results, { top_k: 2, diversity_lambda: 0.5 });
    // With diversity, 'c' might be preferred over 'b' since it's different from 'a'
    expect(reranked).toHaveLength(2);
    expect(reranked[0]!.chunk.chunk_id).toBe('a');
  });
});
