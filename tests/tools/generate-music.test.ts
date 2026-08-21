import { describe, expect, it, vi } from 'vitest';

import { StoreBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import {
  MediaToolError,
  ToolUnavailableError,
} from '../../tools/media-errors.js';
import {
  createGenerateMusic,
  createMusicGenerationHttpAdapter,
  DEFAULT_MUSIC_ARTIFACTS_DIR,
  type MusicGenerationAdapter,
} from '../../tools/generate-music.js';

function memVfs(): VirtualFilesystem {
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new StoreBackend('/workspace'));
  return vfs;
}

const API_KEY = new TextEncoder().encode('music-key');

function fakeAdapter(overrides: Partial<MusicGenerationAdapter> = {}): MusicGenerationAdapter {
  return {
    generate: vi.fn(async ({ prompt }) => ({
      bytes: new TextEncoder().encode(`audio-for:${prompt}`),
      duration_seconds: 90,
      provider: 'api.music-provider.example',
      extension: 'mp3',
    })),
    ...overrides,
  };
}

describe('AH-TOOL-MUSIC-GEN-001 handler', () => {
  it('delegates to the provider adapter and writes bytes to VFS under artifacts/music/', async () => {
    const vfs = memVfs();
    const adapter = fakeAdapter();
    const handler = createGenerateMusic(adapter);

    const output = await handler(vfs, { prompt: 'chill lo-fi beat' }, { music_gen_api_key: API_KEY });

    expect(output.audio_path.startsWith(`${DEFAULT_MUSIC_ARTIFACTS_DIR}/`)).toBe(true);
    expect(output.audio_path.endsWith('.mp3')).toBe(true);
    expect(output.duration_seconds).toBe(90);
    expect(output.provider).toBe('api.music-provider.example');
    expect(vfs.exists(output.audio_path)).toBe(true);
    expect(vfs.read(output.audio_path).toString()).toBe('audio-for:chill lo-fi beat');
  });

  it('passes prompt, optional fields and the secrets-broker api key to the adapter', async () => {
    const vfs = memVfs();
    const adapter = fakeAdapter();
    const handler = createGenerateMusic(adapter);

    await handler(vfs, { prompt: 'p', duration: 120, genre: 'ambient', tempo: '120bpm' }, { music_gen_api_key: API_KEY });

    expect(adapter.generate).toHaveBeenCalledWith({
      prompt: 'p',
      duration: 120,
      genre: 'ambient',
      tempo: '120bpm',
      apiKey: API_KEY,
    });
  });

  it('requires the music generation API key from the secrets broker — no key, no call', async () => {
    const vfs = memVfs();
    const adapter = fakeAdapter();
    const handler = createGenerateMusic(adapter);

    await expect(handler(vfs, { prompt: 'p' })).rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(handler(vfs, { prompt: 'p' })).rejects.toThrow('music_gen_api_key');
    expect(adapter.generate).not.toHaveBeenCalled();
  });

  it('enforces the timeout when the provider hangs', async () => {
    const vfs = memVfs();
    const handler = createGenerateMusic(
      { generate: () => new Promise(() => undefined) },
      { timeoutMs: 20 },
    );

    await expect(handler(vfs, { prompt: 'p' }, { music_gen_api_key: API_KEY })).rejects.toThrow(
      'timed out',
    );
  });

  it('propagates provider failures', async () => {
    const vfs = memVfs();
    const handler = createGenerateMusic(
      { generate: async () => { throw new MediaToolError('provider rejected'); } },
    );
    await expect(handler(vfs, { prompt: 'p' }, { music_gen_api_key: API_KEY })).rejects.toThrow(
      'provider rejected',
    );
  });
});

describe('AH-TOOL-MUSIC-GEN-001 reference HTTP adapter', () => {
  it('denies egress to a provider host outside the allowlist (CTRL-MEDIA-EGRESS-001)', () => {
    expect(() =>
      createMusicGenerationHttpAdapter({
        endpoint: 'https://unapproved.example/music',
        allowlist: ['api.music-provider.example'],
      }),
    ).toThrow('egress denied');
  });

  it('submits, polls until completed, downloads bytes and reports the provider', async () => {
    const downloadBody = new Uint8Array([5, 6, 7]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const isSubmit = u.endsWith('/music') && (init?.method ?? 'GET') === 'POST';
      const isPoll = u.includes('/music/job-1') && (init?.method ?? 'GET') === 'GET';
      const isDownload = u === 'https://api.music-provider.example/output.mp3';
      if (isSubmit) return new Response(JSON.stringify({ job_id: 'job-1' }), { status: 200 });
      if (isPoll) return new Response(JSON.stringify({ status: 'completed', url: 'https://api.music-provider.example/output.mp3' }), { status: 200 });
      if (isDownload) return new Response(downloadBody, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const adapter = createMusicGenerationHttpAdapter({
      endpoint: 'https://api.music-provider.example/music',
      allowlist: ['api.music-provider.example'],
      fetch: fetchMock as unknown as typeof fetch,
    });

    const media = await adapter.generate({ prompt: 'p', apiKey: API_KEY });
    expect(media.provider).toBe('api.music-provider.example');
    expect([...media.bytes]).toEqual([5, 6, 7]);
    // submit + poll + download
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('times out while the provider never completes', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const isSubmit = String(url).endsWith('/music') && (init?.method ?? 'GET') === 'POST';
      if (isSubmit) return new Response(JSON.stringify({ job_id: 'job-x' }), { status: 200 });
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
    });

    const adapter = createMusicGenerationHttpAdapter({
      endpoint: 'https://api.music-provider.example/music',
      allowlist: ['api.music-provider.example'],
      pollIntervalMs: 1,
      timeoutMs: 30,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(adapter.generate({ prompt: 'p', apiKey: API_KEY })).rejects.toThrow('timed out');
  });
});
