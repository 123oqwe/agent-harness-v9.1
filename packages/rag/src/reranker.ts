import type { RagRetrievalResult } from './types.js';

export interface RerankOptions {
  readonly diversity_lambda?: number;
  readonly top_k?: number;
}

export function rerankResults(
  results: readonly RagRetrievalResult[],
  options: RerankOptions = {},
): RagRetrievalResult[] {
  const topK = options.top_k ?? 10;
  const lambda = options.diversity_lambda ?? 0.3;
  // Simple MMR-like reranking: balance relevance and diversity
  const selected: RagRetrievalResult[] = [];
  const remaining = [...results];
  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const relevance = candidate.score;
      let maxSim = 0;
      for (const sel of selected) {
        const sim = textSimilarity(candidate.chunk.text, sel.chunk.text);
        if (sim > maxSim) maxSim = sim;
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    selected.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}

function textSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
