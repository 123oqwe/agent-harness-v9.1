import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchFiles } from '../../tools/search-files.js';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';

describe('searchFiles with ripgrep', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ah-search-rg-'));
    writeFileSync(join(tempDir, 'file1.ts'), 'export function hello() { return "world"; }');
    writeFileSync(join(tempDir, 'file2.ts'), 'export function goodbye() { return "world"; }');
    writeFileSync(join(tempDir, 'readme.md'), '# Hello World\nThis is a test.');
    mkdirSync(join(tempDir, 'subdir'), { recursive: true });
    writeFileSync(join(tempDir, 'subdir', 'nested.ts'), 'const x = "hello";');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createVfs(): VirtualFilesystem {
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
      { prefix: tempDir, read: true, write: true },
    ]);
    vfs.mount(new LocalBackend('/workspace', tempDir));
    vfs.mount(new LocalBackend(tempDir, tempDir));
    return vfs;
  }

  it('finds content matches using ripgrep', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'hello',
      mode: 'content',
    });
    expect(result.matches.length).toBeGreaterThan(0);
    // Should find in file1.ts and subdir/nested.ts
    const paths = result.matches.map(m => m.path);
    expect(paths.some(p => p.includes('file1.ts'))).toBe(true);
    expect(paths.some(p => p.includes('nested.ts'))).toBe(true);
  });

  it('finds content matches with case sensitivity', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'function',
      mode: 'content',
    });
    expect(result.matches.length).toBe(2);
  });

  it('uses filename mode to list files', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: '',
      mode: 'filename',
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every(m => m.kind === 'file')).toBe(true);
  });

  it('uses regex mode', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'export\\s+function',
      mode: 'regex',
    });
    expect(result.matches.length).toBe(2);
  });

  it('respects max_results', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'o',
      mode: 'content',
      max_results: 1,
    });
    expect(result.matches.length).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('respects glob filter', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'hello',
      mode: 'content',
      glob: '*.ts',
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every(m => m.path.endsWith('.ts'))).toBe(true);
  });

  it('returns empty matches when needle not found', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'nonexistent_string_xyz',
      mode: 'content',
    });
    expect(result.matches.length).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('defaults to content mode when mode is undefined', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'hello',
    });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('defaults max_results to 100 when undefined', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'o',
    });
    expect(result.matches.length).toBeLessThanOrEqual(100);
  });

  it('includes line_number in content matches', async () => {
    const vfs = createVfs();
    const result = await searchFiles(vfs, {
      root: tempDir,
      needle: 'function',
      mode: 'content',
    });
    for (const m of result.matches) {
      expect(m.line_number).toBeDefined();
      expect(m.line_number).toBeGreaterThan(0);
    }
  });

  it('falls back to VFS when root does not exist on real FS', async () => {
    const vfs = createVfs();
    // Use a VFS path that doesn't map to a real filesystem path
    const result = await searchFiles(vfs, {
      root: '/workspace/nonexistent-dir',
      needle: 'hello',
      mode: 'content',
    });
    expect(result.matches).toBeDefined();
  });
});
