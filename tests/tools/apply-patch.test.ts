import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { applyPatch, ApplyPatchError, type ApplyPatchInput } from '../../tools/apply-patch.js';

describe('AH-TOOL-APPLY-PATCH-001 apply_patch', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-'));
    vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('applies a single hunk to a file', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'line1\nline2\nline3');
    const input: ApplyPatchInput = {
      hunks: [{ file: '/workspace/f.txt', old_start: 2, old_lines: ['line2'], new_lines: ['LINE2'] }],
    };
    const result = await applyPatch(vfs, input);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.hunks_applied).toBe(1);
    expect(vfs.readText('/workspace/f.txt')).toBe('line1\nLINE2\nline3');
  });

  it('applies multiple hunks to the same file in reverse order', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'a\nb\nc\nd\ne');
    const input: ApplyPatchInput = {
      hunks: [
        { file: '/workspace/f.txt', old_start: 1, old_lines: ['a'], new_lines: ['A'] },
        { file: '/workspace/f.txt', old_start: 3, old_lines: ['c'], new_lines: ['C'] },
        { file: '/workspace/f.txt', old_start: 5, old_lines: ['e'], new_lines: ['E'] },
      ],
    };
    const result = await applyPatch(vfs, input);
    expect(result.applied[0]!.hunks_applied).toBe(3);
    expect(vfs.readText('/workspace/f.txt')).toBe('A\nb\nC\nd\nE');
  });

  it('applies hunks to multiple files', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'foo');
    writeFileSync(join(tmp, 'b.txt'), 'bar');
    const input: ApplyPatchInput = {
      hunks: [
        { file: '/workspace/a.txt', old_start: 1, old_lines: ['foo'], new_lines: ['FOO'] },
        { file: '/workspace/b.txt', old_start: 1, old_lines: ['bar'], new_lines: ['BAR'] },
      ],
    };
    const result = await applyPatch(vfs, input);
    expect(result.applied).toHaveLength(2);
    expect(vfs.readText('/workspace/a.txt')).toBe('FOO');
    expect(vfs.readText('/workspace/b.txt')).toBe('BAR');
  });

  it('throws on empty hunks array', async () => {
    await expect(applyPatch(vfs, { hunks: [] })).rejects.toThrow(ApplyPatchError);
  });

  it('throws on empty file name', async () => {
    await expect(applyPatch(vfs, {
      hunks: [{ file: '', old_start: 1, old_lines: ['x'], new_lines: ['y'] }],
    })).rejects.toThrow(ApplyPatchError);
  });

  it('throws on invalid old_start (zero)', async () => {
    await expect(applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 0, old_lines: ['x'], new_lines: ['y'] }],
    })).rejects.toThrow(ApplyPatchError);
  });

  it('throws on non-integer old_start', async () => {
    await expect(applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 1.5, old_lines: ['x'], new_lines: ['y'] }],
    })).rejects.toThrow(ApplyPatchError);
  });

  it('throws on hunk out of bounds', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'only one line');
    await expect(applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 5, old_lines: ['missing'], new_lines: ['new'] }],
    })).rejects.toThrow(ApplyPatchError);
  });

  it('throws on context mismatch', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'actual content');
    await expect(applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 1, old_lines: ['expected content'], new_lines: ['new'] }],
    })).rejects.toThrow('context mismatch');
  });

  it('reports bytes_changed correctly', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'short');
    const result = await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 1, old_lines: ['short'], new_lines: ['much longer line'] }],
    });
    expect(result.bytes_changed).toBeGreaterThan(0);
  });

  it('handles insertion (empty old_lines)', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'line1\nline3');
    const result = await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 2, old_lines: [], new_lines: ['line2'] }],
    });
    expect(result.applied[0]!.hunks_applied).toBe(1);
    expect(vfs.readText('/workspace/f.txt')).toBe('line1\nline2\nline3');
  });

  it('handles deletion (empty new_lines)', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'line1\nline2\nline3');
    const result = await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 2, old_lines: ['line2'], new_lines: [] }],
    });
    expect(result.applied[0]!.hunks_applied).toBe(1);
    expect(vfs.readText('/workspace/f.txt')).toBe('line1\nline3');
  });

  it('rejects non-array old_lines', async () => {
    await expect(applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 1, old_lines: 'not array' as unknown as string[], new_lines: [] }],
    })).rejects.toThrow(ApplyPatchError);
  });

  it('does not write when content unchanged', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'unchanged');
    const before = vfs.read('/workspace/f.txt');
    await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 1, old_lines: ['unchanged'], new_lines: ['unchanged'] }],
    });
    expect(vfs.read('/workspace/f.txt')).toEqual(before);
  });
});
