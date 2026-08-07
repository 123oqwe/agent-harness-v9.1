import { describe, expect, it, afterEach } from 'vitest';
import { understandImage, verifyGeneratedContent, setVisionProvider } from '../../../packages/multimodal/src/vision.js';
import type { VisionProviderPort } from '../../../packages/multimodal/src/vision.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockProvider: VisionProviderPort = {
  model: 'gpt-4o',
  async understand(image_data: Buffer, prompt: string) {
    if (prompt.includes('verify')) {
      return { description: 'I see a red square', confidence: 0.9 };
    }
    return {
      description: `Image: ${prompt} (${image_data.length}b)`,
      confidence: 0.85,
    };
  },
};

describe('AH-MM-VISION-001: Vision understanding and verification adapter', () => {
  afterEach(() => setVisionProvider(undefined));

  it('understandImage throws typed unavailable when no provider', async () => {
    await expect(understandImage({ image_data: Buffer.from('test'), prompt: 'describe' }))
      .rejects.toThrow(MultimodalUnavailableError);
    try {
      await understandImage({ image_data: Buffer.from('test'), prompt: 'describe' });
    } catch (e) {
      expect((e as MultimodalUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('verifyGeneratedContent throws typed unavailable when no provider', async () => {
    await expect(verifyGeneratedContent(Buffer.from('test'), 'a cat'))
      .rejects.toThrow(MultimodalUnavailableError);
  });

  it('understandImage returns description, confidence, and artifact with provider', async () => {
    setVisionProvider(mockProvider);
    const result = await understandImage({ image_data: Buffer.from('png-bytes'), prompt: 'describe scene', mime_type: 'image/jpeg' });
    expect(result.description).toContain('Image:');
    expect(result.confidence).toBe(0.85);
    expect(result.artifact.type).toBe('image');
    expect(result.artifact.mime_type).toBe('image/jpeg');
    expect(result.artifact.provenance.source).toBe('input');
    expect(result.artifact.provenance.generator).toBe('gpt-4o');
  });

  it('understandImage defaults mime_type to image/png when not specified', async () => {
    setVisionProvider(mockProvider);
    const result = await understandImage({ image_data: Buffer.from('img'), prompt: 'what is this' });
    expect(result.artifact.mime_type).toBe('image/png');
  });

  it('verifyGeneratedContent verifies matching content with high confidence', async () => {
    setVisionProvider({
      model: 'gpt-4o',
      async understand() {
        return { description: 'I see a red square', confidence: 0.95 };
      },
    });
    const result = await verifyGeneratedContent(Buffer.from('generated'), 'red square');
    expect(result.verified).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.actual_description).toContain('red square');
  });

  it('verifyGeneratedContent returns unverified for low-confidence matches', async () => {
    setVisionProvider({
      model: 'gpt-4o',
      async understand() {
        return { description: 'I see something else', confidence: 0.3 };
      },
    });
    const result = await verifyGeneratedContent(Buffer.from('img'), 'red square');
    expect(result.verified).toBe(false);
    expect(result.confidence).toBeLessThan(0.7);
  });

  it('verifyGeneratedContent constructs a verification prompt with expected description', async () => {
    let capturedPrompt = '';
    setVisionProvider({
      model: 'gpt-4o',
      async understand(_data: Buffer, prompt: string) {
        capturedPrompt = prompt;
        return { description: 'match', confidence: 0.9 };
      },
    });
    await verifyGeneratedContent(Buffer.from('img'), 'blue circle');
    expect(capturedPrompt).toContain('blue circle');
    expect(capturedPrompt).toContain('Verify');
  });
  it('propagates provider errors', async () => {
    setVisionProvider({
      model: 'error',
      async understand() { throw new Error('vision API failed'); },
    });
    await expect(understandImage({ image_data: Buffer.from('x'), prompt: 'test' })).rejects.toThrow('vision API failed');
  });

});
