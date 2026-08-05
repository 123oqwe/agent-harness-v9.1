/**
 * AH-MM-IMAGE-GEN-001: Image generation adapter with data-egress checks.
 * AH-TOOL-IMAGE-GEN-001: Model-callable image generation tool.
 * Returns typed unavailable when no provider is configured.
 */
import type { MultimodalArtifact } from './types.js';
import { MultimodalUnavailableError } from './types.js';

export interface ImageGenInput {
  prompt: string;
  width?: number;
  height?: number;
  style?: string;
}

export interface ImageGenResult {
  artifact: MultimodalArtifact;
  image_data: Buffer;
}

export async function generateImage(_input: ImageGenInput): Promise<ImageGenResult> {
  throw new MultimodalUnavailableError(
    'no image generation provider configured (set OPENAI_API_KEY or equivalent)',
    'provider_unavailable',
  );
}
