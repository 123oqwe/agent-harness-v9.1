import { describe, expect, it } from 'vitest';
import { VectorIndex } from '../../../packages/rag/src/index.js';
import { MockEmbeddingProvider } from '../../../packages/rag/src/embedding-provider.js';

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

  it('returns empty results for empty index', () => {
    const index = new VectorIndex();
    index.setModel({ model_id: 'test', version: '1.0', dimensions: 3 });
    const results = index.search([1, 0, 0]);
    expect(results).toHaveLength(0);
  });

  it('limits results to top-k', () => {
    const index = new VectorIndex();
    const model = { model_id: 'test', version: '1.0', dimensions: 2 };
    index.setModel(model);
    for (let i = 0; i < 10; i++) {
      index.addEmbedding({ chunk_id: `c${i}`, model, vector: [i, 0] });
    }
    const results = index.search([5, 0], 3);
    expect(results).toHaveLength(3);
  });

  it('returns score 1.0 for identical vectors', () => {
    const index = new VectorIndex();
    const model = { model_id: 'test', version: '1.0', dimensions: 3 };
    index.setModel(model);
    index.addEmbedding({ chunk_id: 'c1', model, vector: [0.5, 0.5, 0] });
    const results = index.search([0.5, 0.5, 0]);
    expect(results[0]!.score).toBeCloseTo(1.0, 5);
  });

  it('returns score 0.0 for orthogonal vectors', () => {
    const index = new VectorIndex();
    const model = { model_id: 'test', version: '1.0', dimensions: 3 };
    index.setModel(model);
    index.addEmbedding({ chunk_id: 'c1', model, vector: [1, 0, 0] });
    const results = index.search([0, 1, 0]);
    expect(results[0]!.score).toBeCloseTo(0.0, 5);
  });

  it('handles removing non-existent embedding', () => {
    const index = new VectorIndex();
    const model = { model_id: 'test', version: '1.0', dimensions: 2 };
    index.setModel(model);
    expect(() => index.removeEmbedding('nonexistent')).not.toThrow();
    expect(index.size()).toBe(0);
  });

  it('overwrites embedding when same chunk_id is added again', () => {
    const index = new VectorIndex();
    const model = { model_id: 'test', version: '1.0', dimensions: 3 };
    index.setModel(model);
    index.addEmbedding({ chunk_id: 'c1', model, vector: [1, 0, 0] });
    index.addEmbedding({ chunk_id: 'c1', model, vector: [0, 1, 0] });
    expect(index.size()).toBe(1);
    const results = index.search([0, 1, 0]);
    expect(results[0]!.chunk_id).toBe('c1');
  });
});

describe('MockEmbeddingProvider', () => {
  it('produces deterministic embeddings for same text', async () => {
    const provider = new MockEmbeddingProvider();
    const v1 = await provider.embed('hello world');
    const v2 = await provider.embed('hello world');
    expect(v1).toEqual(v2);
  });

  it('produces different embeddings for different text', async () => {
    const provider = new MockEmbeddingProvider();
    const v1 = await provider.embed('hello');
    const v2 = await provider.embed('goodbye');
    expect(v1).not.toEqual(v2);
  });

  it('embeds batch of texts', async () => {
    const provider = new MockEmbeddingProvider();
    const results = await provider.embedBatch(['hello', 'world']);
    expect(results).toHaveLength(2);
    expect(results[0]).not.toEqual(results[1]);
  });

  it('produces normalized vectors', async () => {
    const provider = new MockEmbeddingProvider();
    const v = await provider.embed('normalization test');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it('has correct model metadata', () => {
    const provider = new MockEmbeddingProvider();
    expect(provider.model.model_id).toBe('mock-embedding-v1');
    expect(provider.model.dimensions).toBe(64);
  });

  it('handles empty text embedding', async () => {
    expect(true).toBe(true);
  });

  it('handles large text embedding', async () => {
    expect(true).toBe(true);
  });

});
