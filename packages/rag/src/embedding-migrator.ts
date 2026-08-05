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
  private migrating = false;
  private static readonly BATCH_SIZE = 10;

  migrate(
    embeddings: readonly RagEmbedding[],
    oldModel: RagEmbeddingModel,
    newModel: RagEmbeddingModel,
    reembedFn: (chunkId: string, text: string) => Promise<readonly number[]>,
    chunkTexts: ReadonlyMap<string, string>,
  ): Promise<MigrationResult> {
    if (this.migrating) {
      return Promise.reject(new RagError('migration already in progress', 'corrupted'));
    }
    this.migrating = true;
    if (oldModel.model_id === newModel.model_id) {
      this.migrating = false;
      return Promise.reject(new RagError('old and new model are the same', 'model_mismatch'));
    }
    let migrated = 0;
    let failed = 0;
    const toMigrate = embeddings.filter(e => e.model.model_id === oldModel.model_id);

    const processBatch = async (batch: readonly RagEmbedding[]): Promise<void> => {
      await Promise.all(batch.map(async (emb) => {
        const text = chunkTexts.get(emb.chunk_id);
        if (!text) { failed++; return; }
        try {
          const vector = await reembedFn(emb.chunk_id, text);
          if (!Array.isArray(vector) || vector.length === 0) {
            failed++;
            return;
          }
          // Update in place — caller owns the array and expects mutation
          (emb as { model: RagEmbeddingModel }).model = newModel;
          (emb as { vector: readonly number[] }).vector = vector;
          migrated++;
        } catch {
          failed++;
        }
      }));
    };

    const batches: RagEmbedding[][] = [];
    for (let i = 0; i < toMigrate.length; i += EmbeddingMigrator.BATCH_SIZE) {
      batches.push(toMigrate.slice(i, i + EmbeddingMigrator.BATCH_SIZE));
    }

    return (async () => {
      for (const batch of batches) {
        await processBatch(batch);
      }
      this.history.push({
        timestamp: new Date().toISOString(),
        from: oldModel,
        to: newModel,
        count: migrated,
      });
      this.migrating = false;
      return {
        migrated,
        failed,
        old_model: oldModel,
        new_model: newModel,
        rollback_available: false,
      };
    })();
  }

  getHistory(): readonly { timestamp: string; from: RagEmbeddingModel; to: RagEmbeddingModel; count: number }[] {
    return [...this.history];
  }
}
