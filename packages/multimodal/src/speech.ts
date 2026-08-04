/**
 * AH-TOOL-SPEECH-GEN-001: Text-to-speech via http_api.
 * AH-TOOL-TRANSCRIBE-001: Audio transcription via http_api.
 * Returns typed unavailable when no provider is configured.
 */
import type { MultimodalArtifact } from './types.js';
import { MultimodalUnavailableError, createArtifact } from './types.js';

export interface SpeechGenInput {
  text: string;
  voice?: string;
  language?: string;
}

export async function generateSpeech(input: SpeechGenInput): Promise<{ artifact: MultimodalArtifact; audio_data: Buffer }> {
  throw new MultimodalUnavailableError(
    'no TTS provider configured',
    'provider_unavailable',
  );
}

export interface TranscribeInput {
  audio_data: Buffer;
  language?: string;
}

export async function transcribeAudio(input: TranscribeInput): Promise<{ text: string; language: string; confidence: number }> {
  throw new MultimodalUnavailableError(
    'no ASR provider configured',
    'provider_unavailable',
  );
}
