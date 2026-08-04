/**
 * RAG types — self-contained, no cross-package runtime imports.
 * SourceProvenance and DocumentIngestResult are structurally compatible
 * with @agent-harness/documents but duplicated here to avoid module
 * resolution issues during vitest transform.
 */

export interface SourceProvenance {
  readonly source_path: string;
  readonly format: string;
  readonly parser_version: string;
  readonly parser_name: string;
  readonly ingested_at: string;
  readonly content_hash: string;
  readonly byte_size: number;
}

export interface DocumentIngestResult {
  readonly provenance: SourceProvenance;
  readonly text: string;
  readonly headings: readonly { level: number; text: string; position?: number }[];
  readonly tables: readonly { rows: readonly (readonly string[])[]; caption?: string }[];
  readonly images: readonly { ref: string; alt: string; source_path: string | undefined }[];
  readonly pages: readonly { page: number; start_offset: number; end_offset: number }[] | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RagChunk {
  readonly chunk_id: string;
  readonly source_hash: string;
  readonly provenance: SourceProvenance;
  readonly text: string;
  readonly chunk_index: number;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly content_hash: string;
  readonly page: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RagAclEntry {
  readonly tenant_id: string;
  readonly principal_ids: readonly string[];
}

export interface RagRetrievalResult {
  readonly chunk: RagChunk;
  readonly score: number;
  readonly source: 'fts' | 'vector' | 'metadata' | 'graph';
  readonly citation: RagCitation;
}

export interface RagCitation {
  readonly source_path: string;
  readonly source_hash: string;
  readonly page: number | undefined;
  readonly chunk_index: number;
  readonly content_hash: string;
  readonly excerpt: string;
}

export interface RagEmbeddingModel {
  readonly model_id: string;
  readonly version: string;
  readonly dimensions: number;
}

export interface RagEmbedding {
  readonly chunk_id: string;
  readonly model: RagEmbeddingModel;
  readonly vector: readonly number[];
}

export interface RagQuery {
  readonly text: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly top_k?: number;
  readonly filters?: Readonly<Record<string, unknown>>;
}

export class RagError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'injection_detected' | 'model_mismatch' | 'acl_denied' | 'corrupted') {
    super(message);
    this.name = 'RagError';
    Object.setPrototypeOf(this, RagError.prototype);
  }
}
