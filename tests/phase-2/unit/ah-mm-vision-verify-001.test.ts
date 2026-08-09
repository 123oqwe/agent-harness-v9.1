import { describe, it, expect, afterEach } from 'vitest';
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

const highConfidenceProvider: VisionProviderPort = {
  model: 'verify-hc',
  async understand(_img: Buffer, _prompt: string) {
    return { description: 'matches expected content exactly', confidence: 0.95 };
  },
};

const deterministicProvider: VisionProviderPort = {
  model: 'verify-det',
  async understand(_img: Buffer, prompt: string) {
    const desc = prompt.match(/"([^"]+)"/)?.[1] ?? 'unknown';
    return { description: `verified: ${desc}`, confidence: 0.85 };
  },
};

describe('AH-MM-VISION-VERIFY-001: Vision verification of generated content', () => {
  afterEach(() => setVisionProvider(undefined));

  it('throws unavailable when no provider is configured', async () => {
    await expect(verifyGeneratedContent(Buffer.from('img'), 'red square')).rejects.toThrow(MultimodalUnavailableError);
  });

  it('throws with provider_unavailable reason when no provider', async () => {
    try {
      await verifyGeneratedContent(Buffer.from('x'), 'test');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MultimodalUnavailableError);
      expect((e as MultimodalUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('verifies matching content with high confidence', async () => {
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

  it('returns verified=true when confidence >= 0.7 and description matches', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await verifyGeneratedContent(Buffer.from('img'), 'red square');
    expect(result.verified).toBe(true);
  });

  it('returns verified=false when confidence < 0.7', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await verifyGeneratedContent(Buffer.from('img'), 'blue circle that does not match red');
    expect(result.verified).toBe(false);
  });

  it('produces deterministic results for same input', async () => {
    setVisionProvider(deterministicProvider);
    const r1 = await verifyGeneratedContent(Buffer.from('same-img'), 'test description');
    const r2 = await verifyGeneratedContent(Buffer.from('same-img'), 'test description');
    expect(r1.verified).toBe(r2.verified);
    expect(r1.confidence).toBe(r2.confidence);
    expect(r1.actual_description).toBe(r2.actual_description);
  });

  it('includes actual_description in verification result', async () => {
    setVisionProvider(highConfidenceProvider);
    const result = await verifyGeneratedContent(Buffer.from('img'), 'expected content');
    expect(result.actual_description).toBeDefined();
    expect(typeof result.actual_description).toBe('string');
  });

  it('constructs verification prompt with expected description', async () => {
    let capturedPrompt = '';
    const captureProvider: VisionProviderPort = {
      model: 'capture',
      async understand(_img: Buffer, prompt: string) {
        capturedPrompt = prompt;
        return { description: 'ok', confidence: 0.8 };
      },
    };
    setVisionProvider(captureProvider);
    await verifyGeneratedContent(Buffer.from('img'), 'my expected description');
    expect(capturedPrompt).toContain('my expected description');
    expect(capturedPrompt).toContain('Verify');
  });

  it('handles empty expected description gracefully', async () => {
    setVisionProvider(highConfidenceProvider);
    const result = await verifyGeneratedContent(Buffer.from('img'), '');
    expect(result).toBeDefined();
    expect(typeof result.verified).toBe('boolean');
  });

  it('returns false when confidence is below threshold', async () => {
    setVisionProvider({
      model: 'low-conf',
      async understand() { return { description: 'matches', confidence: 0.5 }; },
    });
    const result = await verifyGeneratedContent(Buffer.from('x'), 'matches');
    expect(result.verified).toBe(false);
  });

  it('returns true when confidence is high and description matches', async () => {
    setVisionProvider({
      model: 'high-conf',
      async understand() { return { description: 'matches expected', confidence: 0.9 }; },
    });
    const result = await verifyGeneratedContent(Buffer.from('x'), 'matches');
    expect(result.verified).toBe(true);
  });

  it('returns actual description from provider', async () => {
    setVisionProvider({
      model: 'test',
      async understand() { return { description: 'actual description here', confidence: 0.95 }; },
    });
    const result = await verifyGeneratedContent(Buffer.from('x'), 'test');
    expect(result.actual_description).toBe('actual description here');
  });

  it('handles empty expected description', async () => {
    setVisionProvider({
      model: 'test',
      async understand() { return { description: 'anything', confidence: 0.9 }; },
    });
    const result = await verifyGeneratedContent(Buffer.from('x'), '');
    expect(result).toBeDefined();
  });


  it('returns confidence from provider', async () => {
    setVisionProvider({ model: 'test', async understand() { return { description: 'test', confidence: 0.85 }; } });
    const result = await verifyGeneratedContent(Buffer.from('x'), 'test');
    expect(result.confidence).toBe(0.85);
  });

  it('handles special characters in expected description', async () => {
    setVisionProvider({ model: 'test', async understand() { return { description: 'test @special', confidence: 0.9 }; } });
    const result = await verifyGeneratedContent(Buffer.from('x'), 'test @special');
    expect(result).toBeDefined();
  });

});
