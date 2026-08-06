import { describe, it, expect } from 'vitest';
import { generateSpeech, setTtsProvider, type TtsProviderPort } from '../../../packages/multimodal/src/speech.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockTtsProvider: TtsProviderPort = {
  model: 'tts-1',
  async synthesize(text: string, options) {
    return {
      audio_data: Buffer.from(`audio:${text}:${options.voice ?? 'default'}`),
      mime_type: 'audio/mpeg',
    };
  },
};

describe('AH-TOOL-SPEECH-GEN-001: Generate speech tool (http_api TTS)', () => {
  afterEach(() => setTtsProvider(undefined));

  it('throws when no provider is configured', async () => {
    await expect(generateSpeech({ text: 'Hello' })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('generates speech with a configured provider', async () => {
    setTtsProvider(mockTtsProvider);
    const result = await generateSpeech({ text: 'Hello world', voice: 'alloy' });
    expect(result.audio_data).toBeInstanceOf(Buffer);
    expect(result.artifact.type).toBe('audio');
    expect(result.artifact.provenance.generator).toBe('tts-1');
  });

  it('includes provenance in the artifact', async () => {
    setTtsProvider(mockTtsProvider);
    const result = await generateSpeech({ text: 'Test', language: 'en' });
    expect(result.artifact.provenance.source).toBe('generated');
    expect(result.artifact.provenance.parameters).toMatchObject({ text: 'Test', language: 'en' });
  });
});
