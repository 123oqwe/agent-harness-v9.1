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

  // -- Error message content (kills StringLiteral mutants) --

  it('throws with specific message for empty hunks', async () => {
    try {
      await applyPatch(vfs, { hunks: [] });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApplyPatchError);
      expect((e as Error).message).toBe('apply_patch requires at least one hunk');
    }
  });

  it('throws with specific message for undefined hunks', async () => {
    try {
      await applyPatch(vfs, { hunks: undefined as unknown as ApplyPatchInput['hunks'] });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApplyPatchError);
      expect((e as Error).message).toBe('apply_patch requires at least one hunk');
    }
  });

  it('throws with specific message for empty file name', async () => {
    try {
      await applyPatch(vfs, {
        hunks: [{ file: '', old_start: 1, old_lines: ['x'], new_lines: ['y'] }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApplyPatchError);
      expect((e as Error).message).toBe('hunk.file is required');
    }
  });

  it('throws with specific message for non-array new_lines', async () => {
    try {
      await applyPatch(vfs, {
        hunks: [{ file: '/workspace/f.txt', old_start: 1, old_lines: ['x'], new_lines: 'not array' as unknown as string[] }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApplyPatchError);
      expect((e as Error).message).toBe('hunk old_lines and new_lines must be arrays');
    }
  });

  it('throws with specific message for non-integer old_start including value in message', async () => {
    try {
      await applyPatch(vfs, {
        hunks: [{ file: '/workspace/f.txt', old_start: 2.5, old_lines: ['x'], new_lines: ['y'] }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApplyPatchError);
      expect((e as Error).message).toBe('hunk old_start must be a positive integer: 2.5');
    }
  });

  it('throws with specific message for negative old_start including value in message', async () => {
    try {
      await applyPatch(vfs, {
        hunks: [{ file: '/workspace/f.txt', old_start: -1, old_lines: ['x'], new_lines: ['y'] }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApplyPatchError);
      expect((e as Error).message).toBe('hunk old_start must be a positive integer: -1');
    }
  });

  // -- Out of bounds checks --

  it('throws with out of bounds message including all parameters', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'line1\nline2');
    try {
      await applyPatch(vfs, {
        hunks: [{ file: '/workspace/f.txt', old_start: 5, old_lines: ['missing'], new_lines: ['new'] }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApplyPatchError);
      expect((e as Error).message).toContain('hunk range out of bounds');
      expect((e as Error).message).toContain('start=5');
      expect((e as Error).message).toContain('old_lines=1');
      expect((e as Error).message).toContain('file_lines=2');
    }
  });

  it('throws out of bounds when old_lines extend beyond file end', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'only\nthree\nlines');
    await expect(applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 2, old_lines: ['three', 'lines', 'extra'], new_lines: ['x'] }],
    })).rejects.toThrow('out of bounds');
  });

  // -- Context mismatch message --

  it('throws context mismatch with line number and expected/got values', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'actual content');
    try {
      await applyPatch(vfs, {
        hunks: [{ file: '/workspace/f.txt', old_start: 1, old_lines: ['expected'], new_lines: ['new'] }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApplyPatchError);
      expect((e as Error).message).toContain('context mismatch');
      expect((e as Error).message).toContain('/workspace/f.txt');
      expect((e as Error).message).toContain('line 1');
      expect((e as Error).message).toContain('"expected"');
      expect((e as Error).message).toContain('"actual content"');
    }
  });

  it('throws context mismatch at correct line number (not just line 1)', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'a\nb\nwrong');
    try {
      await applyPatch(vfs, {
        hunks: [{ file: '/workspace/f.txt', old_start: 3, old_lines: ['expected'], new_lines: ['new'] }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('line 3');
    }
  });

  // -- Sort order verification --

  it('sorts hunks by old_start descending (bottom to top)', async () => {
    writeFileSync(join(tmp, 'f.txt'), '1\n2\n3\n4\n5\n6\n7\n8\n9');
    // Pass hunks in ascending order — should still apply correctly
    const result = await applyPatch(vfs, {
      hunks: [
        { file: '/workspace/f.txt', old_start: 3, old_lines: ['3'], new_lines: ['C'] },
        { file: '/workspace/f.txt', old_start: 6, old_lines: ['6'], new_lines: ['F'] },
        { file: '/workspace/f.txt', old_start: 9, old_lines: ['9'], new_lines: ['I'] },
      ],
    });
    expect(result.applied[0]!.hunks_applied).toBe(3);
    expect(vfs.readText('/workspace/f.txt')).toBe('1\n2\nC\n4\n5\nF\n7\n8\nI');
  });

  it('handles mixed sort order hunks correctly', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'a\nb\nc\nd\ne');
    const result = await applyPatch(vfs, {
      hunks: [
        { file: '/workspace/f.txt', old_start: 4, old_lines: ['d'], new_lines: ['D'] },
        { file: '/workspace/f.txt', old_start: 2, old_lines: ['b'], new_lines: ['B'] },
        { file: '/workspace/f.txt', old_start: 5, old_lines: ['e'], new_lines: ['E'] },
        { file: '/workspace/f.txt', old_start: 1, old_lines: ['a'], new_lines: ['A'] },
        { file: '/workspace/f.txt', old_start: 3, old_lines: ['c'], new_lines: ['C'] },
      ],
    });
    expect(result.applied[0]!.hunks_applied).toBe(5);
    expect(vfs.readText('/workspace/f.txt')).toBe('A\nB\nC\nD\nE');
  });

  // -- bytes_changed calculation --

  it('calculates bytes_changed correctly for shorter replacement', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'longer line');
    const result = await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 1, old_lines: ['longer line'], new_lines: ['short'] }],
    });
    const expected = Math.abs(Buffer.byteLength('short') - Buffer.byteLength('longer line'));
    expect(result.bytes_changed).toBe(expected);
  });

  it('calculates bytes_changed for zero-byte change (same length)', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'abcd');
    const result = await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 1, old_lines: ['abcd'], new_lines: ['wxyz'] }],
    });
    expect(result.bytes_changed).toBe(0);
  });

  it('accumulates bytes_changed across multiple hunks', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'aaaa\nbbbb');
    const result = await applyPatch(vfs, {
      hunks: [
        { file: '/workspace/f.txt', old_start: 1, old_lines: ['aaaa'], new_lines: ['aa'] },
        { file: '/workspace/f.txt', old_start: 2, old_lines: ['bbbb'], new_lines: ['bbbbbb'] },
      ],
    });
    const expected = Math.abs(2 - 4) + Math.abs(6 - 4);
    expect(result.bytes_changed).toBe(expected);
  });

  it('accumulates bytes_changed across multiple files', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'foo');
    writeFileSync(join(tmp, 'b.txt'), 'barbar');
    const result = await applyPatch(vfs, {
      hunks: [
        { file: '/workspace/a.txt', old_start: 1, old_lines: ['foo'], new_lines: ['foobar'] },
        { file: '/workspace/b.txt', old_start: 1, old_lines: ['barbar'], new_lines: ['bar'] },
      ],
    });
    const expected = Math.abs(6 - 3) + Math.abs(3 - 6);
    expect(result.bytes_changed).toBe(expected);
  });

  // -- Insertion and deletion edge cases --

  it('inserts multiple lines at once', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'a\nc');
    const result = await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 2, old_lines: [], new_lines: ['b1', 'b2', 'b3'] }],
    });
    expect(result.applied[0]!.hunks_applied).toBe(1);
    expect(vfs.readText('/workspace/f.txt')).toBe('a\nb1\nb2\nb3\nc');
  });

  it('deletes multiple lines at once', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'a\nb\nc\nd\ne');
    const result = await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 2, old_lines: ['b', 'c', 'd'], new_lines: [] }],
    });
    expect(result.applied[0]!.hunks_applied).toBe(1);
    expect(vfs.readText('/workspace/f.txt')).toBe('a\ne');
  });

  it('replaces multiple lines with different count', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'a\nb\nc\nd\ne');
    const result = await applyPatch(vfs, {
      hunks: [{ file: '/workspace/f.txt', old_start: 2, old_lines: ['b', 'c', 'd'], new_lines: ['X', 'Y'] }],
    });
    expect(result.applied[0]!.hunks_applied).toBe(1);
    expect(vfs.readText('/workspace/f.txt')).toBe('a\nX\nY\ne');
  });

  // -- hunks_applied count --

  it('reports correct hunks_applied count per file', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'x\ny\nz');
    writeFileSync(join(tmp, 'b.txt'), '1\n2\n3');
    const result = await applyPatch(vfs, {
      hunks: [
        { file: '/workspace/a.txt', old_start: 1, old_lines: ['x'], new_lines: ['X'] },
        { file: '/workspace/a.txt', old_start: 3, old_lines: ['z'], new_lines: ['Z'] },
        { file: '/workspace/b.txt', old_start: 2, old_lines: ['2'], new_lines: ['TWO'] },
      ],
    });
    const aResult = result.applied.find(a => a.file === '/workspace/a.txt');
    const bResult = result.applied.find(a => a.file === '/workspace/b.txt');
    expect(aResult?.hunks_applied).toBe(2);
    expect(bResult?.hunks_applied).toBe(1);
  });
});
