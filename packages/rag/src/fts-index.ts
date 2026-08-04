import type { RagChunk } from './types.js';

interface FtsPosting {
  readonly chunk_id: string;
  readonly frequency: number;
  readonly positions: readonly number[];
}

export class FtsIndex {
  private readonly postings = new Map<string, Map<string, FtsPosting>>();
  private readonly chunkLengths = new Map<string, number>();
  private totalChunks = 0;
  private readonly avgDocLength: number = 0;

  addChunk(chunk: RagChunk): void {
    const tokens = tokenize(chunk.text);
    this.chunkLengths.set(chunk.chunk_id, tokens.length);
    this.totalChunks++;
    const chunkPostings = new Map<string, FtsPosting>();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const existing = chunkPostings.get(token);
      if (existing) {
        chunkPostings.set(token, {
          chunk_id: chunk.chunk_id,
          frequency: existing.frequency + 1,
          positions: [...existing.positions, i],
        });
      } else {
        chunkPostings.set(token, { chunk_id: chunk.chunk_id, frequency: 1, positions: [i] });
      }
    }
    for (const [token, posting] of chunkPostings) {
      if (!this.postings.has(token)) this.postings.set(token, new Map());
      this.postings.get(token)!.set(chunk.chunk_id, posting);
    }
  }

  removeChunk(chunkId: string): void {
    const length = this.chunkLengths.get(chunkId);
    if (length === undefined) return;
    this.chunkLengths.delete(chunkId);
    this.totalChunks--;
    for (const [token, postings] of this.postings) {
      if (postings.delete(chunkId) && postings.size === 0) {
        this.postings.delete(token);
      }
    }
  }

  search(query: string, topK = 10): Array<{ chunk_id: string; score: number }> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const scores = new Map<string, number>();
    const avgLen = this.getAvgDocLength();
    const N = this.totalChunks;
    for (const token of queryTokens) {
      const postings = this.postings.get(token);
      if (!postings) continue;
      const df = postings.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [chunkId, posting] of postings) {
        const docLen = this.chunkLengths.get(chunkId) ?? 1;
        const tf = posting.frequency;
        const bm25 = idf * (tf * (1.5 + 1)) / (tf + 1.5 * (1 - 0.75 + 0.75 * (docLen / avgLen)));
        scores.set(chunkId, (scores.get(chunkId) ?? 0) + bm25);
      }
    }
    return [...scores.entries()]
      .map(([chunk_id, score]) => ({ chunk_id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  getChunkIds(): readonly string[] {
    return [...this.chunkLengths.keys()];
  }

  getTermCount(): number {
    return this.postings.size;
  }

  private getAvgDocLength(): number {
    if (this.totalChunks === 0) return 1;
    let total = 0;
    for (const len of this.chunkLengths.values()) total += len;
    return total / this.totalChunks;
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s\p{P}]+/u).filter(t => t.length > 0);
}
