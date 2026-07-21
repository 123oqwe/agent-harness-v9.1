// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { readFile } from '../../tools/read-file.js';

describe('AH-TOOL-READ-001 read_file', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rd-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('reads a file through VFS', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello world');
    const r = await readFile(vfs, { path: '/workspace/f.txt' });
    expect(r.content).toBe('hello world');
    expect(r.bytes).toBe(11);
  });
  it('truncates beyond max_bytes', async () => {
    writeFileSync(join(tmp, 'big.txt'), 'x'.repeat(100));
    const r = await readFile(vfs, { path: '/workspace/big.txt', max_bytes: 10 });
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(10);
  });
});
