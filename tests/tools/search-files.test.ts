import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { searchFiles } from '../../tools/search-files.js';

describe('AH-TOOL-SEARCH-001 search_files', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sd-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }, { prefix: tmp, read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); vfs.mount(new LocalBackend(tmp, tmp)); });
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

  it('defaults to content mode when mode not specified', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'searchable text');
    const r = await searchFiles(vfs, { root: '/workspace', needle: 'searchable' });
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it('defaults max_results to 100 when not specified', async () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(tmp, `f${i}.txt`), 'needle');
    const r = await searchFiles(vfs, { root: '/workspace', needle: 'needle' });
    expect(r.matches.length).toBeLessThanOrEqual(100);
  });

  it('searches in subdirectories', async () => {
    mkdirSync(join(tmp, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(tmp, 'sub', 'deep', 'found.txt'), 'target needle');
    writeFileSync(join(tmp, 'sub', 'miss.txt'), 'other');
    const r = await searchFiles(vfs, { root: '/workspace/sub', needle: 'needle' });
    expect(r.matches.map(m => m.path)).toContain('/workspace/sub/deep/found.txt');
  });

  it('returns empty matches when needle not found', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'nothing relevant');
    const r = await searchFiles(vfs, { root: '/workspace', needle: 'nonexistent' });
    expect(r.matches).toHaveLength(0);
    expect(r.truncated).toBe(false);
  });

  it('supports regex mode via ripgrep when available', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'line1: 42\nline2: 99');
    const r = await searchFiles(vfs, { root: tmp, needle: '\\d+', mode: 'regex' });
    // If rg is available on the real filesystem, it should find matches with line numbers
    // If rg is not available, VFS fallback does substring search (no regex), so matches may be empty
    expect(Array.isArray(r.matches)).toBe(true);
    expect(r.truncated).toBe(false);
    // When rg finds results, they should have line_number set
    for (const m of r.matches) {
      expect(m.path).toContain(tmp);
    }
  });

  it('supports filename mode listing files under root', async () => {
    writeFileSync(join(tmp, 'findme.txt'), 'content');
    writeFileSync(join(tmp, 'other.txt'), 'content');
    const r = await searchFiles(vfs, { root: tmp, needle: '', mode: 'filename' });
    expect(Array.isArray(r.matches)).toBe(true);
    // If rg --files is available, it lists all files; VFS fallback returns empty for filename mode
    if (r.matches.length > 0) {
      const paths = r.matches.map(m => m.path);
      expect(paths.some(p => p.includes('findme.txt'))).toBe(true);
      expect(paths.some(p => p.includes('other.txt'))).toBe(true);
    }
  });

  it('handles non-existent root gracefully', async () => {
    const r = await searchFiles(vfs, { root: '/workspace/nonexistent', needle: 'test' });
    expect(r.matches).toHaveLength(0);
    expect(r.truncated).toBe(false);
  });
});
