import { describe, it, expect } from 'vitest';
import { understandImage, setVisionProvider, type VisionProviderPort } from '../../../packages/multimodal/src/vision.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockVisionProvider: VisionProviderPort = {
  model: 'gpt-4o',
  async understand(image_data: Buffer, prompt: string) {
    return {
      description: `Document contains: ${prompt} (size: ${image_data.length} bytes)`,
      confidence: 0.92,
    };
  },
};

describe('AH-MM-DOC-VISION-001: Document vision understanding for PDF/pages', () => {
  afterEach(() => setVisionProvider(undefined));



  it('throws unavailable when no provider is configured', async () => {
    await expect(understandImage({ image_data: Buffer.from('pdf-page'), prompt: 'describe' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('understands a document page image with a configured provider', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('page-render'), prompt: 'extract text from this page' });
    expect(result.description).toContain('Document contains');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.artifact.type).toBe('image');
    expect(result.artifact.provenance.source).toBe('input');
  });
});
