import { describe, expect, it, vi } from 'vitest';

import { StoreBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import {
  MediaToolError,
  ToolUnavailableError,
} from '../../tools/media-errors.js';
import {
  createGenerateVideo,
  createVideoGenerationHttpAdapter,
  DEFAULT_VIDEO_ARTIFACTS_DIR,
  type VideoGenerationAdapter,
} from '../../tools/generate-video.js';

function memVfs(): VirtualFilesystem {
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new StoreBackend('/workspace'));
  return vfs;
}

const API_KEY = new TextEncoder().encode('video-key');

function fakeAdapter(overrides: Partial<VideoGenerationAdapter> = {}): VideoGenerationAdapter {
  return {
    generate: vi.fn(async ({ prompt }) => ({
      bytes: new TextEncoder().encode(`video-for:${prompt}`),
      duration_seconds: 5,
      provider: 'api.video-provider.example',
      extension: 'mp4',
    })),
    ...overrides,
  };
}

describe('AH-TOOL-VIDEO-GEN-001 handler', () => {
  it('delegates to the provider adapter and writes bytes to VFS under artifacts/videos/', async () => {
    const vfs = memVfs();
    const adapter = fakeAdapter();
    const handler = createGenerateVideo(adapter);

    const output = await handler(vfs, { prompt: 'sunset over a city' }, { video_gen_api_key: API_KEY });

    expect(output.video_path.startsWith(`${DEFAULT_VIDEO_ARTIFACTS_DIR}/`)).toBe(true);
    expect(output.video_path.endsWith('.mp4')).toBe(true);
    expect(output.duration_seconds).toBe(5);
    expect(output.provider).toBe('api.video-provider.example');
    expect(vfs.exists(output.video_path)).toBe(true);
    expect(vfs.read(output.video_path).toString()).toBe('video-for:sunset over a city');
  });

  it('passes prompt, optional fields and the secrets-broker api key to the adapter', async () => {
    const vfs = memVfs();
    const adapter = fakeAdapter();
    const handler = createGenerateVideo(adapter);

    await handler(vfs, { prompt: 'p', duration: 8, size: '1024x1024', style: 'cinematic' }, { video_gen_api_key: API_KEY });

    expect(adapter.generate).toHaveBeenCalledWith({
      prompt: 'p',
      duration: 8,
      size: '1024x1024',
      style: 'cinematic',
      apiKey: API_KEY,
    });
  });

  it('requires the video generation API key from the secrets broker — no key, no call', async () => {
    const vfs = memVfs();
    const adapter = fakeAdapter();
    const handler = createGenerateVideo(adapter);

    await expect(handler(vfs, { prompt: 'p' })).rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(handler(vfs, { prompt: 'p' })).rejects.toThrow('video_gen_api_key');
    expect(adapter.generate).not.toHaveBeenCalled();
  });

  it('enforces the timeout when the provider hangs', async () => {
    const vfs = memVfs();
    const handler = createGenerateVideo(
      { generate: () => new Promise(() => undefined) },
      { timeoutMs: 20 },
    );

    await expect(handler(vfs, { prompt: 'p' }, { video_gen_api_key: API_KEY })).rejects.toThrow(
      'timed out',
    );
  });

  it('propagates provider failures', async () => {
    const vfs = memVfs();
    const handler = createGenerateVideo(
      { generate: async () => { throw new MediaToolError('provider rejected'); } },
    );
    await expect(handler(vfs, { prompt: 'p' }, { video_gen_api_key: API_KEY })).rejects.toThrow(
      'provider rejected',
    );
  });
});

describe('AH-TOOL-VIDEO-GEN-001 reference HTTP adapter', () => {
  it('denies egress to a provider host outside the allowlist (CTRL-MEDIA-EGRESS-001)', () => {
    expect(() =>
      createVideoGenerationHttpAdapter({
        endpoint: 'https://unapproved.example/videos',
        allowlist: ['api.video-provider.example'],
      }),
    ).toThrow('egress denied');
  });

  it('submits, polls until completed, downloads bytes and reports the provider', async () => {
    const downloadBody = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const isSubmit = u.endsWith('/videos') && (init?.method ?? 'GET') === 'POST';
      const isPoll = u.includes('/videos/job-1') && (init?.method ?? 'GET') === 'GET';
      const isDownload = u === 'https://api.video-provider.example/output.mp4';
      if (isSubmit) return new Response(JSON.stringify({ job_id: 'job-1' }), { status: 200 });
      if (isPoll) return new Response(JSON.stringify({ status: 'completed', url: 'https://api.video-provider.example/output.mp4' }), { status: 200 });
      if (isDownload) return new Response(downloadBody, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const adapter = createVideoGenerationHttpAdapter({
      endpoint: 'https://api.video-provider.example/videos',
      allowlist: ['api.video-provider.example'],
      fetch: fetchMock as unknown as typeof fetch,
    });

    const media = await adapter.generate({ prompt: 'p', apiKey: API_KEY });
    expect(media.provider).toBe('api.video-provider.example');
    expect([...media.bytes]).toEqual([1, 2, 3, 4]);
    // submit + poll + download
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('times out while the provider never completes', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const isSubmit = String(url).endsWith('/videos') && (init?.method ?? 'GET') === 'POST';
      if (isSubmit) return new Response(JSON.stringify({ job_id: 'job-x' }), { status: 200 });
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
    });

    const adapter = createVideoGenerationHttpAdapter({
      endpoint: 'https://api.video-provider.example/videos',
      allowlist: ['api.video-provider.example'],
      pollIntervalMs: 1,
      timeoutMs: 30,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(adapter.generate({ prompt: 'p', apiKey: API_KEY })).rejects.toThrow('timed out');
  });
});
