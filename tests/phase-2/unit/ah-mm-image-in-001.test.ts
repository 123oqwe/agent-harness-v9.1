import { describe, it, expect, afterEach } from 'vitest';
import { understandImage, setVisionProvider } from '../../../packages/multimodal/src/vision.js';
import type { VisionProviderPort } from '../../../packages/multimodal/src/vision.js';
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

  it('throws unavailable when no provider is configured', async () => {
    await expect(understandImage({ image_data: Buffer.from('img'), prompt: 'what is this?' })).rejects.toThrow(MultimodalUnavailableError);
    try {
      await understandImage({ image_data: Buffer.from('img'), prompt: 'what is this?' });
    } catch (e) {
      expect((e as MultimodalUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('accepts image input with a configured provider', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('png-bytes'), prompt: 'describe this image', mime_type: 'image/png' });
    expect(result.description).toContain('Image shows');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.artifact.mime_type).toBe('image/png');
  });

  it('defaults mime_type to image/png when not specified', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('img'), prompt: 'describe' });
    expect(result.artifact.mime_type).toBe('image/png');
  });

  it('accepts JPEG mime_type', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('jpeg-data'), prompt: 'describe', mime_type: 'image/jpeg' });
    expect(result.artifact.mime_type).toBe('image/jpeg');
  });

  it('artifact provenance has input source and generator name', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('test'), prompt: 'identify' });
    expect(result.artifact.provenance.source).toBe('input');
    expect(result.artifact.provenance.generator).toBe('gpt-4o');
  });

  it('passes image_data and prompt to provider', async () => {
    let capturedData: Buffer | undefined;
    let capturedPrompt: string | undefined;
    setVisionProvider({
      model: 'test',
      async understand(data: Buffer, prompt: string) {
        capturedData = data;
        capturedPrompt = prompt;
        return { description: 'test', confidence: 0.5 };
      },
    });
    await understandImage({ image_data: Buffer.from('unique-data'), prompt: 'unique prompt' });
    expect(capturedData?.toString()).toContain('unique-data');
    expect(capturedPrompt).toBe('unique prompt');
  });
});
