/**
 * AH-TOOL-SPEECH-GEN-001: Text-to-speech via http_api.
 * AH-TOOL-TRANSCRIBE-001: Audio transcription via http_api.
 * Supports provider injection; falls back to typed unavailable when no provider configured.
 */
import type { MultimodalArtifact } from './types.js';
import { MultimodalUnavailableError, createArtifact } from './types.js';

export interface SpeechGenInput {
  text: string;
  voice?: string;
  language?: string;
}

/** Provider port for TTS. Implementations call external APIs. */
export interface TtsProviderPort {
  readonly model: string;
  synthesize(text: string, options: { voice?: string; language?: string }): Promise<{ audio_data: Buffer; mime_type: string }>;
}

let ttsProvider: TtsProviderPort | undefined;

/** Configure the TTS provider. */
export function setTtsProvider(provider: TtsProviderPort | undefined): void {
  ttsProvider = provider;
}

export async function generateSpeech(input: SpeechGenInput): Promise<{ artifact: MultimodalArtifact; audio_data: Buffer }> {
  if (!ttsProvider) {
    throw new MultimodalUnavailableError(
      'no TTS provider configured',
      'provider_unavailable',
    );
  }
  const result = await ttsProvider.synthesize(input.text, {
    voice: input.voice,
    language: input.language,
  });
  const artifact = createArtifact('audio', result.mime_type, result.audio_data, {
    source: 'generated',
    generator: ttsProvider.model,
    input_artifacts: [],
    parameters: { text: input.text, voice: input.voice, language: input.language },
  });
  return { artifact, audio_data: result.audio_data };
}

export interface TranscribeInput {
  audio_data: Buffer;
  language?: string;
}

/** Provider port for ASR. Implementations call external APIs. */
export interface AsrProviderPort {
  readonly model: string;
  transcribe(audio_data: Buffer, options: { language?: string }): Promise<{ text: string; language: string; confidence: number; segments?: Array<{ start: number; end: number; text: string }> }>;
}

let asrProvider: AsrProviderPort | undefined;

/** Configure the ASR provider. */
export function setAsrProvider(provider: AsrProviderPort | undefined): void {
  asrProvider = provider;
}

export async function transcribeAudio(input: TranscribeInput): Promise<{ text: string; language: string; confidence: number }> {
  if (!asrProvider) {
    throw new MultimodalUnavailableError(
      'no ASR provider configured',
      'provider_unavailable',
    );
  }
  const result = await asrProvider.transcribe(input.audio_data, {
    language: input.language,
  });
  return {
    text: result.text,
    language: result.language,
    confidence: result.confidence,
  };
}
