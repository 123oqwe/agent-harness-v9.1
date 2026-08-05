/**
 * AH-MM-IMAGE-IN-001: Accept image input for vision understanding.
 * AH-MM-DOC-VISION-001: Document vision understanding for PDF/pages.
 * AH-MM-VISION-VERIFY-001: Vision verification of generated content.
 * Returns typed unavailable when no vision provider is configured.
 */
import type { MultimodalArtifact } from './types.js';
import { MultimodalUnavailableError } from './types.js';

export interface VisionInput {
  image_data: Buffer;
  prompt: string;
  mime_type?: string;
}

export interface VisionResult {
  description: string;
  confidence: number;
  artifact: MultimodalArtifact;
}

export async function understandImage(_input: VisionInput): Promise<VisionResult> {
  throw new MultimodalUnavailableError(
    'no vision provider configured',
    'provider_unavailable',
  );
}

export async function verifyGeneratedContent(_imageData: Buffer, _expectedDescription: string): Promise<{
  verified: boolean;
  confidence: number;
  actual_description: string;
}> {
  throw new MultimodalUnavailableError(
    'no vision provider configured for verification',
    'provider_unavailable',
  );
}
