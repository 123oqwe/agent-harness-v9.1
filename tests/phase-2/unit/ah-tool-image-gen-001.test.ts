import { describe, it, expect, afterEach } from 'vitest';
import { generateImage, setImageGenProvider, type ImageGenProviderPort } from '../../../packages/multimodal/src/image-gen.js';
import { MultimodalUnavailableError, computeContentHash } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockImageGenProvider: ImageGenProviderPort = {
  model: 'dall-e-3',
  async generate(prompt: string, opts: { width?: number; height?: number; style?: string }) {
    return {
      image_data: Buffer.from(`generated:${prompt.slice(0, 20)}:${opts.width ?? 0}x${opts.height ?? 0}:${opts.style ?? 'none'}`),
      mime_type: 'image/png',
    };
  },
};

const errorProvider: ImageGenProviderPort = {
  model: 'error-gen',
  async generate() { throw new Error('generation API timeout'); },
};

describe('AH-TOOL-IMAGE-GEN-001: Model-callable image generation tool', () => {
  afterEach(() => setImageGenProvider(undefined));

  it('throws unavailable when no provider is configured', async () => {
    await expect(generateImage({ prompt: 'a cat' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('generates an image with a configured provider', async () => {
    setImageGenProvider(mockImageGenProvider);
    const result = await generateImage({ prompt: 'a red square on white background' });
    expect(result.image_data).toBeInstanceOf(Buffer);
    expect(result.artifact.type).toBe('image');
    expect(result.artifact.provenance.source).toBe('generated');
    expect(result.artifact.provenance.generator).toBe('dall-e-3');
  });

  it('rejects empty prompts via egress policy', async () => {
    setImageGenProvider(mockImageGenProvider);
    await expect(generateImage({ prompt: '' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('rejects whitespace-only prompts via egress policy', async () => {
    setImageGenProvider(mockImageGenProvider);
    await expect(generateImage({ prompt: '   ' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('rejects excessively long prompts via egress policy', async () => {
    setImageGenProvider(mockImageGenProvider);
    await expect(generateImage({ prompt: 'x'.repeat(5000) })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('accepts prompts at maximum allowed length', async () => {
    setImageGenProvider(mockImageGenProvider);
    const result = await generateImage({ prompt: 'x'.repeat(4000) });
    expect(result.image_data).toBeInstanceOf(Buffer);
  });

  it('passes width, height, and style options to provider', async () => {
    setImageGenProvider(mockImageGenProvider);
    const result = await generateImage({ prompt: 'test', width: 512, height: 512, style: 'photorealistic' });
    expect(result.image_data.toString()).toContain('512x512');
    expect(result.image_data.toString()).toContain('photorealistic');
  });

  it('records prompt and dimensions in artifact parameters', async () => {
    setImageGenProvider(mockImageGenProvider);
    const result = await generateImage({ prompt: 'landscape', width: 1024, height: 768, style: 'natural' });
    expect(result.artifact.provenance.parameters).toMatchObject({
      prompt: 'landscape',
      width: 1024,
      height: 768,
      style: 'natural',
    });
  });

  it('computes correct content hash for generated image', async () => {
    setImageGenProvider(mockImageGenProvider);
    const result = await generateImage({ prompt: 'hash test' });
    expect(result.artifact.content_hash).toBe(computeContentHash(result.image_data));
  });

  it('propagates provider errors without swallowing', async () => {
    setImageGenProvider(errorProvider);
    await expect(generateImage({ prompt: 'trigger error' })).rejects.toThrow('generation API timeout');
  });

  it('sets artifact mime_type from provider result', async () => {
    setImageGenProvider(mockImageGenProvider);
    const result = await generateImage({ prompt: 'test' });
    expect(result.artifact.mime_type).toBe('image/png');
  });

  it('handles multiple sequential generations with different prompts', async () => {
    setImageGenProvider(mockImageGenProvider);
    const r1 = await generateImage({ prompt: 'first image' });
    const r2 = await generateImage({ prompt: 'second image' });
    expect(r1.artifact.artifact_id).not.toBe(r2.artifact.artifact_id);
    expect(r1.image_data.toString()).toContain('first image');
    expect(r2.image_data.toString()).toContain('second image');
  });

  it('handles provider returning empty image', async () => {
    setImageGenProvider({
      model: 'empty',
      async generate() { return { image_data: Buffer.alloc(0), mime_type: 'image/png' }; },
    });
    const result = await generateImage({ prompt: 'test' });
    expect(result.artifact.byte_size).toBe(0);
  });

  it('handles large image data', async () => {
    setImageGenProvider({
      model: 'large',
      async generate() { return { image_data: Buffer.alloc(10000, 0xFF), mime_type: 'image/png' }; },
    });
    const result = await generateImage({ prompt: 'test' });
    expect(result.artifact.byte_size).toBe(10000);
  });

  it('handles Unicode prompt', async () => {
    setImageGenProvider({
      model: 'test',
      async generate(prompt: string) { return { image_data: Buffer.from(prompt), mime_type: 'image/png' }; },
    });
    const result = await generateImage({ prompt: '生成图片' });
    expect(result.artifact.provenance.parameters).toMatchObject({ prompt: '生成图片' });
  });

  it('records correct artifact provenance', async () => {
    setImageGenProvider({
      model: 'test-model',
      async generate() { return { image_data: Buffer.from('img'), mime_type: 'image/jpeg' }; },
    });
    const result = await generateImage({ prompt: 'test', width: 512, height: 512, style: 'realistic' });
    expect(result.artifact.provenance.source).toBe('generated');
    expect(result.artifact.provenance.generator).toBe('test-model');
    expect(result.artifact.mime_type).toBe('image/jpeg');
  });

  it('passes options to provider', async () => {
    let capturedOpts: { width?: number; height?: number; style?: string } = {};
    setImageGenProvider({
      model: 'test',
      async generate(_prompt: string, opts: { width?: number; height?: number; style?: string }) {
        capturedOpts = opts;
        return { image_data: Buffer.from('x'), mime_type: 'image/png' };
      },
    });
    await generateImage({ prompt: 'test', width: 1024, height: 768, style: 'abstract' });
    expect(capturedOpts.width).toBe(1024);
    expect(capturedOpts.height).toBe(768);
    expect(capturedOpts.style).toBe('abstract');
  });

  it('artifact has correct content hash', async () => {
    const imgData = Buffer.from('test-image-data');
    setImageGenProvider({
      model: 'test',
      async generate() { return { image_data: imgData, mime_type: 'image/png' }; },
    });
    const result = await generateImage({ prompt: 'test' });
    expect(result.artifact.content_hash).toBe(computeContentHash(imgData));
  });

  it('state isolation between provider changes', async () => {
    setImageGenProvider({ model: 'first', async generate() { return { image_data: Buffer.from('a'), mime_type: 'image/png' }; } });
    const r1 = await generateImage({ prompt: 'test' });
    setImageGenProvider({ model: 'second', async generate() { return { image_data: Buffer.from('b'), mime_type: 'image/png' }; } });
    const r2 = await generateImage({ prompt: 'test' });
    expect(r1.image_data.toString()).toBe('a');
    expect(r2.image_data.toString()).toBe('b');
  });

});
