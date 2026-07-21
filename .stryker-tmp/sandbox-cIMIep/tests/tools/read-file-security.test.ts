// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend, StoreBackend, VfsError } from '../../vfs/virtual-filesystem.js';
import { readFile } from '../../tools/read-file.js';

describe('AH-TOOL-READ-001 read_file security', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rds-'));
    vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
      { prefix: '/workspace/secret', read: false, write: false },
    ]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    vfs.mount(new StoreBackend('/workspace/secret'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('denies reading a path with no read permission (deny rule wins by longest prefix)', async () => {
    await expect(readFile(vfs, { path: '/workspace/secret/k.txt' })).rejects.toThrow(VfsError);
  });
  it('rejects path traversal', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'ok');
    await expect(readFile(vfs, { path: '/workspace/../etc/passwd' })).rejects.toThrow(VfsError);
  });
  it('blocks symlink escape', async () => {
    symlinkSync(tmpdir(), join(tmp, 'escape'));
    await expect(readFile(vfs, { path: '/workspace/escape' })).rejects.toThrow(VfsError);
  });
});
