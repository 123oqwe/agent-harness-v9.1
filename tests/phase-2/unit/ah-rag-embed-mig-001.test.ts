import { describe, expect, it } from 'vitest';
import { EmbeddingMigrator } from '../../../packages/rag/src/index.js';
import type { RagEmbedding, RagEmbeddingModel } from '../../../packages/rag/src/index.js';

describe('AH-RAG-EMBED-MIG-001: Handle embedding model migration', () => {
  it('migrates embeddings to new model', async () => {
    const migrator = new EmbeddingMigrator();
    const oldModel: RagEmbeddingModel = { model_id: 'old-v1', version: '1.0', dimensions: 3 };
    const newModel: RagEmbeddingModel = { model_id: 'new-v2', version: '2.0', dimensions: 4 };
    const embeddings: RagEmbedding[] = [
      { chunk_id: 'c1', model: oldModel, vector: [1, 0, 0] },
      { chunk_id: 'c2', model: oldModel, vector: [0, 1, 0] },
    ];
    const texts = new Map([['c1', 'text1'], ['c2', 'text2']]);
    const reembed = async () => [0.1, 0.2, 0.3, 0.4];
    const result = await migrator.migrate(embeddings, oldModel, newModel, reembed, texts);
    expect(result.migrated).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.new_model.model_id).toBe('new-v2');
  });

  it('rejects same model migration', async () => {
    const migrator = new EmbeddingMigrator();
    const model: RagEmbeddingModel = { model_id: 'same', version: '1.0', dimensions: 3 };
    await expect(migrator.migrate([], model, model, async () => [], new Map())).rejects.toThrow();
  });

  it('tracks migration history for rollback', async () => {
    const migrator = new EmbeddingMigrator();
    const m1: RagEmbeddingModel = { model_id: 'v1', version: '1', dimensions: 2 };
    const m2: RagEmbeddingModel = { model_id: 'v2', version: '2', dimensions: 2 };
    const embeddings: RagEmbedding[] = [{ chunk_id: 'c1', model: m1, vector: [1, 0] }];
    const texts = new Map([['c1', 'text']]);
    await migrator.migrate(embeddings, m1, m2, async () => [0, 1], texts);
    const history = migrator.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.from.model_id).toBe('v1');
    expect(history[0]!.to.model_id).toBe('v2');
  });

  it('handles failed re-embedding', async () => {
    const migrator = new EmbeddingMigrator();
    const oldModel: RagEmbeddingModel = { model_id: 'old', version: '1', dimensions: 2 };
    const newModel: RagEmbeddingModel = { model_id: 'new', version: '2', dimensions: 2 };
    const embeddings: RagEmbedding[] = [{ chunk_id: 'c1', model: oldModel, vector: [1, 0] }];
    const texts = new Map([['c1', 'text']]);
    const reembed = async () => { throw new Error('API error'); };
    const result = await migrator.migrate(embeddings, oldModel, newModel, reembed, texts);
    expect(result.failed).toBe(1);
    expect(result.migrated).toBe(0);
  });
});
