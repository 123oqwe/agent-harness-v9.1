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

  it('returns encoding field as utf8 by default', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello');
    const r = await readFile(vfs, { path: '/workspace/f.txt' });
    expect(r.encoding).toBe('utf8');
  });

  it('returns encoding field as base64 when requested', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello');
    const r = await readFile(vfs, { path: '/workspace/f.txt', encoding: 'base64' });
    expect(r.encoding).toBe('base64');
    expect(r.content).toBe(Buffer.from('hello').toString('base64'));
  });

  it('returns original byte count even when truncated', async () => {
    writeFileSync(join(tmp, 'big.txt'), 'x'.repeat(100));
    const r = await readFile(vfs, { path: '/workspace/big.txt', max_bytes: 10 });
    expect(r.bytes).toBe(100);
    expect(r.content.length).toBe(10);
  });

  it('defaults to 1 MiB max_bytes when not specified', async () => {
    writeFileSync(join(tmp, 'small.txt'), 'small');
    const r = await readFile(vfs, { path: '/workspace/small.txt' });
    expect(r.truncated).toBe(false);
    expect(r.bytes).toBe(5);
  });

  it('reads binary content as base64', async () => {
    const binData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    writeFileSync(join(tmp, 'img.png'), binData);
    const r = await readFile(vfs, { path: '/workspace/img.png', encoding: 'base64' });
    expect(r.content).toBe(binData.toString('base64'));
    expect(r.bytes).toBe(6);
  });

  it('returns path in output', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'content');
    const r = await readFile(vfs, { path: '/workspace/f.txt' });
    expect(r.path).toBe('/workspace/f.txt');
  });
});
