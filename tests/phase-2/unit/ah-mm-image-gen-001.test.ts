import { describe, expect, it, afterEach } from 'vitest';
import { generateImage, setImageGenProvider } from '../../../packages/multimodal/src/image-gen.js';
import type { ImageGenProviderPort } from '../../../packages/multimodal/src/image-gen.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockProvider: ImageGenProviderPort = {
  model: 'dall-e-3',
  async generate(prompt: string, options) {
    return {
      image_data: Buffer.from(`img:${prompt}:${options.width ?? 0}x${options.height ?? 0}`),
      mime_type: 'image/png',
    };
  },
};

describe('AH-MM-IMAGE-GEN-001: Image generation adapter with data-egress checks', () => {
  afterEach(() => setImageGenProvider(undefined));

  it('throws typed unavailable when no provider is configured', async () => {
    await expect(generateImage({ prompt: 'a cat' })).rejects.toThrow(MultimodalUnavailableError);
    try {
      await generateImage({ prompt: 'a cat' });
    } catch (e) {
      expect(e).toBeInstanceOf(MultimodalUnavailableError);
      expect((e as MultimodalUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('generates an image with a configured provider and returns artifact', async () => {
    setImageGenProvider(mockProvider);
    const result = await generateImage({ prompt: 'a red square', width: 512, height: 512, style: 'photorealistic' });
    expect(result.image_data).toBeInstanceOf(Buffer);
    expect(result.image_data.length).toBeGreaterThan(0);
    expect(result.artifact.type).toBe('image');
    expect(result.artifact.mime_type).toBe('image/png');
    expect(result.artifact.byte_size).toBe(result.image_data.byteLength);
    expect(result.artifact.content_hash).toHaveLength(64);
    expect(result.artifact.provenance.source).toBe('generated');
    expect(result.artifact.provenance.generator).toBe('dall-e-3');
  });

  it('passes width, height, and style options to the provider', async () => {
    let capturedOpts: { width?: number; height?: number; style?: string } = {};
    setImageGenProvider({
      model: 'test-model',
      async generate(_prompt: string, options) {
        capturedOpts = options;
        return { image_data: Buffer.from('x'), mime_type: 'image/png' };
      },
    });
    await generateImage({ prompt: 'test', width: 256, height: 256, style: 'anime' });
    expect(capturedOpts.width).toBe(256);
    expect(capturedOpts.height).toBe(256);
    expect(capturedOpts.style).toBe('anime');
  });

  it('records prompt and dimensions in provenance parameters', async () => {
    setImageGenProvider(mockProvider);
    const result = await generateImage({ prompt: 'a sunset', width: 1024, height: 768 });
    expect(result.artifact.provenance.parameters).toMatchObject({
      prompt: 'a sunset',
      width: 1024,
      height: 768,
    });
  });

  it('rejects empty prompts via egress policy', async () => {
    setImageGenProvider(mockProvider);
    await expect(generateImage({ prompt: '' })).rejects.toThrow(MultimodalUnavailableError);
    await expect(generateImage({ prompt: '   ' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('rejects excessively long prompts via egress policy', async () => {
    setImageGenProvider(mockProvider);
    await expect(generateImage({ prompt: 'x'.repeat(4001) })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('accepts prompts at the maximum allowed length', async () => {
    setImageGenProvider(mockProvider);
    const result = await generateImage({ prompt: 'x'.repeat(4000) });
    expect(result.artifact).toBeDefined();
  });

  it('does not call provider when egress policy rejects the prompt', async () => {
    let called = false;
    setImageGenProvider({
      model: 'test',
      async generate() { called = true; return { image_data: Buffer.from('x'), mime_type: 'image/png' }; },
    });
    await expect(generateImage({ prompt: '' })).rejects.toThrow();
    expect(called).toBe(false);
  });
  it('propagates provider errors', async () => {
    setImageGenProvider({
      model: 'error',
      async generate() { throw new Error('gen API failed'); },
    });
    await expect(generateImage({ prompt: 'test' })).rejects.toThrow('gen API failed');
  });

});
