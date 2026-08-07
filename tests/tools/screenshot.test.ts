import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdtempSync: actual.mkdtempSync,
    rmSync: actual.rmSync,
  };
});

import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { screenshot } from '../../tools/screenshot.js';

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);

function makePng(width: number, height: number, extraBytes = 0): Buffer {
  const buf = Buffer.alloc(33 + extraBytes);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 6;
  buf[26] = 0; buf[27] = 0; buf[28] = 0;
  return buf;
}

describe('AH-TOOL-SCREENSHOT-001 screenshot', () => {
  let tmp: string;
  let vfs: VirtualFilesystem;
  let originalPlatform: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ss-'));
    vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    originalPlatform = process.platform;
    mockedSpawnSync.mockReset();
    mockedReadFileSync.mockReset();
    mockedUnlinkSync.mockReset();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  function setPlatform(p: string) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  function mockSpawnSuccess(pngData: Buffer) {
    mockedSpawnSync.mockReturnValue({
      status: 0, stdout: '', stderr: '', pid: 12345,
      output: [null, '', ''], signal: null,
    } as any);
    mockedReadFileSync.mockReturnValue(pngData as unknown as string);
  }

  function mockSpawnFailure(stderr: string) {
    mockedSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr, pid: 12345,
      output: [null, '', stderr], signal: null,
    } as any);
  }

  it('captures screen via screencapture on macOS and writes PNG to VFS', async () => {
    setPlatform('darwin');
    const png = makePng(800, 600);
    mockSpawnSuccess(png);
    const result = await screenshot(vfs, {});
    expect(result.path).toMatch(/^\/workspace\/\.screenshots\/screenshot-\d+\.png$/);
    expect(result.bytes).toBe(png.length);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    const call = mockedSpawnSync.mock.calls[0]!;
    expect(call[0]).toBe('screencapture');
    expect(call[1]).toContain('-x');
    expect(call[1]).toContain('png');
    const written = vfs.read(result.path);
    expect(written.length).toBe(png.length);
    expect(mockedUnlinkSync).toHaveBeenCalledTimes(1);
  });

  it('uses shell:false in spawnSync options on macOS', async () => {
    setPlatform('darwin');
    mockSpawnSuccess(makePng(100, 100));
    await screenshot(vfs, {});
    const opts = mockedSpawnSync.mock.calls[0]![2] as any;
    expect(opts.shell).toBe(false);
    expect(opts.encoding).toBe('utf8');
  });

  it('throws when screencapture fails on macOS', async () => {
    setPlatform('darwin');
    mockSpawnFailure('display not found');
    await expect(screenshot(vfs, {})).rejects.toThrow('screenshot failed: display not found');
  });

  it('throws with unknown error when stderr is empty', async () => {
    setPlatform('darwin');
    mockSpawnFailure('');
    await expect(screenshot(vfs, {})).rejects.toThrow('screenshot failed: unknown error');
  });

  it('captures screen via import (ImageMagick) on Linux', async () => {
    setPlatform('linux');
    const png = makePng(1920, 1080);
    mockSpawnSuccess(png);
    const result = await screenshot(vfs, {});
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockedSpawnSync.mock.calls[0]![0]).toBe('import');
    expect(mockedSpawnSync.mock.calls[0]![1]).toContain('-window');
    expect(mockedSpawnSync.mock.calls[0]![1]).toContain('root');
  });

  it('falls back to scrot when import fails on Linux', async () => {
    setPlatform('linux');
    const png = makePng(640, 480);
    mockedSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'import not found', pid: 1, output: [null, '', ''], signal: null } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 2, output: [null, '', ''], signal: null } as any);
    mockedReadFileSync.mockReturnValue(png as unknown as string);
    const result = await screenshot(vfs, {});
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(2);
    expect(mockedSpawnSync.mock.calls[0]![0]).toBe('import');
    expect(mockedSpawnSync.mock.calls[1]![0]).toBe('scrot');
  });

  it('throws when both import and scrot fail on Linux', async () => {
    setPlatform('linux');
    mockedSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'import failed', pid: 1, output: [null, '', ''], signal: null } as any)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'scrot failed', pid: 2, output: [null, '', ''], signal: null } as any);
    await expect(screenshot(vfs, {})).rejects.toThrow('screenshot failed: scrot failed');
    expect(mockedSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('returns width=0 when data length <= 24 bytes', async () => {
    setPlatform('darwin');
    const shortPng = Buffer.alloc(20);
    shortPng[0] = 0x89;
    mockSpawnSuccess(shortPng);
    const result = await screenshot(vfs, {});
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it('returns height=0 when data length is between 25 and 28 bytes', async () => {
    setPlatform('darwin');
    const midPng = Buffer.alloc(26);
    midPng[0] = 0x89;
    midPng.writeUInt32BE(400, 16);
    mockSpawnSuccess(midPng);
    const result = await screenshot(vfs, {});
    expect(result.width).toBe(400);
    expect(result.height).toBe(0);
  });

  it('continues even if unlinkSync throws', async () => {
    setPlatform('darwin');
    const png = makePng(100, 100);
    mockSpawnSuccess(png);
    mockedUnlinkSync.mockImplementation(() => { throw new Error('permission denied'); });
    const result = await screenshot(vfs, {});
    expect(result.width).toBe(100);
  });

  it('produces unique paths across multiple calls', async () => {
    setPlatform('darwin');
   mockSpawnSuccess(makePng(100, 100));
    const results: Awaited<ReturnType<typeof screenshot>>[] = [];
    for (let i = 0; i < 3; i++) {
      results.push(await screenshot(vfs, {}));
      await new Promise(r => setTimeout(r, 2));
    }
    const paths = results.map(r => r.path);
    expect(new Set(paths).size).toBe(3);
  });

  it('writes the captured png data to VFS with correct PNG signature', async () => {
    setPlatform('darwin');
    const png = makePng(320, 240);
    mockSpawnSuccess(png);
    const result = await screenshot(vfs, {});
    const written = vfs.read(result.path);
    expect(written[0]).toBe(0x89);
    expect(written[1]).toBe(0x50);
    expect(written[2]).toBe(0x4e);
    expect(written[3]).toBe(0x47);
    expect(written.length).toBe(result.bytes);
  });

  it('accepts optional display input without error', async () => {
    setPlatform('darwin');
    mockSpawnSuccess(makePng(100, 100));
    const result = await screenshot(vfs, { display: 0 });
    expect(result.path).toMatch(/^\/workspace\/\.screenshots\/screenshot-\d+\.png$/);
  });

  it('tries import on unknown platform (else branch)', async () => {
    setPlatform('win32');
    const png = makePng(100, 100);
    mockSpawnSuccess(png);
    const result = await screenshot(vfs, {});
    expect(result.width).toBe(100);
    expect(mockedSpawnSync.mock.calls[0]![0]).toBe('import');
  });
});
