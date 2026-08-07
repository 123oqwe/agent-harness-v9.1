import { describe, it, expect, afterEach } from 'vitest';
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

  it('passes voice and language options to provider', async () => {
    let capturedOpts: { voice?: string; language?: string } = {};
    setTtsProvider({
      model: 'test-tts',
      async synthesize(_text: string, options) {
        capturedOpts = options;
        return { audio_data: Buffer.from('x'), mime_type: 'audio/wav' };
      },
    });
    await generateSpeech({ text: 'test', voice: 'nova', language: 'fr' });
    expect(capturedOpts.voice).toBe('nova');
    expect(capturedOpts.language).toBe('fr');
  });

  it('artifact byte_size matches audio data length', async () => {
    setTtsProvider(mockTtsProvider);
    const result = await generateSpeech({ text: 'hello' });
    expect(result.artifact.byte_size).toBe(result.audio_data.byteLength);
  });

  it('artifact content_hash is a valid SHA-256', async () => {
    setTtsProvider(mockTtsProvider);
    const result = await generateSpeech({ text: 'hash test' });
    expect(result.artifact.content_hash).toHaveLength(64);
    expect(result.artifact.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('propagates provider errors', async () => {
    setTtsProvider({
      model: 'error',
      async synthesize() { throw new Error('TTS API timeout'); },
    });
    await expect(generateSpeech({ text: 'test' })).rejects.toThrow('TTS API timeout');
  });

  it('handles different voices', async () => {
    setTtsProvider(mockTtsProvider);
    const r1 = await generateSpeech({ text: 'hello', voice: 'alloy' });
    const r2 = await generateSpeech({ text: 'hello', voice: 'nova' });
    expect(r1.audio_data.toString()).toContain('alloy');
    expect(r2.audio_data.toString()).toContain('nova');
  });

  it('handles sequential calls with different text', async () => {
    setTtsProvider(mockTtsProvider);
    const r1 = await generateSpeech({ text: 'first' });
    const r2 = await generateSpeech({ text: 'second' });
    expect(r1.artifact.artifact_id).not.toBe(r2.artifact.artifact_id);
  });
});
