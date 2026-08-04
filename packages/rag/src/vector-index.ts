import type { RagEmbedding, RagEmbeddingModel } from './types.js';

export class VectorIndex {
  private readonly embeddings = new Map<string, RagEmbedding>();
  private model: RagEmbeddingModel | undefined;

  setModel(model: RagEmbeddingModel): void {
    if (this.model && this.model.model_id !== model.model_id) {
      throw new Error(`vector index model mismatch: ${this.model.model_id} vs ${model.model_id}`);
    }
    this.model = model;
  }

  getModel(): RagEmbeddingModel | undefined {
    return this.model;
  }

  addEmbedding(embedding: RagEmbedding): void {
    if (this.model && this.model.model_id !== embedding.model.model_id) {
      throw new Error(`embedding model mismatch: expected ${this.model.model_id}, got ${embedding.model.model_id}`);
    }
    this.embeddings.set(embedding.chunk_id, embedding);
  }

  removeEmbedding(chunkId: string): void {
    this.embeddings.delete(chunkId);
  }

  search(queryVector: readonly number[], topK = 10): Array<{ chunk_id: string; score: number }> {
    const results: Array<{ chunk_id: string; score: number }> = [];
    for (const [chunkId, embedding] of this.embeddings) {
      const score = cosineSimilarity(queryVector, embedding.vector);
      results.push({ chunk_id: chunkId, score });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  getChunkIds(): readonly string[] {
    return [...this.embeddings.keys()];
  }

  size(): number {
    return this.embeddings.size;
  }
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
