import type { RagChunk, RagQuery, RagRetrievalResult, RagAclEntry } from './types.js';
import { RagError } from './types.js';
import { FtsIndex } from './fts-index.js';
import { VectorIndex } from './vector-index.js';
import { MetadataIndex } from './metadata-index.js';
import { GraphIndex } from './graph-index.js';
import { safeChunkForRetrieval } from './injection-guard.js';
import { generateCitation } from './citation.js';
import { rerankResults } from './reranker.js';

export interface RagIndexStore {
  readonly fts: FtsIndex;
  readonly vector: VectorIndex;
  readonly metadata: MetadataIndex;
  readonly graph: GraphIndex;
  readonly chunks: Map<string, RagChunk>;
  readonly acl: Map<string, RagAclEntry>;
}

export function createIndexStore(): RagIndexStore {
  return {
    fts: new FtsIndex(),
    vector: new VectorIndex(),
    metadata: new MetadataIndex(),
    graph: new GraphIndex(),
    chunks: new Map(),
    acl: new Map(),
  };
}

export function addChunkToStore(store: RagIndexStore, chunk: RagChunk, acl: RagAclEntry): void {
  store.chunks.set(chunk.chunk_id, chunk);
  store.acl.set(chunk.chunk_id, acl);
  store.fts.addChunk(chunk);
  store.metadata.addChunk(chunk);
  store.graph.addChunk(chunk, [...store.chunks.values()]);
}

export function removeChunkFromStore(store: RagIndexStore, chunkId: string): boolean {
  const chunk = store.chunks.get(chunkId);
  if (!chunk) return false;
  store.chunks.delete(chunkId);
  store.acl.delete(chunkId);
  store.fts.removeChunk(chunkId);
  store.vector.removeEmbedding(chunkId);
  store.metadata.removeChunk(chunkId);
  store.graph.removeChunk(chunkId);
  return true;
}

export function queryStore(
  store: RagIndexStore,
  query: RagQuery,
  queryVector?: readonly number[],
): RagRetrievalResult[] {
  // ACL check: filter chunks by tenant_id
  const aclFiltered = new Set<string>();
  for (const [chunkId, acl] of store.acl) {
    if (acl.tenant_id === query.tenant_id && acl.principal_ids.includes(query.principal_id)) {
      aclFiltered.add(chunkId);
    }
  }
  if (aclFiltered.size === 0) return [];

  const topK = query.top_k ?? 10;
  const results: RagRetrievalResult[] = [];

  // FTS search
  const ftsResults = store.fts.search(query.text, topK * 2);
  for (const { chunk_id, score } of ftsResults) {
    if (!aclFiltered.has(chunk_id)) continue;
    const chunk = store.chunks.get(chunk_id);
    if (!chunk) continue;
    results.push({
      chunk: safeChunkForRetrieval(chunk),
      score,
      source: 'fts',
      citation: generateCitation(chunk),
    });
  }

  // Vector search (if query vector provided)
  if (queryVector) {
    const vecResults = store.vector.search(queryVector, topK * 2);
    for (const { chunk_id, score } of vecResults) {
      if (!aclFiltered.has(chunk_id)) continue;
      const chunk = store.chunks.get(chunk_id);
      if (!chunk) continue;
      results.push({
        chunk: safeChunkForRetrieval(chunk),
        score,
        source: 'vector',
        citation: generateCitation(chunk),
      });
    }
  }

  // Metadata filtering
  if (query.filters) {
    const metaFiltered = store.metadata.filter(query.filters);
    for (const chunkId of metaFiltered) {
      if (!aclFiltered.has(chunkId)) continue;
      const chunk = store.chunks.get(chunkId);
      if (!chunk) continue;
      results.push({
        chunk: safeChunkForRetrieval(chunk),
        score: 0.5,
        source: 'metadata',
        citation: generateCitation(chunk),
      });
    }
  }

  // Deduplicate by chunk_id, keeping highest score
  const deduped = new Map<string, RagRetrievalResult>();
  for (const r of results) {
    const existing = deduped.get(r.chunk.chunk_id);
    if (!existing || r.score > existing.score) {
      deduped.set(r.chunk.chunk_id, r);
    }
  }

  // Rerank
  return rerankResults([...deduped.values()], { top_k: topK });
}

export function deleteFromStore(store: RagIndexStore, sourceHash: string): number {
  let deleted = 0;
  const chunkIds = [...store.chunks.entries()]
    .filter(([, chunk]) => chunk.source_hash === sourceHash)
    .map(([id]) => id);
  for (const id of chunkIds) {
    if (removeChunkFromStore(store, id)) deleted++;
  }
  return deleted;
}
