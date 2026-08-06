import { describe, it, expect } from 'vitest';
import { transcribeAudio, setAsrProvider, type AsrProviderPort } from '../../../packages/multimodal/src/speech.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockAsrProvider: AsrProviderPort = {
  model: 'whisper-1',
  async transcribe(audio_data: Buffer, options) {
    return {
      text: `transcribed:${audio_data.length}:${options.language ?? 'auto'}`,
      language: options.language ?? 'en',
      confidence: 0.95,
    };
  },
};

describe('AH-TOOL-TRANSCRIBE-001: Transcribe audio tool (http_api ASR)', () => {
  afterEach(() => setAsrProvider(undefined));

  it('throws when no provider is configured', async () => {
    await expect(transcribeAudio({ audio_data: Buffer.from('test') })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('transcribes audio with a configured provider', async () => {
    setAsrProvider(mockAsrProvider);
    const result = await transcribeAudio({ audio_data: Buffer.from('audio-data'), language: 'en' });
    expect(result.text).toContain('transcribed:');
    expect(result.language).toBe('en');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('defaults language when not specified', async () => {
    setAsrProvider(mockAsrProvider);
    const result = await transcribeAudio({ audio_data: Buffer.from('test') });
    expect(result.language).toBe('en');
  });
});
