/**
 * AH-TOOL-VIDEO-GEN-001: generate_video model-callable tool.
 *
 * ToolSpec: transport=http_api, tool_group=media_gen, effect=non_idempotent,
 * risk=T3 (T3 consent). Requires a capability token whose tool grant includes
 * the video:generate scope (the PEP enforces this before the handler runs —
 * the handler itself only ever executes inside the PEP authorization scope).
 * The API key reaches the handler through the secrets-broker single-exchange
 * (the executor leases credentials for tools with credential_requirements).
 *
 * The handler delegates to an injected provider adapter (ADR-014
 * video_generation capability). The reference HTTP adapter restricts egress to
 * an allowlist of approved provider hosts (CTRL-MEDIA-EGRESS-001) and handles
 * async provider polling. Audio/video bytes land in VFS under artifacts/videos/
 * and the tool returns the VFS path. Timeout enforced (default 300s).
 */
import { createHash } from 'node:crypto';

import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { MediaToolError, ToolUnavailableError, withTimeout } from './media-errors.js';

export interface GenerateVideoInput {
  prompt: string;
  duration?: number;
  size?: string;
  style?: string;
}

export interface GenerateVideoOutput {
  video_path: string;
  duration_seconds: number;
  provider: string;
}

/** Result of a provider-side generation, before it is written to VFS. */
export interface GeneratedMedia {
  bytes: Uint8Array;
  duration_seconds: number;
  provider: string;
  extension: string;
}

/** Provider adapter port (ADR-014 video_generation capability). */
export interface VideoGenerationAdapter {
  generate(input: {
    prompt: string;
    duration?: number;
    size?: string;
    style?: string;
    apiKey: Uint8Array;
  }): Promise<GeneratedMedia>;
}

export interface GenerateVideoOptions {
  timeoutMs?: number;
  artifactsDir?: string;
  credentialName?: string;
}

export const DEFAULT_VIDEO_TIMEOUT_MS = 300_000;
export const DEFAULT_VIDEO_ARTIFACTS_DIR = '/workspace/artifacts/videos';
export const VIDEO_CREDENTIAL_NAME = 'video_gen_api_key';

export type GenerateVideoHandler = (
  vfs: VirtualFilesystem,
  input: GenerateVideoInput,
  credentials?: Readonly<Record<string, Uint8Array>>,
) => Promise<GenerateVideoOutput>;

/** Build a non-idempotent generate_video handler around a provider adapter. */
export function createGenerateVideo(
  adapter: VideoGenerationAdapter,
  options: GenerateVideoOptions = {},
): GenerateVideoHandler {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS;
  const artifactsDir = options.artifactsDir ?? DEFAULT_VIDEO_ARTIFACTS_DIR;
  const credentialName = options.credentialName ?? VIDEO_CREDENTIAL_NAME;

  return async (vfs, input, credentials) => {
    const apiKey = credentials?.[credentialName];
    if (!apiKey) {
      throw new ToolUnavailableError(
        `video generation requires ${credentialName} via secrets broker`,
      );
    }
    const media = await withTimeout(
      timeoutMs,
      adapter.generate({
        prompt: input.prompt,
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.style !== undefined ? { style: input.style } : {}),
        apiKey,
      }),
      `video generation timed out after ${timeoutMs}ms`,
    );
    const stem = createHash('sha256')
      .update(input.prompt)
      .digest('hex')
      .slice(0, 16);
    const path = `${artifactsDir}/${stem}-${Date.now()}.${media.extension}`;
    vfs.write(path, Buffer.from(media.bytes));
    return {
      video_path: path,
      duration_seconds: media.duration_seconds,
      provider: media.provider,
    };
  };
}

/** Options for the reference HTTP adapter. */
export interface HttpVideoAdapterOptions {
  /** Submit endpoint for the approved provider, e.g. https://api.provider.com/videos. */
  endpoint: string;
  /** Approved provider hosts (CTRL-MEDIA-EGRESS-001). Everything else is denied. */
  allowlist: string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function assertAllowedHost(endpoint: string, allowlist: string[]): void {
  let host: string;
  try {
    host = new URL(endpoint).host;
  } catch {
    throw new MediaToolError(`invalid provider endpoint: ${endpoint}`);
  }
  if (!allowlist.includes(host)) {
    throw new MediaToolError(
      `egress denied: provider host ${host} not in video-provider allowlist`,
    );
  }
}

/**
 * Reference HTTP provider adapter: submits a generation job, polls until the
 * job completes (async generation), downloads the bytes, and enforces the
 * egress allowlist before any network call. Injectable `fetch` for tests.
 */
export function createVideoGenerationHttpAdapter(
  options: HttpVideoAdapterOptions,
): VideoGenerationAdapter {
  const { endpoint, allowlist } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS;
  const httpFetch = options.fetch ?? globalThis.fetch;
  if (typeof httpFetch !== 'function') {
    throw new ToolUnavailableError('fetch is not available in this runtime');
  }
  assertAllowedHost(endpoint, allowlist);

  return {
    async generate({ prompt, duration, size, style, apiKey }) {
      const deadline = Date.now() + timeoutMs;
      const submit = await httpFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${Buffer.from(apiKey).toString('utf8')}`,
        },
        body: JSON.stringify({ prompt, duration, size, style }),
      });
      if (!submit.ok) {
        throw new MediaToolError(`video provider submit failed: HTTP ${submit.status}`);
      }
      const job = (await submit.json()) as { job_id?: string };
      if (!job.job_id) throw new MediaToolError('video provider returned no job_id');
      const jobUrl = `${endpoint}/${job.job_id}`;

      let url: string | undefined;
      while (Date.now() < deadline) {
        const poll = await httpFetch(jobUrl, {
          headers: { authorization: `Bearer ${Buffer.from(apiKey).toString('utf8')}` },
        });
        if (!poll.ok) throw new MediaToolError(`video provider poll failed: HTTP ${poll.status}`);
        const status = (await poll.json()) as { status?: string; url?: string; duration_seconds?: number };
        if (status.status === 'completed' && status.url) {
          url = status.url;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      if (!url) throw new ToolUnavailableError('video generation timed out waiting for the provider');

      const bytes = new Uint8Array(await (await httpFetch(url)).arrayBuffer());
      const extension = url.split('?')[0]!.split('.').pop()?.slice(0, 8) ?? 'mp4';
      return {
        bytes,
        duration_seconds: 0,
        provider: new URL(endpoint).host,
        extension,
      };
    },
  };
}
