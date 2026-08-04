import { describe, expect, it } from 'vitest';
import { generateSpeech, transcribeAudio, MultimodalUnavailableError } from '../../../packages/multimodal/src/index.js';

describe('AH-TOOL-SPEECH-GEN-001 / AH-TOOL-TRANSCRIBE-001', () => {
  it('generateSpeech returns typed unavailable', async () => {
    await expect(generateSpeech({ text: 'hello' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('transcribeAudio returns typed unavailable', async () => {
    await expect(transcribeAudio({ audio_data: Buffer.from('test') })).rejects.toThrow(MultimodalUnavailableError);
  });
});
