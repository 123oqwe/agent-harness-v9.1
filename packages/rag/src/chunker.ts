import { createHash } from 'node:crypto';

import type { RagChunk, RagAclEntry, DocumentIngestResult } from './types.js';

export interface ChunkOptions {
  readonly max_chunk_size: number;
  readonly overlap: number;
  readonly min_chunk_size: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  max_chunk_size: 512,
  overlap: 64,
  min_chunk_size: 32,
};

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function chunkDocument(
  result: DocumentIngestResult,
  acl: RagAclEntry,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): RagChunk[] {
  const text = result.text;
  if (text.length === 0) return [];
  const chunks: RagChunk[] = [];
  const sourceHash = result.provenance.content_hash;
  let offset = 0;
  let chunkIndex = 0;

  while (offset < text.length) {
    let end = Math.min(offset + options.max_chunk_size, text.length);
    // Try to break at sentence/paragraph boundary
    if (end < text.length) {
      const lastSentence = Math.max(
        text.lastIndexOf('.', end),
        text.lastIndexOf('\n', end),
        text.lastIndexOf(' ', end),
      );
      if (lastSentence > offset + options.min_chunk_size) {
        end = lastSentence + 1;
      }
    }
    const chunkText = text.slice(offset, end);
    if (chunkText.length >= options.min_chunk_size || chunks.length === 0) {
      const page = result.pages?.find(p => p.start_offset <= offset && offset < p.end_offset)?.page;
      chunks.push({
        chunk_id: `${sourceHash}-${chunkIndex}`,
        source_hash: sourceHash,
        provenance: result.provenance,
        text: chunkText,
        chunk_index: chunkIndex,
        start_offset: offset,
        end_offset: end,
        content_hash: sha256Hex(chunkText),
        page,
      // Ensure tenant_id from acl is not overwritten by result.metadata
      // This prevents cross-tenant data leakage via malicious metadata
      metadata: { ...result.metadata, tenant_id: acl.tenant_id },
      });
      chunkIndex++;
    }
    offset = end - options.overlap;
    if (offset >= end || offset < 0 || end >= text.length) break; // prevent infinite loop
  }
  return chunks;
}
