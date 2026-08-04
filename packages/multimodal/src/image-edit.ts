/**
 * AH-MM-IMAGE-EDIT-001: Image editing with identity preservation.
 * Returns typed unavailable when no provider is configured.
 */
import type { MultimodalArtifact } from './types.js';
import { MultimodalUnavailableError } from './types.js';

export interface ImageEditInput {
  image_data: Buffer;
  edit_prompt: string;
  preserve_identity?: boolean;
}

export async function editImage(input: ImageEditInput): Promise<{ artifact: MultimodalArtifact; image_data: Buffer }> {
  throw new MultimodalUnavailableError(
    'no image editing provider configured',
    'provider_unavailable',
  );
}
