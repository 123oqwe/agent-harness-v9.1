import type { RagChunk, RagCitation } from './types.js';

export function generateCitation(chunk: RagChunk): RagCitation {
  const excerptLength = Math.min(200, chunk.text.length);
  const excerpt = chunk.text.slice(0, excerptLength);
  return {
    source_path: chunk.provenance.source_path,
    source_hash: chunk.source_hash,
    page: chunk.page,
    chunk_index: chunk.chunk_index,
    content_hash: chunk.content_hash,
    excerpt,
  };
}

export function formatCitation(citation: RagCitation): string {
  const pageRef = citation.page !== undefined ? ` (page ${citation.page})` : '';
  return `${citation.source_path}${pageRef} [chunk ${citation.chunk_index}, hash ${citation.content_hash.slice(0, 8)}]`;
}
