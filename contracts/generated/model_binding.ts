/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/model-binding.schema.json. Do not modify by hand. */

export interface ModelBinding {
  provider: string;
  model_id: string;
  modality_role: "reasoning" | "vision" | "image_gen" | "code" | "speech" | "embedding" | "reranking";
  capability_match_score: number;
  cost_estimate?: {
    [k: string]: unknown;
  };
  latency_estimate_ms?: number;
}
