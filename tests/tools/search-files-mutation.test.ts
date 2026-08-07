import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { searchFiles } from '../../tools/search-files.js';

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedExistsSync = vi.mocked(existsSync);

function makeRgJsonMatch(filePath: string, lineNum: number): string {
  return JSON.stringify({
    type: 'match',
    data: { path: { text: filePath }, line_number: lineNum },
  });
}

describe('searchFiles ripgrep mutation coverage', () => {
  let tmp: string;
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sf-mut-'));
    vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    mockedSpawnSync.mockReset();
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(true);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -- ripgrep success with content mode --

  it('parses rg JSON output in content mode and returns matches with line numbers', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: makeRgJsonMatch('/real/path/a.ts', 5) + '\n' + makeRgJsonMatch('/real/path/b.ts', 10),
      stderr: '',
      error: undefined,
    } as any);
    const result = await searchFiles(vfs, { root: '/real/path', needle: 'hello', mode: 'content' });
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]!.line_number).toBe(5);
    expect(result.matches[1]!.line_number).toBe(10);
    expect(result.matches[0]!.path).toBe('/real/path/a.ts');
    // Verify rg args
    const args = mockedSpawnSync.mock.calls[0]![1] as string[];
    expect(args).toContain('--json');
    expect(args).toContain('--line-number');
    expect(args).toContain('-F');
    expect(args).toContain('hello');
  });

  it('uses -e flag for regex mode', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0, stdout: makeRgJsonMatch('/p/a', 1), stderr: '', error: undefined,
    } as any);
    await searchFiles(vfs, { root: '/real', needle: '\\d+', mode: 'regex' });
    const args = mockedSpawnSync.mock.calls[0]![1] as string[];
    expect(args).toContain('-e');
    expect(args).toContain('\\d+');
    expect(args).not.toContain('-F');
  });

  it('uses --files flag for filename mode and parses one path per line', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '/real/file1.ts\n/real/file2.ts\n',
      stderr: '',
      error: undefined,
    } as any);
    const result = await searchFiles(vfs, { root: '/real', needle: '', mode: 'filename' });
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]!.path).toBe('/real/file1.ts');
    expect(result.matches[1]!.path).toBe('/real/file2.ts');
    expect(result.matches.every(m => m.kind === 'file')).toBe(true);
    const args = mockedSpawnSync.mock.calls[0]![1] as string[];
    expect(args).toContain('--files');
    expect(args).not.toContain('--line-number');
  });

  it('passes glob filter to rg', async () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: undefined } as any);
    await searchFiles(vfs, { root: '/real', needle: 'x', glob: '*.ts' });
    const args = mockedSpawnSync.mock.calls[0]![1] as string[];
    expect(args).toContain('--glob');
    expect(args).toContain('*.ts');
  });

  it('passes max-count to rg', async () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: undefined } as any);
    await searchFiles(vfs, { root: '/real', needle: 'x', max_results: 42 });
    const args = mockedSpawnSync.mock.calls[0]![1] as string[];
    expect(args).toContain('--max-count');
    expect(args).toContain('42');
  });

  it('uses shell:false in spawnSync options', async () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: undefined } as any);
    await searchFiles(vfs, { root: '/real', needle: 'x' });
    const opts = mockedSpawnSync.mock.calls[0]![2] as any;
    expect(opts.shell).toBe(false);
    expect(opts.encoding).toBe('utf8');
    expect(opts.timeout).toBe(30_000);
  });

  // -- ripgrep error handling --

  it('falls back to VFS when rg returns status 127 (not found)', async () => {
    mockedSpawnSync.mockReturnValue({ status: 127, stdout: '', stderr: '', error: undefined } as any);
    writeFileSync(join(tmp, 'a.txt'), 'findme here');
    const result = await searchFiles(vfs, { root: '/workspace', needle: 'findme' });
    // Should fall back to VFS search
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]!.path).toContain('a.txt');
  });

  it('falls back to VFS when rg returns status null (signal)', async () => {
    mockedSpawnSync.mockReturnValue({ status: null, stdout: '', stderr: '', error: undefined } as any);
    writeFileSync(join(tmp, 'b.txt'), 'findme here');
    const result = await searchFiles(vfs, { root: '/workspace', needle: 'findme' });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('falls back to VFS when rg throws an error', async () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: new Error('ENOENT') } as any);
    writeFileSync(join(tmp, 'c.txt'), 'findme here');
    const result = await searchFiles(vfs, { root: '/workspace', needle: 'findme' });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('falls back to VFS when rg returns status 2 (error)', async () => {
    mockedSpawnSync.mockReturnValue({ status: 2, stdout: '', stderr: 'error', error: undefined } as any);
    writeFileSync(join(tmp, 'd.txt'), 'findme here');
    const result = await searchFiles(vfs, { root: '/workspace', needle: 'findme' });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('does NOT fall back when rg returns status 1 (no matches)', async () => {
    mockedSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '', error: undefined } as any);
    const result = await searchFiles(vfs, { root: '/real', needle: 'nothing' });
    // status 1 means rg ran successfully but found no matches
    expect(result.matches).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  // -- existsSync checks --

  it('falls back to VFS when root does not exist on real filesystem', async () => {
    mockedExistsSync.mockReturnValue(false);
    writeFileSync(join(tmp, 'e.txt'), 'findme here');
    const result = await searchFiles(vfs, { root: '/workspace', needle: 'findme' });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('falls back to VFS when existsSync throws', async () => {
    mockedExistsSync.mockImplementation(() => { throw new Error('permission denied'); });
    writeFileSync(join(tmp, 'f.txt'), 'findme here');
    const result = await searchFiles(vfs, { root: '/workspace', needle: 'findme' });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  // -- JSON parsing --

  it('skips non-JSON lines in rg output', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'not json\n' + makeRgJsonMatch('/p/a', 3) + '\n{bad json}\n',
      stderr: '',
      error: undefined,
    } as any);
    const result = await searchFiles(vfs, { root: '/real', needle: 'x' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.line_number).toBe(3);
  });

  it('skips non-match JSON entries in rg output', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ type: 'summary', data: {} }) + '\n' + makeRgJsonMatch('/p/a', 1) + '\n',
      stderr: '',
      error: undefined,
    } as any);
    const result = await searchFiles(vfs, { root: '/real', needle: 'x' });
    expect(result.matches).toHaveLength(1);
  });

  it('handles Buffer stdout from spawnSync', async () => {
    const jsonStr = makeRgJsonMatch('/p/a', 7);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(jsonStr + '\n'),
      stderr: '',
      error: undefined,
    } as any);
    const result = await searchFiles(vfs, { root: '/real', needle: 'x' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.line_number).toBe(7);
  });

  // -- truncation --

  it('truncates results when rg returns more than max_results', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) lines.push(makeRgJsonMatch(`/p/file${i}.ts`, i + 1));
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: lines.join('\n'), stderr: '', error: undefined } as any);
    const result = await searchFiles(vfs, { root: '/real', needle: 'x', max_results: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('does not truncate when matches exactly equal max_results', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: makeRgJsonMatch('/p/a', 1) + '\n' + makeRgJsonMatch('/p/b', 2),
      stderr: '',
      error: undefined,
    } as any);
    const result = await searchFiles(vfs, { root: '/real', needle: 'x', max_results: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  // -- filename mode with max_results --

  it('limits filename mode results to max_results', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '/p/a\n/p/b\n/p/c\n/p/d\n/p/e\n',
      stderr: '',
      error: undefined,
    } as any);
    const result = await searchFiles(vfs, { root: '/real', needle: '', mode: 'filename', max_results: 3 });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(false); // filename mode slices inside tryRipgrep
  });

  // -- spawnSync catch block --

  it('falls back to VFS when spawnSync throws', async () => {
    mockedSpawnSync.mockImplementation(() => { throw new Error('spawn failed'); });
    writeFileSync(join(tmp, 'g.txt'), 'findme here');
    const result = await searchFiles(vfs, { root: '/workspace', needle: 'findme' });
    expect(result.matches.length).toBeGreaterThan(0);
  });
});
