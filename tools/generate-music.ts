/**
 * AH-TOOL-MUSIC-GEN-001: generate_music model-callable tool.
 *
 * ToolSpec: transport=http_api, tool_group=media_gen, effect=non_idempotent,
 * risk=T2. Requires a capability token whose tool grant includes the
 * music:generate scope (enforced by the PEP before the handler runs). The API
 * key arrives via the secrets-broker single-exchange
 * (credential_requirements.music_gen_api_key).
 *
 * Mirrors AH-TOOL-VIDEO-GEN-001: delegates to an injected provider adapter,
 * restricts egress to the music-provider allowlist (CTRL-MEDIA-EGRESS-001),
 * downloads audio bytes into VFS under artifacts/music/ and returns the VFS
 * path. Timeout enforced (default 300s). Generation prompt is never logged
 * externally (privacy invariant) — this module has no logging surface.
 */
import { createHash } from 'node:crypto';

import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { MediaToolError, ToolUnavailableError, withTimeout } from './media-errors.js';

export interface GenerateMusicInput {
  prompt: string;
  duration?: number;
  genre?: string;
  tempo?: string;
}

export interface GenerateMusicOutput {
  audio_path: string;
  duration_seconds: number;
  provider: string;
}

export interface MusicGenerationAdapter {
  generate(input: {
    prompt: string;
    duration?: number;
    genre?: string;
    tempo?: string;
    apiKey: Uint8Array;
  }): Promise<{
    bytes: Uint8Array;
    duration_seconds: number;
    provider: string;
    extension: string;
  }>;
}

export interface GenerateMusicOptions {
  timeoutMs?: number;
  artifactsDir?: string;
  credentialName?: string;
}

export const DEFAULT_MUSIC_TIMEOUT_MS = 300_000;
export const DEFAULT_MUSIC_ARTIFACTS_DIR = '/workspace/artifacts/music';
export const MUSIC_CREDENTIAL_NAME = 'music_gen_api_key';

export type GenerateMusicHandler = (
  vfs: VirtualFilesystem,
  input: GenerateMusicInput,
  credentials?: Readonly<Record<string, Uint8Array>>,
) => Promise<GenerateMusicOutput>;

/** Build a non-idempotent generate_music handler around a provider adapter. */
export function createGenerateMusic(
  adapter: MusicGenerationAdapter,
  options: GenerateMusicOptions = {},
): GenerateMusicHandler {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MUSIC_TIMEOUT_MS;
  const artifactsDir = options.artifactsDir ?? DEFAULT_MUSIC_ARTIFACTS_DIR;
  const credentialName = options.credentialName ?? MUSIC_CREDENTIAL_NAME;

  return async (vfs, input, credentials) => {
    const apiKey = credentials?.[credentialName];
    if (!apiKey) {
      throw new ToolUnavailableError(
        `music generation requires ${credentialName} via secrets broker`,
      );
    }
    const media = await withTimeout(
      timeoutMs,
      adapter.generate({
        prompt: input.prompt,
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(input.genre !== undefined ? { genre: input.genre } : {}),
        ...(input.tempo !== undefined ? { tempo: input.tempo } : {}),
        apiKey,
      }),
      `music generation timed out after ${timeoutMs}ms`,
    );
    const stem = createHash('sha256').update(input.prompt).digest('hex').slice(0, 16);
    const path = `${artifactsDir}/${stem}-${Date.now()}.${media.extension}`;
    vfs.write(path, Buffer.from(media.bytes));
    return {
      audio_path: path,
      duration_seconds: media.duration_seconds,
      provider: media.provider,
    };
  };
}

/** Options for the reference HTTP adapter (music provider). */
export interface HttpMusicAdapterOptions {
  endpoint: string;
  /** Approved music provider hosts (CTRL-MEDIA-EGRESS-001). */
  allowlist: string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Reference HTTP music provider adapter: submits a job, polls to completion,
 * downloads the bytes, and enforces the egress allowlist before any network
 * call. Injectable `fetch` for tests.
 */
export function createMusicGenerationHttpAdapter(
  options: HttpMusicAdapterOptions,
): MusicGenerationAdapter {
  const { endpoint, allowlist } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MUSIC_TIMEOUT_MS;
  const httpFetch = options.fetch ?? globalThis.fetch;
  if (typeof httpFetch !== 'function') {
    throw new ToolUnavailableError('fetch is not available in this runtime');
  }
  let endpointHost: string;
  try {
    endpointHost = new URL(endpoint).host;
  } catch {
    throw new MediaToolError(`invalid provider endpoint: ${endpoint}`);
  }
  if (!allowlist.includes(endpointHost)) {
    throw new MediaToolError(
      `egress denied: provider host ${endpointHost} not in music-provider allowlist`,
    );
  }

  return {
    async generate({ prompt, duration, genre, tempo, apiKey }) {
      const deadline = Date.now() + timeoutMs;
      const submit = await httpFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${Buffer.from(apiKey).toString('utf8')}`,
        },
        body: JSON.stringify({ prompt, duration, genre, tempo }),
      });
      if (!submit.ok) {
        throw new MediaToolError(`music provider submit failed: HTTP ${submit.status}`);
      }
      const job = (await submit.json()) as { job_id?: string };
      if (!job.job_id) throw new MediaToolError('music provider returned no job_id');

      let url: string | undefined;
      while (Date.now() < deadline) {
        const poll = await httpFetch(`${endpoint}/${job.job_id}`, {
          headers: { authorization: `Bearer ${Buffer.from(apiKey).toString('utf8')}` },
        });
        if (!poll.ok) throw new MediaToolError(`music provider poll failed: HTTP ${poll.status}`);
        const status = (await poll.json()) as { status?: string; url?: string };
        if (status.status === 'completed' && status.url) {
          url = status.url;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      if (!url) throw new ToolUnavailableError('music generation timed out waiting for the provider');

      const bytes = new Uint8Array(await (await httpFetch(url)).arrayBuffer());
      const extension = url.split('?')[0]!.split('.').pop()?.slice(0, 8) ?? 'mp3';
      return {
        bytes,
        duration_seconds: 0,
        provider: endpointHost,
        extension,
      };
    },
  };
}
