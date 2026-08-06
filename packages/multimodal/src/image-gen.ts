/**
 * AH-MM-IMAGE-GEN-001: Image generation adapter with data-egress checks.
 * AH-TOOL-IMAGE-GEN-001: Model-callable image generation tool.
 * Supports provider injection; falls back to typed unavailable when no provider configured.
 */
import type { MultimodalArtifact } from './types.js';
import { MultimodalUnavailableError, createArtifact } from './types.js';

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

/** Provider port for image generation. Implementations call external APIs. */
export interface ImageGenProviderPort {
  readonly model: string;
  generate(prompt: string, options: { width?: number; height?: number; style?: string }): Promise<{ image_data: Buffer; mime_type: string }>;
}

let imageGenProvider: ImageGenProviderPort | undefined;

/** Configure the image generation provider. */
export function setImageGenProvider(provider: ImageGenProviderPort | undefined): void {
  imageGenProvider = provider;
}

/** Egress policy: restricts what data leaves the harness via image generation. */
interface EgressPolicy {
  allowed: boolean;
  reason?: string;
}

function checkEgressPolicy(input: ImageGenInput): EgressPolicy {
  if (!input.prompt || input.prompt.trim().length === 0) {
    return { allowed: false, reason: 'empty prompt' };
  }
  if (input.prompt.length > 4000) {
    return { allowed: false, reason: 'prompt exceeds maximum length' };
  }
  return { allowed: true };
}

export async function generateImage(input: ImageGenInput): Promise<ImageGenResult> {
  if (!imageGenProvider) {
    throw new MultimodalUnavailableError(
      'no image generation provider configured (set OPENAI_API_KEY or equivalent)',
      'provider_unavailable',
    );
  }
  const egress = checkEgressPolicy(input);
  if (!egress.allowed) {
    throw new MultimodalUnavailableError(
      `data-egress policy violation: ${egress.reason}`,
      'provider_unavailable',
    );
  }
  const opts: { width?: number; height?: number; style?: string } = {};
  if (input.width !== undefined) opts.width = input.width;
  if (input.height !== undefined) opts.height = input.height;
  if (input.style !== undefined) opts.style = input.style;
  const result = await imageGenProvider.generate(input.prompt, opts);
  const artifact = createArtifact('image', result.mime_type, result.image_data, {
    source: 'generated',
    generator: imageGenProvider.model,
    input_artifacts: [],
    parameters: { prompt: input.prompt, width: input.width, height: input.height, style: input.style },
  });
  return { artifact, image_data: result.image_data };
}
