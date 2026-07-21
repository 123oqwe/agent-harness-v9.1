import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend, OverlayBackend, StoreBackend } from '../../vfs/virtual-filesystem.js';
import { writeFile } from '../../tools/write-file.js';

describe('AH-TOOL-WRITE-001 write_file checkpoint', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'wcp-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }, { prefix: '/scratch', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('checkpoint is returned and can be used for transaction tracking', async () => {
    const r = await writeFile(vfs, { path: '/workspace/a.txt', content: 'data' });
    expect(r.checkpoint).toMatch(/^write:/);
    expect(readFileSync(join(tmp, 'a.txt'), 'utf8')).toBe('data');
  });

  it('write to overlay stages without committing to local backend', async () => {
    const overlay = new OverlayBackend('/scratch');
    vfs.mount(overlay);
    const r = await writeFile(vfs, { path: '/scratch/staged.txt', content: 'staged' });
    expect(r.checkpoint).toBe('write:/scratch/staged.txt');
    expect(overlay.exists('/scratch/staged.txt')).toBe(true);
    expect(() => readFileSync(join(tmp, 'staged.txt'), 'utf8')).toThrow();
  });

  it('overlay commit makes the write durable in a store target', async () => {
    // dedicated VFS with overlay only; commitOverlay writes to an unmounted StoreBackend target
    const commitVfs = new VirtualFilesystem([{ prefix: '/scratch', read: true, write: true }]);
    const overlay = new OverlayBackend('/scratch');
    commitVfs.mount(overlay);
    const target = new StoreBackend('/scratch');
    overlay.write('/scratch/c.txt', Buffer.from('committed'));
    commitVfs.commitOverlay(overlay, target);
    expect(overlay.isCommitted()).toBe(true);
    expect(target.read('/scratch/c.txt').toString()).toBe('committed');
  });
});
