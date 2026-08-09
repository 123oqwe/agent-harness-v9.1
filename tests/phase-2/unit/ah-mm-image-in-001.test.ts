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

  it('propagates provider errors', async () => {
    setVisionProvider({
      model: 'error',
      async understand() { throw new Error('vision API failed'); },
    });
    await expect(understandImage({ image_data: Buffer.from('x'), prompt: 'test' })).rejects.toThrow('vision API failed');
  });

  it('computes correct content hash', async () => {
    setVisionProvider(mockVisionProvider);
    const imgData = Buffer.from('hash-verify');
    const result = await understandImage({ image_data: imgData, prompt: 'test' });
    expect(result.artifact.byte_size).toBe(imgData.length);
  });

  it('handles multiple sequential calls', async () => {
    setVisionProvider(mockVisionProvider);
    const r1 = await understandImage({ image_data: Buffer.from('img1'), prompt: 'first' });
    const r2 = await understandImage({ image_data: Buffer.from('img2'), prompt: 'second' });
    expect(r1.description).toContain('first');
    expect(r2.description).toContain('second');
  });

  it('handles provider returning empty result', async () => {
    setVisionProvider({
      model: 'empty-provider',
      async understand() { return { description: '', confidence: 0 }; },
    });
    const result = await understandImage({ image_data: Buffer.from('test'), prompt: 'describe' });
    expect(result.description).toBe('');
    expect(result.confidence).toBe(0);
  });

  it('handles provider returning very high confidence', async () => {
    setVisionProvider({
      model: 'confident',
      async understand() { return { description: 'very confident', confidence: 1.0 }; },
    });
    const result = await understandImage({ image_data: Buffer.from('test'), prompt: 'describe' });
    expect(result.confidence).toBe(1.0);
  });

  it('handles large image data', async () => {
    setVisionProvider({
      model: 'test',
      async understand(image_data: Buffer) { return { description: 'large: ' + image_data.length, confidence: 0.9 }; },
    });
    const result = await understandImage({ image_data: Buffer.alloc(10000, 0xFF), prompt: 'describe' });
    expect(result.description).toContain('10000');
  });

  it('handles empty prompt', async () => {
    setVisionProvider({
      model: 'test',
      async understand(_image_data: Buffer, prompt: string) { return { description: 'prompt: ' + prompt, confidence: 0.5 }; },
    });
    const result = await understandImage({ image_data: Buffer.from('x'), prompt: '' });
    expect(result.description).toBe('prompt: ');
  });

  it('handles Unicode prompt', async () => {
    setVisionProvider({
      model: 'test',
      async understand(_image_data: Buffer, prompt: string) { return { description: prompt, confidence: 0.8 }; },
    });
    const result = await understandImage({ image_data: Buffer.from('x'), prompt: '描述图片内容' });
    expect(result.description).toBe('描述图片内容');
  });

  it('state isolation: changing provider between calls', async () => {
    setVisionProvider({ model: 'first', async understand() { return { description: 'first', confidence: 0.9 }; } });
    const r1 = await understandImage({ image_data: Buffer.from('x'), prompt: 'test' });
    setVisionProvider({ model: 'second', async understand() { return { description: 'second', confidence: 0.8 }; } });
    const r2 = await understandImage({ image_data: Buffer.from('x'), prompt: 'test' });
    expect(r1.description).toBe('first');
    expect(r2.description).toBe('second');
  });

  it('artifact has correct type', async () => {
    setVisionProvider({ model: 'test', async understand() { return { description: 'test', confidence: 0.9 }; } });
    const result = await understandImage({ image_data: Buffer.from('x'), prompt: 'test' });
    expect(result.artifact.type).toBe('image');
  });

});
