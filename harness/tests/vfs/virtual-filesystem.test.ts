import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFilesystem, type VfsPermission } from '../../vfs/virtual-filesystem.js';

describe('AH-VFS-001: path normalization', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    vfs = new VirtualFilesystem({ root: '/workspace' });
  });

  it('normalizes relative paths to workspace root', () => {
    const p = vfs.normalizePath('src/index.ts');
    expect(p).toBe('/workspace/src/index.ts');
  });

  it('normalizes paths with leading slash relative to root', () => {
    const p = vfs.normalizePath('/src/index.ts');
    expect(p).toBe('/workspace/src/index.ts');
  });

  it('rejects path traversal with ..', () => {
    expect(() => vfs.normalizePath('../../../etc/passwd')).toThrow(/traversal|escape|\.\./i);
  });

  it('rejects paths that traverse outside root', () => {
    // An absolute path is reinterpreted as workspace-relative by design.
    // But path traversal with .. must be rejected.
    expect(() => vfs.normalizePath('src/../../../etc/passwd')).toThrow(/traversal|escape|\.\./i);
  });

  it('rejects NUL bytes in path', () => {
    expect(() => vfs.normalizePath('file\0name')).toThrow(/nul|invalid|null/i);
  });

  it('rejects empty path', () => {
    expect(() => vfs.normalizePath('')).toThrow(/empty/i);
  });

  it('handles nested directories correctly', () => {
    const p = vfs.normalizePath('a/b/c/d.txt');
    expect(p).toBe('/workspace/a/b/c/d.txt');
  });

  it('normalizes paths with redundant separators', () => {
    const p = vfs.normalizePath('src//index.ts');
    expect(p).toBe('/workspace/src/index.ts');
  });

  it('rejects paths that escape root via .. after normalization', () => {
    expect(() => vfs.normalizePath('src/../../../etc/passwd')).toThrow(/traversal|escape|\.\./i);
  });
});

describe('AH-VFS-001: overlay read/write', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    vfs = new VirtualFilesystem({ root: '/workspace' });
  });

  it('writes and reads a file in overlay', () => {
    vfs.write('/scratch/test.txt', 'hello world');
    expect(vfs.read('/scratch/test.txt')).toBe('hello world');
  });

  it('reads return null for non-existent file', () => {
    expect(vfs.read('/scratch/nonexistent.txt')).toBeNull();
  });

  it('overwrites existing file in overlay', () => {
    vfs.write('/scratch/test.txt', 'first');
    vfs.write('/scratch/test.txt', 'second');
    expect(vfs.read('/scratch/test.txt')).toBe('second');
  });

  it('can write to nested paths', () => {
    vfs.write('/scratch/a/b/c.txt', 'nested');
    expect(vfs.read('/scratch/a/b/c.txt')).toBe('nested');
  });

  it('can delete a file', () => {
    vfs.write('/scratch/test.txt', 'hello');
    vfs.delete('/scratch/test.txt');
    expect(vfs.read('/scratch/test.txt')).toBeNull();
  });

  it('can list directory contents', () => {
    vfs.write('/scratch/a.txt', 'a');
    vfs.write('/scratch/b.txt', 'b');
    vfs.write('/scratch/sub/c.txt', 'c');
    const entries = vfs.list('/scratch/');
    expect(entries).toContain('/workspace/scratch/a.txt');
    expect(entries).toContain('/workspace/scratch/b.txt');
    expect(entries).toContain('/workspace/scratch/sub/c.txt');
  });

  it('list returns empty array for non-existent directory', () => {
    expect(vfs.list('/scratch/nonexistent/')).toEqual([]);
  });
});

describe('AH-VFS-001: diff and checkpoint', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    vfs = new VirtualFilesystem({ root: '/workspace' });
  });

  it('diff shows changed files', () => {
    vfs.write('/scratch/a.txt', 'new a');
    vfs.write('/scratch/b.txt', 'new b');
    const diff = vfs.diff();
    expect(diff.changed).toContain('/workspace/scratch/a.txt');
    expect(diff.changed).toContain('/workspace/scratch/b.txt');
  });

  it('diff shows deleted files', () => {
    vfs.write('/scratch/a.txt', 'original');
    vfs.checkpoint('cp1');
    vfs.delete('/scratch/a.txt');
    const diff = vfs.diff();
    expect(diff.deleted).toContain('/workspace/scratch/a.txt');
  });

  it('checkpoint captures current overlay state', () => {
    vfs.write('/scratch/a.txt', 'v1');
    const cp = vfs.checkpoint('cp1');
    expect(cp.id).toBe('cp1');
    expect(cp.files.size).toBe(1);
  });

  it('can restore to a checkpoint', () => {
    vfs.write('/scratch/a.txt', 'v1');
    vfs.checkpoint('cp1');
    vfs.write('/scratch/a.txt', 'v2');
    vfs.write('/scratch/b.txt', 'new');
    vfs.restore('cp1');
    expect(vfs.read('/scratch/a.txt')).toBe('v1');
    expect(vfs.read('/scratch/b.txt')).toBeNull();
  });
});

describe('AH-VFS-001: commit and discard', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    vfs = new VirtualFilesystem({ root: '/workspace' });
  });

  it('commit moves overlay changes to committed store', () => {
    vfs.write('/scratch/a.txt', 'committed');
    vfs.write('/scratch/b.txt', 'committed');
    const result = vfs.commit();
    expect(result.committed).toBe(2);
    // After commit, overlay is cleared
    const diff = vfs.diff();
    expect(diff.changed.length).toBe(0);
  });

  it('discard removes all overlay changes', () => {
    vfs.write('/scratch/a.txt', 'temp');
    vfs.write('/scratch/b.txt', 'temp');
    vfs.discard();
    const diff = vfs.diff();
    expect(diff.changed.length).toBe(0);
    expect(vfs.read('/scratch/a.txt')).toBeNull();
  });

  it('commit with empty overlay is a no-op', () => {
    const result = vfs.commit();
    expect(result.committed).toBe(0);
  });

  it('committed files are readable after commit', () => {
    vfs.write('/scratch/a.txt', 'persisted');
    vfs.commit();
    expect(vfs.read('/scratch/a.txt')).toBe('persisted');
  });

  it('discard does not affect committed files', () => {
    vfs.write('/scratch/a.txt', 'committed');
    vfs.commit();
    vfs.write('/scratch/b.txt', 'temp');
    vfs.discard();
    expect(vfs.read('/scratch/a.txt')).toBe('committed');
    expect(vfs.read('/scratch/b.txt')).toBeNull();
  });
});

describe('AH-VFS-001: conflict detection', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    vfs = new VirtualFilesystem({ root: '/workspace' });
  });

  it('detects conflict when writing with stale expected version', () => {
    vfs.write('/scratch/a.txt', 'v1');
    const version1 = vfs.getVersion('/scratch/a.txt');
    vfs.write('/scratch/a.txt', 'v2');
    const version2 = vfs.getVersion('/scratch/a.txt');
    expect(version1).not.toBe(version2);
    expect(() => vfs.write('/scratch/a.txt', 'v3', { expectedVersion: version1 })).toThrow(/conflict|stale|mismatch/i);
  });

  it('write succeeds with correct expected version', () => {
    vfs.write('/scratch/a.txt', 'v1');
    const version = vfs.getVersion('/scratch/a.txt');
    expect(() => vfs.write('/scratch/a.txt', 'v2', { expectedVersion: version })).not.toThrow();
    expect(vfs.read('/scratch/a.txt')).toBe('v2');
  });

  it('write without expectedVersion always succeeds (no optimistic lock)', () => {
    vfs.write('/scratch/a.txt', 'v1');
    vfs.write('/scratch/a.txt', 'v2');
    expect(vfs.read('/scratch/a.txt')).toBe('v2');
  });
});

describe('AH-VFS-001: permission enforcement', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    const permissions: VfsPermission[] = [
      { path_prefix: '/workspace/allowed/', read: true, write: true },
      { path_prefix: '/workspace/readonly/', read: true, write: false },
      { path_prefix: '/workspace/denied/', read: false, write: false },
    ];
    vfs = new VirtualFilesystem({ root: '/workspace', permissions });
  });

  it('allows read and write in allowed path', () => {
    expect(() => vfs.write('/allowed/test.txt', 'ok')).not.toThrow();
    expect(vfs.read('/allowed/test.txt')).toBe('ok');
  });

  it('allows read but denies write in readonly path', () => {
    // With permissions enforced, write to readonly path should be denied
    expect(() => vfs.write('/readonly/test.txt', 'denied')).toThrow(/permission|denied|write/i);
  });

  it('denies both read and write in denied path', () => {
    expect(() => vfs.read('/denied/test.txt')).toThrow(/permission|denied|read/i);
    expect(() => vfs.write('/denied/test.txt', 'denied')).toThrow(/permission|denied|write/i);
  });

  it('denies access to paths without matching permission rule (default deny)', () => {
    expect(() => vfs.read('/unknown/test.txt')).toThrow(/permission|denied|no.*rule/i);
    expect(() => vfs.write('/unknown/test.txt', 'test')).toThrow(/permission|denied|no.*rule/i);
  });
});

describe('AH-VFS-001: symlink escape prevention', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    vfs = new VirtualFilesystem({ root: '/workspace' });
  });

  it('rejects paths containing symlink-like patterns', () => {
    // VFS is in-memory, so symlinks don't apply directly.
    // But we test that the normalizer rejects suspicious patterns.
    expect(() => vfs.normalizePath('link/../../../etc/shadow')).toThrow(/traversal|escape|\.\./i);
  });
});
