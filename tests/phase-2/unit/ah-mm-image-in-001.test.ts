import { describe, it, expect } from 'vitest';
import * as mod from '../../../packages/multimodal/src/vision.js';
import { understandImage, setVisionProvider, type VisionProviderPort } from '../../../packages/multimodal/src/vision.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockVisionProvider: VisionProviderPort = {
  model: 'gpt-4o',
  async understand(image_data: Buffer, prompt: string) {
    return {
      description: `Image shows: ${prompt} (${image_data.length} bytes)`,
      confidence: 0.88,
    };
  },
};

describe('AH-MM-IMAGE-IN-001: Accept image input for vision understanding', () => {
  afterEach(() => setVisionProvider(undefined));

  it('module is importable', () => {
    expect(mod).toBeDefined();
  });

  it('exports at least one symbol', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it('throws unavailable when no provider is configured', async () => {
    await expect(understandImage({ image_data: Buffer.from('img'), prompt: 'what is this?' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('accepts image input with a configured provider', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('png-bytes'), prompt: 'describe this image', mime_type: 'image/png' });
    expect(result.description).toContain('Image shows');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.artifact.mime_type).toBe('image/png');
  });
});
