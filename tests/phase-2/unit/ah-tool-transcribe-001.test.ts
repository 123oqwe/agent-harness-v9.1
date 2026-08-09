import { describe, it, expect, afterEach } from 'vitest';
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

  it('passes audio_data and language to provider', async () => {
    let capturedData: Buffer | undefined;
    let capturedLang: string | undefined;
    setAsrProvider({
      model: 'test-asr',
      async transcribe(data: Buffer, options) {
        capturedData = data;
        capturedLang = options.language;
        return { text: 'result', language: 'es', confidence: 0.8 };
      },
    });
    await transcribeAudio({ audio_data: Buffer.from('unique-audio'), language: 'es' });
    expect(capturedData?.toString()).toContain('unique-audio');
    expect(capturedLang).toBe('es');
  });

  it('returns confidence as a number between 0 and 1', async () => {
    setAsrProvider(mockAsrProvider);
    const result = await transcribeAudio({ audio_data: Buffer.from('test') });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('supports different languages', async () => {
    setAsrProvider(mockAsrProvider);
    const result = await transcribeAudio({ audio_data: Buffer.from('test'), language: 'fr' });
    expect(result.language).toBe('fr');
  });

  it('propagates provider errors', async () => {
    setAsrProvider({
      model: 'error',
      async transcribe() { throw new Error('ASR API failed'); },
    });
    await expect(transcribeAudio({ audio_data: Buffer.from('x') })).rejects.toThrow('ASR API failed');
  });

  it('handles empty audio data', async () => {
    setAsrProvider(mockAsrProvider);
    const result = await transcribeAudio({ audio_data: Buffer.alloc(0) });
    expect(result.text).toContain('transcribed:0');
  });

  it('handles sequential calls', async () => {
    setAsrProvider(mockAsrProvider);
    const r1 = await transcribeAudio({ audio_data: Buffer.from('audio1-data') });
    const r2 = await transcribeAudio({ audio_data: Buffer.from('audio2-longer') });
    expect(r1.text).not.toBe(r2.text);
  });

  it('handles provider returning empty transcript', async () => {
    setAsrProvider({
      model: 'empty',
      async transcribe() { return { text: '', language: 'en', confidence: 0 }; },
    });
    const result = await transcribeAudio({ audio_data: Buffer.from('audio') });
    expect(result.text).toBe('');
  });

  it('handles provider returning high confidence', async () => {
    setAsrProvider({
      model: 'confident',
      async transcribe() { return { text: 'hello world', language: 'en', confidence: 1.0 }; },
    });
    const result = await transcribeAudio({ audio_data: Buffer.from('audio') });
    expect(result.confidence).toBe(1.0);
  });

  it('handles Unicode transcription', async () => {
    setAsrProvider({
      model: 'test',
      async transcribe() { return { text: '你好世界', language: 'zh', confidence: 0.95 }; },
    });
    const result = await transcribeAudio({ audio_data: Buffer.from('audio') });
    expect(result.text).toBe('你好世界');
  });

  it('handles provider returning long transcript', async () => {
    setAsrProvider({
      model: 'test',
      async transcribe() { return { text: 'A'.repeat(1000), language: 'en', confidence: 0.9 }; },
    });
    const result = await transcribeAudio({ audio_data: Buffer.from('audio') });
    expect(result.text).toHaveLength(1000);
  });

  it('state isolation between provider changes', async () => {
    setAsrProvider({ model: 'first', async transcribe() { return { text: 'first', language: 'en', confidence: 0.9 }; } });
    const r1 = await transcribeAudio({ audio_data: Buffer.from('audio') });
    setAsrProvider({ model: 'second', async transcribe() { return { text: 'second', language: 'en', confidence: 0.8 }; } });
    const r2 = await transcribeAudio({ audio_data: Buffer.from('audio') });
    expect(r1.text).toBe('first');
    expect(r2.text).toBe('second');
  });


  it('handles empty audio path', async () => {
    setAsrProvider({ model: 'test', async transcribe() { return { text: 'test', language: 'en', confidence: 0.9 }; } });
    const result = await transcribeAudio({ audio_data: Buffer.alloc(0) });
    expect(result).toBeDefined();
  });

  it('handles special characters in transcription', async () => {
    setAsrProvider({ model: 'test', async transcribe() { return { text: 'Hello @world! #test', language: 'en', confidence: 0.9 }; } });
    const result = await transcribeAudio({ audio_data: Buffer.from('audio') });
    expect(result.text).toContain('@world');
  });

  it('handles multiple sequential calls', async () => {
    setAsrProvider({ model: 'test', async transcribe() { return { text: 'test', language: 'en', confidence: 0.9 }; } });
    const r1 = await transcribeAudio({ audio_data: Buffer.from('audio1') });
    const r2 = await transcribeAudio({ audio_data: Buffer.from('audio2') });
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
  });

  it('handles low confidence transcription', async () => {
    setAsrProvider({ model: 'test', async transcribe() { return { text: 'unclear', language: 'en', confidence: 0.3 }; } });
    const result = await transcribeAudio({ audio_data: Buffer.from('audio') });
    expect(result.confidence).toBeLessThan(0.5);
  });

});
