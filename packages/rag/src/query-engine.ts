import { createHash } from 'node:crypto';
import type { RagChunk, RagQuery, RagRetrievalResult, RagAclEntry } from './types.js';
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

function generatePseudoEmbedding(text: string, dimensions = 64): number[] {
  // Simple hash-based pseudo-embedding: maps text to a fixed-size vector
  // using character frequency analysis. Not semantically meaningful but
  // provides consistent vector representations for testing.
  const vector = new Array(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/[\s\p{P}]+/u).filter(t => t.length > 0);
  for (const token of tokens) {
    const hash = createHash('sha256').update(token).digest();
    for (let i = 0; i < dimensions; i++) {
      vector[i]! += hash[i % hash.length]! / 255;
    }
  }
  // Normalize
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vector.map(v => v / norm) : vector;
}

export function addChunkToStore(store: RagIndexStore, chunk: RagChunk, acl: RagAclEntry): void {
  store.chunks.set(chunk.chunk_id, chunk);
  store.acl.set(chunk.chunk_id, acl);
  store.fts.addChunk(chunk);
  store.metadata.addChunk(chunk);
  store.graph.addChunk(chunk, [...store.chunks.values()]);
  // Generate a simple hash-based pseudo-embedding so vector search works
  // without an external embedding provider. This is a placeholder; real
  // embeddings should be added via store.vector.addEmbedding().
  const pseudoVector = generatePseudoEmbedding(chunk.text);
  const model = { model_id: 'pseudo-hash-v1', version: '1.0', dimensions: pseudoVector.length };
  store.vector.setModel(model);
  store.vector.addEmbedding({ chunk_id: chunk.chunk_id, model, vector: pseudoVector });
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
  } else {
    // Use pseudo-embedding for vector search when no external query vector
    const pseudoQueryVector = generatePseudoEmbedding(query.text);
    const vecResults = store.vector.search(pseudoQueryVector, topK * 2);
    for (const { chunk_id, score } of vecResults) {
      if (!aclFiltered.has(chunk_id)) continue;
      const chunk = store.chunks.get(chunk_id);
      if (!chunk) continue;
      results.push({
        chunk: safeChunkForRetrieval(chunk),
        score: score * 0.7, // lower weight for pseudo-embedding
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
        score: 0.3, // lower weight than FTS/vector
        source: 'metadata',
        citation: generateCitation(chunk),
      });
    }
  }

  // Graph expansion: boost chunks that are neighbors of top results
  if (results.length > 0 && store.graph.getNodeCount() > 0) {
    const boosted = new Set<string>();
    for (const r of results.slice(0, 5)) {
      const neighbors = store.graph.getNeighbors(r.chunk.chunk_id, 1);
      for (const neighborId of neighbors) {
        if (!aclFiltered.has(neighborId) || boosted.has(neighborId)) continue;
        const chunk = store.chunks.get(neighborId);
        if (!chunk) continue;
        boosted.add(neighborId);
        results.push({
          chunk: safeChunkForRetrieval(chunk),
          score: r.score * 0.3, // graph boost weight
          source: 'graph',
          citation: generateCitation(chunk),
        });
      }
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
