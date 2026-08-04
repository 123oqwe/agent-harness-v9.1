import { describe, expect, it } from 'vitest';
import { VectorIndex } from '../../../packages/rag/src/index.js';

describe('AH-RAG-EMBED-001: Generate embeddings and build vector index', () => {
  it('stores and retrieves embeddings', () => {
    const index = new VectorIndex();
    const model = { model_id: 'test-embed', version: '1.0', dimensions: 3 };
    index.setModel(model);
    index.addEmbedding({ chunk_id: 'c1', model, vector: [1, 0, 0] });
    index.addEmbedding({ chunk_id: 'c2', model, vector: [0, 1, 0] });
    const results = index.search([1, 0, 0]);
    expect(results[0]!.chunk_id).toBe('c1');
    expect(results[0]!.score).toBeGreaterThan(0.99);
  });

  it('rejects mismatched model embeddings', () => {
    const index = new VectorIndex();
    index.setModel({ model_id: 'model-a', version: '1.0', dimensions: 3 });
    expect(() => {
      index.addEmbedding({ chunk_id: 'c1', model: { model_id: 'model-b', version: '1.0', dimensions: 3 }, vector: [1, 0, 0] });
    }).toThrow();
  });

  it('removes embeddings', () => {
    const index = new VectorIndex();
    const model = { model_id: 'test', version: '1.0', dimensions: 2 };
    index.setModel(model);
    index.addEmbedding({ chunk_id: 'c1', model, vector: [1, 0] });
    expect(index.size()).toBe(1);
    index.removeEmbedding('c1');
    expect(index.size()).toBe(0);
  });

  it('computes cosine similarity correctly', () => {
    const index = new VectorIndex();
    const model = { model_id: 'test', version: '1.0', dimensions: 3 };
    index.setModel(model);
    index.addEmbedding({ chunk_id: 'c1', model, vector: [1, 0, 0] });
    index.addEmbedding({ chunk_id: 'c2', model, vector: [0, 1, 0] });
    index.addEmbedding({ chunk_id: 'c3', model, vector: [1, 1, 0] });
    const results = index.search([1, 0, 0], 3);
    expect(results[0]!.chunk_id).toBe('c1');
    expect(results[0]!.score).toBeGreaterThan(results[2]!.score);
  });
});
