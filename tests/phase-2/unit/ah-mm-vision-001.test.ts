import { describe, expect, it } from 'vitest';
import { understandImage, verifyGeneratedContent, MultimodalUnavailableError } from '../../../packages/multimodal/src/index.js';

describe('AH-MM-IMAGE-IN-001 / AH-MM-DOC-VISION-001 / AH-MM-VISION-VERIFY-001', () => {
  it('understandImage returns typed unavailable', async () => {
    await expect(understandImage({ image_data: Buffer.from('test'), prompt: 'describe' }))
      .rejects.toThrow(MultimodalUnavailableError);
  });

  it('verifyGeneratedContent returns typed unavailable', async () => {
    await expect(verifyGeneratedContent(Buffer.from('test'), 'a cat'))
      .rejects.toThrow(MultimodalUnavailableError);
  });
});
