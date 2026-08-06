import { createHash } from 'node:crypto';

/**
 * EmbeddingProviderPort: interface for real embedding APIs.
 * AH-RAG-EMBED-001 / AH-RAG-QUERY-001: Replace pseudo-embeddings with real vectors.
 */

export interface RagEmbeddingModel {
  readonly model_id: string;
  readonly version: string;
  readonly dimensions: number;
}

export interface EmbeddingProviderPort {
  readonly model: RagEmbeddingModel;
  embed(text: string): Promise<readonly number[]>;
  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/** In-memory mock provider for testing. Produces deterministic hash-based vectors. */
export class MockEmbeddingProvider implements EmbeddingProviderPort {
  readonly model: RagEmbeddingModel = {
    model_id: 'mock-embedding-v1',
    version: '1.0',
    dimensions: 64,
  };

  async embed(text: string): Promise<readonly number[]> {
    return this.hashEmbed(text);
  }

  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((t) => this.hashEmbed(t));
  }

  private hashEmbed(text: string): number[] {
    const dimensions = this.model.dimensions;
    const vector = new Array(dimensions).fill(0);
    const tokens = text.toLowerCase().split(/[\s\p{P}]+/u).filter((t) => t.length > 0);
    for (const token of tokens) {
      const hash = createHash('sha256').update(token).digest();
      for (let i = 0; i < dimensions; i++) {
        vector[i]! += hash[i % hash.length]! / 255;
      }
    }
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vector.map((v) => v / norm) : vector;
  }
}
