import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { writeFile } from '../../tools/write-file.js';

describe('AH-TOOL-WRITE-001 write_file', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'wd-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes a file through VFS with checkpoint', async () => {
    const r = await writeFile(vfs, { path: '/workspace/out.txt', content: 'data' });
    expect(r.bytes).toBe(4);
    expect(r.checkpoint).toBe('write:/workspace/out.txt');
    expect(readFileSync(join(tmp, 'out.txt'), 'utf8')).toBe('data');
  });
});
