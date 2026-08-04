import type { RagChunk } from './types.js';

interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly weight: number;
}

export class GraphIndex {
  private readonly edges: GraphEdge[] = [];
  private readonly chunkNodes = new Set<string>();

  addChunk(chunk: RagChunk, allChunks: readonly RagChunk[]): void {
    this.chunkNodes.add(chunk.chunk_id);
    // Link sequential chunks from the same source
    if (chunk.chunk_index > 0) {
      const prevId = `${chunk.source_hash}-${chunk.chunk_index - 1}`;
      if (this.chunkNodes.has(prevId) || allChunks.some(c => c.chunk_id === prevId)) {
        this.edges.push({
          from: prevId,
          to: chunk.chunk_id,
          relation: 'sequential',
          weight: 1.0,
        });
      }
    }
    // Link chunks on the same page
    if (chunk.page !== undefined) {
      for (const other of allChunks) {
        if (other.chunk_id !== chunk.chunk_id && other.page === chunk.page) {
          this.edges.push({
            from: chunk.chunk_id,
            to: other.chunk_id,
            relation: 'same_page',
            weight: 0.5,
          });
        }
      }
    }
  }

  removeChunk(chunkId: string): void {
    this.chunkNodes.delete(chunkId);
    const filtered = this.edges.filter(e => e.from !== chunkId && e.to !== chunkId);
    this.edges.length = 0;
    this.edges.push(...filtered);
  }

  getNeighbors(chunkId: string, maxDepth = 1): Set<string> {
    const result = new Set<string>();
    let frontier = new Set([chunkId]);
    for (let d = 0; d < maxDepth; d++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const edge of this.edges) {
          if (edge.from === id && !result.has(edge.to)) {
            next.add(edge.to);
          }
          if (edge.to === id && !result.has(edge.from)) {
            next.add(edge.from);
          }
        }
      }
      for (const id of next) result.add(id);
      frontier = next;
    }
    result.delete(chunkId);
    return result;
  }

  getEdgeCount(): number {
    return this.edges.length;
  }

  getNodeCount(): number {
    return this.chunkNodes.size;
  }
}
