import { describe, it, expect, afterEach } from 'vitest';
import { understandImage, setVisionProvider, type VisionProviderPort } from '../../../packages/multimodal/src/vision.js';
import { MultimodalUnavailableError, computeContentHash } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockVisionProvider: VisionProviderPort = {
  model: 'gpt-4o',
  async understand(image_data: Buffer, prompt: string, mime_type?: string) {
    return {
      description: `Document contains: ${prompt} (size: ${image_data.length} bytes, mime: ${mime_type ?? 'image/png'})`,
      confidence: 0.92,
    };
  },
};

const lowConfidenceProvider: VisionProviderPort = {
  model: 'test-low-conf',
  async understand(_image_data: Buffer, prompt: string) {
    return { description: `uncertain: ${prompt}`, confidence: 0.35 };
  },
};

const errorProvider: VisionProviderPort = {
  model: 'error-provider',
  async understand() { throw new Error('provider API failure'); },
};

describe('AH-MM-DOC-VISION-001: Document vision understanding for PDF/pages', () => {
  afterEach(() => setVisionProvider(undefined));

  it('throws unavailable when no provider is configured', async () => {
    await expect(understandImage({ image_data: Buffer.from('pdf-page'), prompt: 'describe' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('throws with provider_unavailable reason when no provider', async () => {
    try {
      await understandImage({ image_data: Buffer.from('x'), prompt: 'test' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MultimodalUnavailableError);
      expect((e as MultimodalUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('understands a document page image with a configured provider', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('page-render'), prompt: 'extract text from this page' });
    expect(result.description).toContain('Document contains');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.artifact.type).toBe('image');
    expect(result.artifact.provenance.source).toBe('input');
  });

  it('passes mime_type to the provider', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({
      image_data: Buffer.from('pdf-page'),
      prompt: 'describe',
      mime_type: 'application/pdf',
    });
    expect(result.description).toContain('application/pdf');
  });

  it('defaults mime_type to image/png when not specified', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({
      image_data: Buffer.from('page'),
      prompt: 'describe',
    });
    expect(result.description).toContain('image/png');
    expect(result.artifact.mime_type).toBe('image/png');
  });

  it('records correct artifact provenance', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('doc'), prompt: 'ocr' });
    expect(result.artifact.provenance.source).toBe('input');
    expect(result.artifact.provenance.generator).toBe('gpt-4o');
    expect(result.artifact.provenance.parameters).toMatchObject({ prompt: 'ocr' });
    expect(result.artifact.provenance.input_artifacts).toEqual([]);
  });

  it('computes correct content hash for integrity verification', async () => {
    setVisionProvider(mockVisionProvider);
    const imgData = Buffer.from('integrity-test-data');
    const result = await understandImage({ image_data: imgData, prompt: 'verify' });
    expect(result.artifact.content_hash).toBe(computeContentHash(imgData));
    expect(result.artifact.byte_size).toBe(imgData.length);
  });

  it('propagates provider errors without swallowing', async () => {
    setVisionProvider(errorProvider);
    await expect(understandImage({ image_data: Buffer.from('x'), prompt: 'test' })).rejects.toThrow('provider API failure');
  });

  it('returns low confidence scores from provider without modification', async () => {
    setVisionProvider(lowConfidenceProvider);
    const result = await understandImage({ image_data: Buffer.from('unclear'), prompt: 'describe' });
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('handles multiple sequential calls with state isolation', async () => {
    setVisionProvider(mockVisionProvider);
    const r1 = await understandImage({ image_data: Buffer.from('page1'), prompt: 'first' });
    const r2 = await understandImage({ image_data: Buffer.from('page2'), prompt: 'second' });
    expect(r1.description).toContain('first');
    expect(r2.description).toContain('second');
    expect(r1.artifact.content_hash).not.toBe(r2.artifact.content_hash);
  });

  it('creates unique artifact IDs for different images', async () => {
    setVisionProvider(mockVisionProvider);
    const r1 = await understandImage({ image_data: Buffer.from('img-a'), prompt: 'test' });
    const r2 = await understandImage({ image_data: Buffer.from('img-b'), prompt: 'test' });
    expect(r1.artifact.artifact_id).not.toBe(r2.artifact.artifact_id);
  });

  it('preserves prompt in artifact parameters for audit trail', async () => {
    setVisionProvider(mockVisionProvider);
    const result = await understandImage({ image_data: Buffer.from('audit'), prompt: 'extract tables' });
    expect(result.artifact.provenance.parameters).toMatchObject({ prompt: 'extract tables' });
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
