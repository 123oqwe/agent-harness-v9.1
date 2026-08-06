import { describe, it, expect } from 'vitest';
import * as mod from '../../../packages/multimodal/src/image-edit.js';
import { editImage, type ImageEditInput } from '../../../packages/multimodal/src/image-edit.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';

describe('AH-MM-IMAGE-EDIT-001', () => {
  it('module is importable', () => {
    expect(mod).toBeDefined();
  });

  it('exports at least one symbol', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it('throws unavailable when no provider is configured', async () => {
    const input: ImageEditInput = {
      image_data: Buffer.from('fake-image'),
      edit_prompt: 'make it blue',
      preserve_identity: true,
    };
    await expect(editImage(input)).rejects.toThrow(MultimodalUnavailableError);
  });
});
