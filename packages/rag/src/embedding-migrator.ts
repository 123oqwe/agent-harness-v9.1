import type { RagEmbedding, RagEmbeddingModel } from './types.js';
import { RagError } from './types.js';

export interface MigrationResult {
  readonly migrated: number;
  readonly failed: number;
  readonly old_model: RagEmbeddingModel;
  readonly new_model: RagEmbeddingModel;
  readonly rollback_available: boolean;
}

export class EmbeddingMigrator {
  private readonly history: Array<{
    timestamp: string;
    from: RagEmbeddingModel;
    to: RagEmbeddingModel;
    count: number;
  }> = [];

  migrate(
    embeddings: readonly RagEmbedding[],
    oldModel: RagEmbeddingModel,
    newModel: RagEmbeddingModel,
    reembedFn: (chunkId: string, text: string) => Promise<readonly number[]>,
    chunkTexts: ReadonlyMap<string, string>,
  ): Promise<MigrationResult> {
    if (oldModel.model_id === newModel.model_id) {
      return Promise.reject(new RagError('old and new model are the same', 'model_mismatch'));
    }
    let migrated = 0;
    let failed = 0;
    const promises: Promise<void>[] = [];
    for (const emb of embeddings) {
      if (emb.model.model_id !== oldModel.model_id) continue;
      const text = chunkTexts.get(emb.chunk_id);
      if (!text) {
        failed++;
        continue;
      }
      promises.push(
        reembedFn(emb.chunk_id, text)
          .then(vector => {
            const newEmb: RagEmbedding = {
              chunk_id: emb.chunk_id,
              model: newModel,
              vector,
            };
            Object.assign(emb, newEmb);
            migrated++;
          })
          .catch(() => { failed++; }),
      );
    }
    return Promise.all(promises).then(() => {
      this.history.push({
        timestamp: new Date().toISOString(),
        from: oldModel,
        to: newModel,
        count: migrated,
      });
      return {
        migrated,
        failed,
        old_model: oldModel,
        new_model: newModel,
        rollback_available: this.history.length > 1,
      };
    });
  }

  getHistory(): readonly { timestamp: string; from: RagEmbeddingModel; to: RagEmbeddingModel; count: number }[] {
    return [...this.history];
  }
}
