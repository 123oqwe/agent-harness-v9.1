import { describe, it, expect } from 'vitest';
import * as mod from '../../../packages/multimodal/src/image-gen.js';
import { generateImage, setImageGenProvider, type ImageGenProviderPort } from '../../../packages/multimodal/src/image-gen.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockImageGenProvider: ImageGenProviderPort = {
  model: 'dall-e-3',
  async generate(prompt: string) {
    return {
      image_data: Buffer.from(`generated:${prompt.slice(0, 20)}`),
      mime_type: 'image/png',
    };
  },
};

describe('AH-TOOL-IMAGE-GEN-001: Model-callable image generation tool', () => {
  afterEach(() => setImageGenProvider(undefined));

  it('module is importable', () => {
    expect(mod).toBeDefined();
  });

  it('exports at least one symbol', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it('throws unavailable when no provider is configured', async () => {
    await expect(generateImage({ prompt: 'a cat' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('generates an image with a configured provider', async () => {
    setImageGenProvider(mockImageGenProvider);
    const result = await generateImage({ prompt: 'a red square on white background' });
    expect(result.image_data).toBeInstanceOf(Buffer);
    expect(result.artifact.type).toBe('image');
    expect(result.artifact.provenance.generator).toBe('dall-e-3');
  });

  it('rejects empty prompts via egress policy', async () => {
    setImageGenProvider(mockImageGenProvider);
    await expect(generateImage({ prompt: '' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('rejects excessively long prompts via egress policy', async () => {
    setImageGenProvider(mockImageGenProvider);
    await expect(generateImage({ prompt: 'x'.repeat(5000) })).rejects.toThrow(MultimodalUnavailableError);
  });
});
