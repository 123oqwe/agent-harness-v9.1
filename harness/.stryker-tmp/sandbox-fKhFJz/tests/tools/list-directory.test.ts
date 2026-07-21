// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { listDirectory } from '../../tools/list-directory.js';

describe('AH-TOOL-LIST-001 list_directory', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'td-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('lists entries in a directory', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'a'); writeFileSync(join(tmp, 'b.txt'), 'b');
    const r = await listDirectory(vfs, { path: '/workspace' });
    expect(r.entries.map(e => e.path)).toContain('/workspace/a.txt');
    expect(r.entries.map(e => e.path)).toContain('/workspace/b.txt');
  });
  it('returns empty for empty directory', async () => {
    mkdirSync(join(tmp, 'empty')); const r = await listDirectory(vfs, { path: '/workspace/empty' });
    expect(r.entries).toHaveLength(0);
  });
});
