/**
 * AH-MM-IMAGE-EDIT-001: Image editing with identity preservation.
 * Supports provider injection; falls back to typed unavailable when no provider configured.
 */
import type { MultimodalArtifact } from './types.js';
import { MultimodalUnavailableError, createArtifact } from './types.js';

export interface ImageEditInput {
  image_data: Buffer;
  edit_prompt: string;
  preserve_identity?: boolean;
}

/** Provider port for image editing. Implementations call external APIs. */
export interface ImageEditProviderPort {
  readonly model: string;
  edit(image_data: Buffer, edit_prompt: string, options: { preserve_identity?: boolean }): Promise<{ image_data: Buffer; mime_type: string }>;
}

let imageEditProvider: ImageEditProviderPort | undefined;

/** Configure the image editing provider. */
export function setImageEditProvider(provider: ImageEditProviderPort | undefined): void {
  imageEditProvider = provider;
}

export async function editImage(input: ImageEditInput): Promise<{ artifact: MultimodalArtifact; image_data: Buffer }> {
  if (!imageEditProvider) {
    throw new MultimodalUnavailableError(
      'no image editing provider configured',
      'provider_unavailable',
    );
  }
  const opts: { preserve_identity?: boolean } = {};
  if (input.preserve_identity !== undefined) opts.preserve_identity = input.preserve_identity;
  const result = await imageEditProvider.edit(input.image_data, input.edit_prompt, opts);
  const artifact = createArtifact('image', result.mime_type, result.image_data, {
    source: 'edited',
    generator: imageEditProvider.model,
    input_artifacts: [],
    parameters: { edit_prompt: input.edit_prompt, preserve_identity: input.preserve_identity },
  });
  return { artifact, image_data: result.image_data };
}
