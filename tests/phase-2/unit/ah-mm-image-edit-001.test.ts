import { describe, it, expect, afterEach } from 'vitest';
import { editImage, setImageEditProvider, type ImageEditProviderPort, type ImageEditInput } from '../../../packages/multimodal/src/image-edit.js';
import { MultimodalUnavailableError, computeContentHash } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockEditProvider: ImageEditProviderPort = {
  model: 'dall-e-2',
  async edit(image_data: Buffer, edit_prompt: string, opts: { preserve_identity?: boolean }) {
    return {
      image_data: Buffer.from(`edited:${image_data.length}:${edit_prompt}:${opts.preserve_identity ?? false}`),
      mime_type: 'image/png',
    };
  },
};

const errorProvider: ImageEditProviderPort = {
  model: 'error-edit',
  async edit() { throw new Error('edit API failed'); },
};

describe('AH-MM-IMAGE-EDIT-001: Image editing with identity preservation', () => {
  afterEach(() => setImageEditProvider(undefined));

  it('throws unavailable when no provider is configured', async () => {
    const input: ImageEditInput = {
      image_data: Buffer.from('fake-image'),
      edit_prompt: 'make it blue',
      preserve_identity: true,
    };
    await expect(editImage(input)).rejects.toThrow(MultimodalUnavailableError);
  });

  it('throws with provider_unavailable reason when no provider', async () => {
    try {
      await editImage({ image_data: Buffer.from('x'), edit_prompt: 'test' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MultimodalUnavailableError);
      expect((e as MultimodalUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('edits an image with a configured provider', async () => {
    setImageEditProvider(mockEditProvider);
    const result = await editImage({ image_data: Buffer.from('png-data'), edit_prompt: 'add text overlay' });
    expect(result.image_data).toBeInstanceOf(Buffer);
    expect(result.artifact.type).toBe('image');
    expect(result.artifact.provenance.source).toBe('edited');
  });

  it('passes preserve_identity option to provider', async () => {
    setImageEditProvider(mockEditProvider);
    const result = await editImage({ image_data: Buffer.from('img'), edit_prompt: 'blur background', preserve_identity: true });
    expect(result.artifact.provenance.parameters).toMatchObject({ preserve_identity: true });
    expect(result.image_data.toString()).toContain('true');
  });

  it('defaults preserve_identity to undefined when not specified', async () => {
    setImageEditProvider(mockEditProvider);
    const result = await editImage({ image_data: Buffer.from('img'), edit_prompt: 'resize' });
    expect(result.image_data.toString()).toContain('false');
    expect(result.artifact.provenance.parameters).toMatchObject({ preserve_identity: undefined });
  });

  it('records edit_prompt in artifact parameters', async () => {
    setImageEditProvider(mockEditProvider);
    const result = await editImage({ image_data: Buffer.from('img'), edit_prompt: 'remove background' });
    expect(result.artifact.provenance.parameters).toMatchObject({ edit_prompt: 'remove background' });
  });

  it('computes correct content hash for edited image', async () => {
    setImageEditProvider(mockEditProvider);
    const result = await editImage({ image_data: Buffer.from('original'), edit_prompt: 'enhance' });
    expect(result.artifact.content_hash).toBe(computeContentHash(result.image_data));
    expect(result.artifact.byte_size).toBe(result.image_data.length);
  });

  it('sets artifact source to edited', async () => {
    setImageEditProvider(mockEditProvider);
    const result = await editImage({ image_data: Buffer.from('x'), edit_prompt: 'test' });
    expect(result.artifact.provenance.source).toBe('edited');
    expect(result.artifact.provenance.generator).toBe('dall-e-2');
  });

  it('propagates provider errors without swallowing', async () => {
    setImageEditProvider(errorProvider);
    await expect(editImage({ image_data: Buffer.from('x'), edit_prompt: 'test' })).rejects.toThrow('edit API failed');
  });

  it('produces different output for different edit prompts', async () => {
    setImageEditProvider(mockEditProvider);
    const r1 = await editImage({ image_data: Buffer.from('img'), edit_prompt: 'prompt-a' });
    const r2 = await editImage({ image_data: Buffer.from('img'), edit_prompt: 'prompt-b' });
    expect(r1.image_data.toString()).not.toBe(r2.image_data.toString());
    expect(r1.artifact.artifact_id).not.toBe(r2.artifact.artifact_id);
  });

  it('handles provider returning edited image', async () => {
    setImageEditProvider({
      model: 'edit-provider',
      async edit() { return { image_data: Buffer.from('edited'), mime_type: 'image/png' }; },
    });
    const result = await editImage({ image_data: Buffer.from('original'), edit_prompt: 'make it blue' });
    expect(result.image_data.toString()).toBe('edited');
  });

  it('handles empty prompt', async () => {
    setImageEditProvider({
      model: 'test',
      async edit(_image_data: Buffer, edit_prompt: string, _options: { preserve_identity?: boolean }) { return { image_data: Buffer.from(edit_prompt), mime_type: 'image/png' }; },
    });
    const result = await editImage({ image_data: Buffer.from('x'), edit_prompt: '' });
    expect(result.image_data.toString()).toBe('');
  });

  it('handles Unicode prompt', async () => {
    setImageEditProvider({
      model: 'test',
      async edit(_image_data: Buffer, edit_prompt: string, _options: { preserve_identity?: boolean }) { return { image_data: Buffer.from(edit_prompt), mime_type: 'image/png' }; },
    });
    const result = await editImage({ image_data: Buffer.from('x'), edit_prompt: '编辑图片' });
    expect(result.image_data.toString()).toBe('编辑图片');
  });

  it('records correct artifact provenance', async () => {
    setImageEditProvider({
      model: 'edit-model',
      async edit() { return { image_data: Buffer.from('edited'), mime_type: 'image/jpeg' }; },
    });
    const result = await editImage({ image_data: Buffer.from('orig'), edit_prompt: 'test' });
    expect(result.artifact.provenance.generator).toBe('edit-model');
    expect(result.artifact.mime_type).toBe('image/jpeg');
  });

  it('computes correct content hash', async () => {
    const editedData = Buffer.from('edited-content');
    setImageEditProvider({
      model: 'test',
      async edit() { return { image_data: editedData, mime_type: 'image/png' }; },
    });
    const result = await editImage({ image_data: Buffer.from('orig'), edit_prompt: 'test' });
    expect(result.artifact.content_hash).toBe(computeContentHash(editedData));
  });


  it('handles empty image data', async () => {
    setImageEditProvider({ model: 'test', async edit() { return { image_data: Buffer.from('edited'), mime_type: 'image/png' }; } });
    const result = await editImage({ image_data: Buffer.alloc(0), edit_prompt: 'test' });
    expect(result).toBeDefined();
  });

  it('handles state isolation', async () => {
    setImageEditProvider({ model: 'first', async edit() { return { image_data: Buffer.from('a'), mime_type: 'image/png' }; } });
    const r1 = await editImage({ image_data: Buffer.from('x'), edit_prompt: 'test' });
    setImageEditProvider({ model: 'second', async edit() { return { image_data: Buffer.from('b'), mime_type: 'image/png' }; } });
    const r2 = await editImage({ image_data: Buffer.from('x'), edit_prompt: 'test' });
    expect(r1.image_data.toString()).toBe('a');
    expect(r2.image_data.toString()).toBe('b');
  });

});
