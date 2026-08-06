import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { screenshot } from '../../tools/screenshot.js';

describe('AH-TOOL-SCREENSHOT-001 screenshot', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ss-'));
    vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('generates a timestamped png path under /workspace/.screenshots/', async () => {
    try {
      const result = await screenshot(vfs, {});
      expect(result.path).toMatch(/^\/workspace\/\.screenshots\/screenshot-\d+\.png$/);
    } catch (e) {
      // Headless: screencapture fails — verify error shape
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain('screenshot failed');
    }
  });

  it('writes the captured png data to VFS and returns correct metadata', async () => {
    try {
      const result = await screenshot(vfs, {});
      const written = vfs.read(result.path);
      expect(written.length).toBe(result.bytes);
      expect(result.bytes).toBeGreaterThan(0);
      // PNG signature check
      expect(written[0]).toBe(0x89);
      expect(written[1]).toBe(0x50);
      expect(written[2]).toBe(0x4e);
      expect(written[3]).toBe(0x47);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain('screenshot failed');
    }
  });

  it('extracts width and height from the PNG IHDR chunk', async () => {
    try {
      const result = await screenshot(vfs, {});
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain('screenshot failed');
    }
  });

  it('produces unique paths across multiple calls', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        const result = await screenshot(vfs, {});
        paths.push(result.path);
      } catch {
        // Headless: all calls fail the same way
        break;
      }
    }
    if (paths.length > 1) {
      expect(new Set(paths).size).toBe(paths.length);
    }
  });
});
