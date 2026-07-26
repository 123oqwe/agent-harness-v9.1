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
    await expect(
      editFile(vfs, {
        path: '/workspace/f.txt',
        find: 'xyz',
        replace: 'q',
      }),
    ).rejects.toThrow(
      'edit_file: pattern not found in /workspace/f.txt',
    );
    expect(vfs.readText('/workspace/f.txt')).toBe('hello');
  });

  it('rejects an empty find string before writing', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello');
    await expect(
      editFile(vfs, {
        path: '/workspace/f.txt',
        find: '',
        replace: 'x',
      }),
    ).rejects.toThrow('edit_file: find must not be empty');
    expect(vfs.readText('/workspace/f.txt')).toBe('hello');
  });

  it('rejects a whitespace-only fallback with the exact path', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello');
    await expect(
      editFile(vfs, {
        path: '/workspace/f.txt',
        find: '   ',
        replace: 'x',
      }),
    ).rejects.toThrow(
      'edit_file: pattern not found in /workspace/f.txt',
    );
    expect(vfs.readText('/workspace/f.txt')).toBe('hello');
  });

  it('rejects exact and whitespace-fallback no-op replacements', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'value\n');
    await expect(
      editFile(vfs, {
        path: '/workspace/f.txt',
        find: 'value',
        replace: 'value',
      }),
    ).rejects.toThrow('replacement must change');
    await expect(
      editFile(vfs, {
        path: '/workspace/f.txt',
        find: '  value ',
        replace: ' value  ',
      }),
    ).rejects.toThrow('replacement must change');
    expect(vfs.readText('/workspace/f.txt')).toBe('value\n');
  });

  it('uses a unique whitespace-trimmed fallback for model-proposed snippets', async () => {
    writeFileSync(
      join(tmp, 'f.txt'),
      'export function add(a, b) { return a - b; }\n',
    );
    const result = await editFile(vfs, {
      path: '/workspace/f.txt',
      find: '  return a - b;  ',
      replace: '  return a + b;  ',
    });
    expect(result.replacements).toBe(1);
    expect(vfs.readText('/workspace/f.txt')).toBe(
      'export function add(a, b) { return a + b; }\n',
    );
  });

  it('fails closed when the whitespace-trimmed fallback is ambiguous', async () => {
    writeFileSync(
      join(tmp, 'f.txt'),
      'return a - b;\nreturn a - b;\n',
    );
    await expect(
      editFile(vfs, {
        path: '/workspace/f.txt',
        find: '  return a - b;  ',
        replace: 'return a + b;',
      }),
    ).rejects.toThrow('ambiguous');
    expect(vfs.readText('/workspace/f.txt')).toContain('a - b');
  });
});
