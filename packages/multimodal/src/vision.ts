/**
 * AH-MM-IMAGE-IN-001: Accept image input for vision understanding.
 * AH-MM-DOC-VISION-001: Document vision understanding for PDF/pages.
 * AH-MM-VISION-VERIFY-001: Vision verification of generated content.
 * Supports provider injection; falls back to typed unavailable when no provider configured.
 */
import type { MultimodalArtifact } from './types.js';
import { MultimodalUnavailableError, createArtifact } from './types.js';

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

/** Provider port for vision understanding. Implementations call external APIs. */
export interface VisionProviderPort {
  readonly model: string;
  understand(image_data: Buffer, prompt: string, mime_type?: string): Promise<{ description: string; confidence: number }>;
}

let visionProvider: VisionProviderPort | undefined;

/** Configure the vision provider. */
export function setVisionProvider(provider: VisionProviderPort | undefined): void {
  visionProvider = provider;
}

export async function understandImage(input: VisionInput): Promise<VisionResult> {
  if (!visionProvider) {
    throw new MultimodalUnavailableError(
      'no vision provider configured',
      'provider_unavailable',
    );
  }
  const result = await visionProvider.understand(input.image_data, input.prompt, input.mime_type);
  const artifact = createArtifact('image', input.mime_type ?? 'image/png', input.image_data, {
    source: 'input',
    generator: visionProvider.model,
    input_artifacts: [],
    parameters: { prompt: input.prompt },
  });
  return {
    description: result.description,
    confidence: result.confidence,
    artifact,
  };
}

export async function verifyGeneratedContent(imageData: Buffer, expectedDescription: string): Promise<{
  verified: boolean;
  confidence: number;
  actual_description: string;
}> {
  if (!visionProvider) {
    throw new MultimodalUnavailableError(
      'no vision provider configured for verification',
      'provider_unavailable',
    );
  }
  const prompt = `Verify whether this image matches the following description: "${expectedDescription}". Describe what you actually see and rate your confidence.`;
  const result = await visionProvider.understand(imageData, prompt);
  const verified = result.confidence >= 0.7 && result.description.toLowerCase().includes(expectedDescription.toLowerCase().split(' ')[0]!);
  return {
    verified,
    confidence: result.confidence,
    actual_description: result.description,
  };
}
