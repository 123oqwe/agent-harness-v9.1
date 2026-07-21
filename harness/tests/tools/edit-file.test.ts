import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { editFile } from '../../tools/edit-file.js';

describe('AH-TOOL-EDIT-001 edit_file', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ed-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('replaces all occurrences and writes with checkpoint', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'foo bar foo');
    const r = await editFile(vfs, { path: '/workspace/f.txt', find: 'foo', replace: 'baz' });
    expect(r.replacements).toBe(2);
    expect(r.checkpoint).toBe('edit:/workspace/f.txt');
    expect(readFileSync(join(tmp, 'f.txt'), 'utf8')).toBe('baz bar baz');
  });
  it('throws when pattern not found', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello');
    await expect(editFile(vfs, { path: '/workspace/f.txt', find: 'xyz', replace: 'q' })).rejects.toThrow();
  });
});
