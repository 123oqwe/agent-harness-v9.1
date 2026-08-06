import { describe, expect, it, afterEach } from 'vitest';
import { generateSpeech, transcribeAudio, setTtsProvider, setAsrProvider } from '../../../packages/multimodal/src/speech.js';
import type { TtsProviderPort, AsrProviderPort } from '../../../packages/multimodal/src/speech.js';
import { MultimodalUnavailableError } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

const mockTts: TtsProviderPort = {
  model: 'tts-1',
  async synthesize(text: string, options) {
    return {
      audio_data: Buffer.from(`audio:${text.slice(0, 10)}:${options.voice ?? 'default'}`),
      mime_type: 'audio/mpeg',
    };
  },
};

const mockAsr: AsrProviderPort = {
  model: 'whisper-1',
  async transcribe(audio_data: Buffer, options) {
    return {
      text: `text:${audio_data.length}:${options.language ?? 'auto'}`,
      language: options.language ?? 'en',
      confidence: 0.92,
    };
  },
};

describe('AH-TOOL-SPEECH-001: Speech generation and transcription adapter', () => {
  afterEach(() => {
    setTtsProvider(undefined);
    setAsrProvider(undefined);
  });

  it('generateSpeech throws typed unavailable when no TTS provider', async () => {
    await expect(generateSpeech({ text: 'hello' })).rejects.toThrow(MultimodalUnavailableError);
    try {
      await generateSpeech({ text: 'hello' });
    } catch (e) {
      expect((e as MultimodalUnavailableError).reason).toBe('provider_unavailable');
    }
  });

  it('transcribeAudio throws typed unavailable when no ASR provider', async () => {
    await expect(transcribeAudio({ audio_data: Buffer.from('test') })).rejects.toThrow(MultimodalUnavailableError);
  });

  it('generateSpeech produces audio artifact with provenance via provider', async () => {
    setTtsProvider(mockTts);
    const result = await generateSpeech({ text: 'Hello world', voice: 'alloy', language: 'en' });
    expect(result.audio_data).toBeInstanceOf(Buffer);
    expect(result.audio_data.length).toBeGreaterThan(0);
    expect(result.artifact.type).toBe('audio');
    expect(result.artifact.mime_type).toBe('audio/mpeg');
    expect(result.artifact.provenance.source).toBe('generated');
    expect(result.artifact.provenance.generator).toBe('tts-1');
    expect(result.artifact.provenance.parameters).toMatchObject({ text: 'Hello world', voice: 'alloy', language: 'en' });
  });

  it('transcribeAudio returns text, language, and confidence via provider', async () => {
    setAsrProvider(mockAsr);
    const result = await transcribeAudio({ audio_data: Buffer.from('speech-data'), language: 'fr' });
    expect(result.text).toContain('text:');
    expect(result.language).toBe('fr');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('transcribeAudio defaults language when not specified', async () => {
    setAsrProvider(mockAsr);
    const result = await transcribeAudio({ audio_data: Buffer.from('test') });
    expect(result.language).toBe('en');
  });
});
