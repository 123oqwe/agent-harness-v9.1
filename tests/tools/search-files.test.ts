import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { searchFiles } from '../../tools/search-files.js';

describe('AH-TOOL-SEARCH-001 search_files', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sd-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('finds files containing the needle', async () => {
    mkdirSync(join(tmp, 'd')); writeFileSync(join(tmp, 'd', 'a.txt'), 'find ME here'); writeFileSync(join(tmp, 'd', 'b.txt'), 'nothing');
    const r = await searchFiles(vfs, { root: '/workspace/d', needle: 'me' });
    expect(r.matches.map(m => m.path)).toEqual(['/workspace/d/a.txt']);
  });
  it('respects max_results', async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(tmp, `f${i}.txt`), 'needle');
    const r = await searchFiles(vfs, { root: '/workspace', needle: 'needle', max_results: 2 });
    expect(r.matches.length).toBe(2);
    expect(r.truncated).toBe(true);
  });
  it('does not report truncation when matches exactly equal max_results', async () => {
    for (let i = 0; i < 2; i++) writeFileSync(join(tmp, `exact${i}.txt`), 'needle');
    const r = await searchFiles(vfs, { root: '/workspace', needle: 'needle', max_results: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });
});
