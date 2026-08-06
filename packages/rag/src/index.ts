export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/rag",
  path: "packages/rag",
} as const);

export interface RagPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}

export type {
  RagChunk,
  RagAclEntry,
  RagRetrievalResult,
  RagCitation,
  RagEmbeddingModel,
  RagEmbedding,
  RagQuery,
  DocumentIngestResult,
  SourceProvenance,
  RagError as RagErrorType,
} from './types.js';
export { RagError } from './types.js';

export {
  chunkDocument,
  type ChunkOptions,
  DEFAULT_CHUNK_OPTIONS,
} from './chunker.js';

export { FtsIndex } from './fts-index.js';
export { VectorIndex } from './vector-index.js';
export { MetadataIndex } from './metadata-index.js';
export { GraphIndex } from './graph-index.js';

export {
  detectInjection,
  sanitizeChunkText,
  safeChunkForRetrieval,
} from './injection-guard.js';

export { rerankResults, type RerankOptions } from './reranker.js';
export { generateCitation, formatCitation } from './citation.js';

export {
  EmbeddingMigrator,
  type MigrationResult,
} from './embedding-migrator.js';

export {
  type EmbeddingProviderPort,
  MockEmbeddingProvider,
} from './embedding-provider.js';

export {
  createIndexStore,
  addChunkToStore,
  removeChunkFromStore,
  queryStore,
  deleteFromStore,
  type RagIndexStore,
} from './query-engine.js';

export {
  setStoreEmbeddingProvider,
} from './query-engine.js';
