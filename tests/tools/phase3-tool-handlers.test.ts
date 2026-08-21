import { describe, expect, it, vi } from 'vitest';

import { StoreBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import { ToolUnavailableError } from '../../tools/media-errors.js';
import { createPhase3ToolHandlers } from '../../tools/phase3-tool-handlers.js';
import { PHASE3_TOOL_NAMES } from '../../tools/phase3-tool-definitions.js';
import type { VideoGenerationAdapter } from '../../tools/generate-video.js';
import type { BrowserSessionAdapter, BrowserSession } from '../../tools/browser-operate.js';
import type { ComputerControllerAdapter, ComputerController } from '../../tools/computer-operate.js';
import type { ToolExecutorDeps } from '../../tools/tool-executor.js';

function memVfs(): VirtualFilesystem {
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new StoreBackend('/workspace'));
  return vfs;
}

/** Minimal ToolExecutorDeps for the wiring paths we exercise. */
function depsFor(
  vfs: VirtualFilesystem,
  extra: Partial<Pick<ToolExecutorDeps, 'credentials' | 'sandbox'>> = {},
): ToolExecutorDeps {
  return { vfs, ...extra } as unknown as ToolExecutorDeps;
}

describe('AH-TOOL-* phase 3 wiring', () => {
  it('exposes exactly the five Phase 3 tool names', () => {
    const handlers = createPhase3ToolHandlers();
    expect(Object.keys(handlers).sort()).toEqual([...PHASE3_TOOL_NAMES].sort());
  });

  it('fails closed on unconfigured external-adapter tools', async () => {
    const vfs = memVfs();
    const handlers = createPhase3ToolHandlers();

    await expect(handlers.video_gen!(depsFor(vfs), { prompt: 'x' })).rejects.toThrow(
      ToolUnavailableError,
    );
    await expect(handlers.music_gen!(depsFor(vfs), { prompt: 'x' })).rejects.toThrow(
      ToolUnavailableError,
    );
    await expect(handlers.browser_operate!(depsFor(vfs), { origin: 'https://a.b', action: { type: 'screenshot' } })).rejects.toThrow(
      ToolUnavailableError,
    );
    await expect(handlers.computer_operate!(depsFor(vfs), { app: 'notes', action: { type: 'screenshot' } })).rejects.toThrow(
      ToolUnavailableError,
    );
  });

  it('requires a sandbox profile for video_edit', async () => {
    const vfs = memVfs();
    const handlers = createPhase3ToolHandlers();

    await expect(handlers.video_edit!(depsFor(vfs), {
      command: 'trim', input: '/workspace/a.mp4', output: '/workspace/b.mp4',
    })).rejects.toThrow(ToolUnavailableError);
  });

  it('flows broker credentials into the video handler through ToolExecutorDeps', async () => {
    const vfs = memVfs();
    const fakeAdapter: VideoGenerationAdapter = {
      generate: vi.fn(async ({ apiKey }) => {
        expect(Buffer.from(apiKey).toString('utf8')).toBe('provider-secret');
        return { bytes: new Uint8Array([1, 2, 3]), duration_seconds: 3, provider: 'fal.ai', extension: 'mp4' };
      }),
    };
    const handlers = createPhase3ToolHandlers({ videoAdapter: fakeAdapter });

    const result = await handlers.video_gen!(
      depsFor(vfs, { credentials: { video_gen_api_key: new TextEncoder().encode('provider-secret') } }),
      { prompt: 'a sunset', duration: 3 },
    ) as { video_path: string; provider: string };

    expect(fakeAdapter.generate).toHaveBeenCalledOnce();
    expect(result.provider).toBe('fal.ai');
    expect(vfs.exists(result.video_path)).toBe(true);
  });

  it('delegates browser_operate to an injected session adapter with an origin allowlist', async () => {
    const vfs = memVfs();
    const sessions: BrowserSession[] = [];
    const fakeAdapter: BrowserSessionAdapter = {
      open: vi.fn(async (config) => {
        const session: BrowserSession = {
          origin: config.origin,
          navigate: vi.fn(async (url) => ({ url, title: 'title' })),
          click: vi.fn(async () => {}),
          fill: vi.fn(async () => {}),
          extract: vi.fn(async () => 'text'),
          screenshot: vi.fn(async () => new Uint8Array([9])),
          close: vi.fn(async () => {}),
        };
        sessions.push(session);
        return session;
      }),
    };
    const handlers = createPhase3ToolHandlers({
      browserAdapter: fakeAdapter,
      browserOriginAllowlist: ['https://a.b'],
      browserResolveHost: async () => ['93.184.216.34'],
    });

    const result = await handlers.browser_operate!(depsFor(vfs), {
      origin: 'https://a.b',
      action: { type: 'navigate', url: 'https://a.b/page' },
    }) as { url: string; text: string };

    expect(fakeAdapter.open).toHaveBeenCalledOnce();
    expect(sessions[0]!.origin).toBe('https://a.b');
    expect(result).toMatchObject({ url: 'https://a.b/page', text: 'title' });
    expect(result).not.toHaveProperty('screenshot_path');
  });

  it('denies a browser origin outside the allowlist even with an adapter', async () => {
    const vfs = memVfs();
    const fakeAdapter: BrowserSessionAdapter = {
      open: vi.fn(async (config) => ({
        origin: config.origin,
        navigate: vi.fn(async () => ({ url: '' })),
        click: vi.fn(async () => {}),
        fill: vi.fn(async () => {}),
        extract: vi.fn(async () => ''),
        screenshot: vi.fn(async () => new Uint8Array([0])),
        close: vi.fn(async () => {}),
      })),
    };
    const handlers = createPhase3ToolHandlers({
      browserAdapter: fakeAdapter,
      browserOriginAllowlist: ['https://a.b'],
    });

    await expect(handlers.browser_operate!(depsFor(vfs), {
      origin: 'https://evil.example',
      action: { type: 'navigate', url: 'https://evil.example/' },
    })).rejects.toThrow('origin denied');
    expect(fakeAdapter.open).not.toHaveBeenCalled();
  });

  it('delegates computer_operate to an injected controller adapter with an app allowlist', async () => {
    const vfs = memVfs();
    const fakeAdapter: ComputerControllerAdapter = {
      open: vi.fn(async (config) => {
        const controller: ComputerController = {
          app: config.app,
          window: { x: 0, y: 0, width: 10, height: 10 },
          screenshot: vi.fn(async () => new Uint8Array([7])),
          click: vi.fn(async () => {}),
          type: vi.fn(async () => {}),
          key: vi.fn(async () => {}),
          clipboardRead: vi.fn(async () => 'clip'),
          clipboardWrite: vi.fn(async () => {}),
          close: vi.fn(async () => {}),
        };
        return controller;
      }),
    };
    const handlers = createPhase3ToolHandlers({
      computerAdapter: fakeAdapter,
      computerAppAllowlist: ['notes'],
    });

    const result = await handlers.computer_operate!(depsFor(vfs), {
      app: 'notes',
      action: { type: 'screenshot' },
    }) as { screenshot_path: string };

    expect(fakeAdapter.open).toHaveBeenCalledOnce();
    expect(vfs.exists(result.screenshot_path)).toBe(true);
  });

  it('denies a computer app outside the per-app capability even with an adapter', async () => {
    const vfs = memVfs();
    const fakeAdapter: ComputerControllerAdapter = {
      open: vi.fn(async (config) => ({
        app: config.app,
        window: { x: 0, y: 0, width: 10, height: 10 },
        screenshot: vi.fn(async () => new Uint8Array([0])),
        click: vi.fn(async () => {}),
        type: vi.fn(async () => {}),
        key: vi.fn(async () => {}),
        clipboardRead: vi.fn(async () => ''),
        clipboardWrite: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      })),
    };
    const handlers = createPhase3ToolHandlers({
      computerAdapter: fakeAdapter,
      computerAppAllowlist: ['notes'],
    });

    await expect(handlers.computer_operate!(depsFor(vfs), {
      app: 'evil.app',
      action: { type: 'screenshot' },
    })).rejects.toThrow('app denied');
    expect(fakeAdapter.open).not.toHaveBeenCalled();
  });
});
