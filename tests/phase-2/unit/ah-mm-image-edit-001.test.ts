import { describe, it, expect } from 'vitest';
import { editImage, setImageEditProvider, type ImageEditProviderPort, type ImageEditInput } from '../../../packages/multimodal/src/image-edit.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockEditProvider: ImageEditProviderPort = {
  model: 'dall-e-2',
  async edit(image_data: Buffer, edit_prompt: string) {
    return {
      image_data: Buffer.from(`edited:${image_data.length}:${edit_prompt}`),
      mime_type: 'image/png',
    };
  },
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
  });
});
