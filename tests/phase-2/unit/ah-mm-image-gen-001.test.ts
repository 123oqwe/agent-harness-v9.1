import { describe, expect, it } from 'vitest';
import { generateImage, MultimodalUnavailableError } from '../../../packages/multimodal/src/index.js';

describe('AH-MM-IMAGE-GEN-001: Image generation returns typed unavailable', () => {
  it('throws typed unavailable when no provider', async () => {
    await expect(generateImage({ prompt: 'a cat' })).rejects.toThrow(MultimodalUnavailableError);
  });
});
