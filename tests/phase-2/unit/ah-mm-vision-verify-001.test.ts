import { describe, it, expect } from 'vitest';
import * as mod from '../../../packages/multimodal/src/vision.js';
import { verifyGeneratedContent, setVisionProvider, type VisionProviderPort } from '../../../packages/multimodal/src/vision.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockVisionProvider: VisionProviderPort = {
  model: 'gpt-4o',
  async understand(_image_data: Buffer, prompt: string) {
    if (prompt.includes('"red square"')) {
      return { description: 'I see a red square with text', confidence: 0.9 };
    }
    return { description: 'I see a blue circle', confidence: 0.3 };
  },
};

describe('AH-MM-VISION-VERIFY-001: Vision verification of generated content', () => {
  afterEach(() => setVisionProvider(undefined));

  it('module is importable', () => {
    expect(mod).toBeDefined();
  });

  it('exports at least one symbol', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it('throws unavailable when no provider is configured', async () => {
    await expect(verifyGeneratedContent(Buffer.from('img'), 'red square')).rejects.toThrow(MultimodalUnavailableError);
  });

  it('verifies matching content', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await verifyGeneratedContent(Buffer.from('generated-img'), 'red square');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.actual_description).toContain('red square');
  });

  it('returns low confidence for non-matching content', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await verifyGeneratedContent(Buffer.from('img'), 'red square that does not match');
    expect(result.confidence).toBeLessThan(0.5);
  });
});
