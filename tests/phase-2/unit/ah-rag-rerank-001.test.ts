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
    expect(reranked).toHaveLength(2);
    expect(reranked[0]!.chunk.chunk_id).toBe('a');
  });

  it('returns empty array for empty input', () => {
    const reranked = rerankResults([], { top_k: 5 });
    expect(reranked).toHaveLength(0);
  });

  it('returns single result unchanged', () => {
    const results = [makeResult('only', 0.9, 'unique content')];
    const reranked = rerankResults(results, { top_k: 5 });
    expect(reranked).toHaveLength(1);
    expect(reranked[0]!.chunk.chunk_id).toBe('only');
  });

  it('defaults top_k to 10 when not specified', () => {
    const results = Array.from({ length: 15 }, (_, i) => makeResult(`c${i}`, 1 - i * 0.05, `text ${i}`));
    const reranked = rerankResults(results);
    expect(reranked).toHaveLength(10);
  });

  it('handles top_k larger than results', () => {
    const results = [makeResult('a', 0.9, 'a'), makeResult('b', 0.8, 'b')];
    const reranked = rerankResults(results, { top_k: 100 });
    expect(reranked).toHaveLength(2);
  });

  it('selects highest score first', () => {
    const results = [
      makeResult('low', 0.1, 'low score'),
      makeResult('high', 0.95, 'high score'),
      makeResult('mid', 0.5, 'mid score'),
    ];
    const reranked = rerankResults(results, { top_k: 3, diversity_lambda: 1.0 });
    expect(reranked[0]!.chunk.chunk_id).toBe('high');
  });

  it('with zero diversity lambda, purely uses score', () => {
    const results = [
      makeResult('a', 0.9, 'same text'),
      makeResult('b', 0.8, 'same text'),
      makeResult('c', 0.7, 'same text'),
    ];
    const reranked = rerankResults(results, { top_k: 3, diversity_lambda: 1.0 });
    expect(reranked.map(r => r.chunk.chunk_id)).toEqual(['a', 'b', 'c']);
  });

  it('with high diversity, prefers dissimilar results', () => {
    const results = [
      makeResult('a', 0.9, 'machine learning ai'),
      makeResult('b', 0.88, 'machine learning ai'),
      makeResult('c', 0.3, 'cooking pasta recipe'),
    ];
    const reranked = rerankResults(results, { top_k: 2, diversity_lambda: 0.1 });
    expect(reranked).toHaveLength(2);
    expect(reranked[0]!.chunk.chunk_id).toBe('a');
    // With high diversity penalty, 'c' should be preferred over 'b'
    expect(reranked[1]!.chunk.chunk_id).toBe('c');
  });

  it('does not modify original results array', () => {
    const results = [makeResult('a', 0.9, 'a'), makeResult('b', 0.8, 'b')];
    const original = [...results];
    rerankResults(results, { top_k: 2 });
    expect(results).toEqual(original);
  });
});
