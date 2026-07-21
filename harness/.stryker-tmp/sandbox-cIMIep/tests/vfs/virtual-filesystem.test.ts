// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VirtualFilesystem, LocalBackend, OverlayBackend, StoreBackend, EvidenceBackend,
  VfsError, assertSafeVfsPath,
} from '../../vfs/virtual-filesystem.js';

describe('AH-VFS-001 Virtual Filesystem', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vfs-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  function setup() {
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
      { prefix: '/scratch', read: true, write: true },
      { prefix: '/memories', read: true, write: true },
      { prefix: '/evidence', read: true, write: false },
    ]);
    vfs.mount(new LocalBackend('/workspace', root));
    vfs.mount(new OverlayBackend('/scratch'));
    vfs.mount(new StoreBackend('/memories'));
    vfs.mount(new EvidenceBackend('/evidence'));
    return vfs;
  }

  describe('assertSafeVfsPath', () => {
    it('rejects relative paths', () => { expect(() => assertSafeVfsPath('a/b')).toThrow(VfsError); });
    it('rejects traversal', () => { expect(() => assertSafeVfsPath('/workspace/../etc')).toThrow(VfsError); });
    it('rejects null bytes', () => { expect(() => assertSafeVfsPath('/workspace/\0x')).toThrow(VfsError); });
    it('accepts clean absolute paths', () => { expect(() => assertSafeVfsPath('/workspace/a.ts')).not.toThrow(); });
  });

  describe('backend routing', () => {
    it('routes /workspace to LocalBackend', () => {
      const vfs = setup();
      writeFileSync(join(root, 'a.txt'), 'hello');
      expect(vfs.readText('/workspace/a.txt')).toBe('hello');
      expect(vfs.receipts().at(-1)!.backend).toBe('local');
    });
    it('routes /memories to StoreBackend', () => {
      const vfs = setup();
      vfs.writeText('/memories/note', 'm1');
      expect(vfs.readText('/memories/note')).toBe('m1');
      expect(vfs.receipts().at(-1)!.backend).toBe('store');
    });
    it('rejects unknown prefix', () => {
      const vfs = setup();
      expect(() => vfs.read('/unknown/x')).toThrow(VfsError);
    });
    it('longest prefix wins', () => {
      const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }, { prefix: '/workspace/protected', read: false, write: false }]);
      vfs.mount(new LocalBackend('/workspace', root));
      vfs.mount(new StoreBackend('/workspace/protected'));
      writeFileSync(join(root, 'ok.txt'), 'ok');
      expect(vfs.readText('/workspace/ok.txt')).toBe('ok');
      expect(() => vfs.read('/workspace/protected/secret')).toThrow(VfsError);
    });
  });

  describe('deny-by-default permissions', () => {
    it('denies a path with no rule (deny-by-default)', () => {
      const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
      vfs.mount(new LocalBackend('/workspace', root));
      // /memories has no permission rule and no backend -> denied before routing
      expect(() => vfs.read('/memories/x')).toThrow(/permission denied/);
    });
    it('enforces read-only on /evidence', () => {
      const vfs = setup();
      // evidence write rule is write:false at the VFS layer; the backend is also WORM
      expect(() => vfs.write('/evidence/a', 'x')).toThrow(/permission denied/);
    });
  });

  describe('path traversal & symlink escape', () => {
    it('rejects traversal via assertSafeVfsPath on every routed access', () => {
      const vfs = setup();
      expect(() => vfs.read('/workspace/../etc/passwd')).toThrow(VfsError);
    });
    it('blocks symlink escape outside root', () => {
      const vfs = setup();
      mkdirSync(join(root, 'sub'), { recursive: true });
      symlinkSync(tmpdir(), join(root, 'sub', 'escape')); // points outside root
      expect(() => vfs.read('/workspace/sub/escape')).toThrow(VfsError);
    });
  });

  describe('OverlayBackend transactional commit/discard', () => {
    it('stages writes then commits atomically to LocalBackend', () => {
      const overlay = new OverlayBackend('/scratch');
      const vfs = new VirtualFilesystem([
        { prefix: '/scratch', read: true, write: true },
        { prefix: '/memories', read: true, write: true },
      ]);
      vfs.mount(overlay);
      overlay.write('/scratch/f1', Buffer.from('one'));
      overlay.write('/scratch/f2', Buffer.from('two'));
      // not yet in workspace-backed store; overlay read works
      expect(overlay.read('/scratch/f1').toString()).toBe('one');
      const target = new StoreBackend('/memories');
      vfs.mount(target);
      // commit into a store target via VFS commit (write to /memories requires permission)
      vfs.commitOverlay(overlay, target);
      expect(overlay.isCommitted()).toBe(true);
      expect(target.read('/scratch/f1').toString()).toBe('one');
    });
    it('discards partial edits so nothing reaches the target', () => {
      const overlay = new OverlayBackend('/scratch');
      const vfs = new VirtualFilesystem([
        { prefix: '/scratch', read: true, write: true },
        { prefix: '/memories', read: true, write: true },
      ]);
      vfs.mount(overlay);
      overlay.write('/scratch/bad', Buffer.from('nope'));
      const target = new StoreBackend('/memories');
      vfs.mount(target);
      vfs.discardOverlay(overlay);
      expect(overlay.isDiscarded()).toBe(true);
      expect(() => overlay.write('/scratch/x', Buffer.from('x'))).toThrow(VfsError);
      expect(target.exists('/scratch/bad')).toBe(false);
    });
    it('cannot commit a finalized overlay', () => {
      const overlay = new OverlayBackend('/scratch');
      const vfs = new VirtualFilesystem([{ prefix: '/scratch', read: true, write: true }, { prefix: '/memories', read: true, write: true }]);
      vfs.mount(overlay);
      overlay.write('/scratch/a', Buffer.from('a'));
      vfs.discardOverlay(overlay);
      expect(() => vfs.commitOverlay(overlay, new StoreBackend('/memories'))).toThrow(VfsError);
    });
  });

  describe('EvidenceBackend WORM', () => {
    it('write-once: second write throws', () => {
      const ev = new EvidenceBackend('/evidence');
      ev.write('/evidence/1', Buffer.from('a'));
      expect(() => ev.write('/evidence/1', Buffer.from('b'))).toThrow(VfsError);
    });
    it('delete is forbidden', () => {
      const ev = new EvidenceBackend('/evidence');
      expect(() => ev.delete('/evidence/1')).toThrow(VfsError);
    });
  });

  describe('list / search / receipts', () => {
    it('list returns entries under a prefix', () => {
      const vfs = setup();
      mkdirSync(join(root, 'd'), { recursive: true });
      writeFileSync(join(root, 'd', 'a.txt'), 'alpha');
      writeFileSync(join(root, 'd', 'b.txt'), 'beta');
      const entries = vfs.list('/workspace/d').map(e => e.path);
      expect(entries).toContain('/workspace/d/a.txt');
      expect(entries).toContain('/workspace/d/b.txt');
    });
    it('search finds files containing the needle', () => {
      const vfs = setup();
      mkdirSync(join(root, 's'), { recursive: true });
      writeFileSync(join(root, 's', 'a.txt'), 'find me HERE');
      writeFileSync(join(root, 's', 'b.txt'), 'nothing');
      const hits = vfs.search('/workspace/s', 'here').map(e => e.path);
      expect(hits).toEqual(['/workspace/s/a.txt']);
    });
    it('every operation produces a receipt with sha256 for reads/writes', () => {
      const vfs = setup();
      vfs.writeText('/memories/x', 'data');
      const r = vfs.receipts().at(-1)!;
      expect(r.operation).toBe('write');
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      vfs.read('/memories/x');
      expect(vfs.receipts().at(-1)!.operation).toBe('read');
    });
  });

  describe('cross-backend aliasing', () => {
    it('a deny on /workspace/protected blocks read even though /workspace is allowed', () => {
      const vfs = new VirtualFilesystem([
        { prefix: '/workspace', read: true, write: true },
        { prefix: '/workspace/secret', read: false, write: false },
      ]);
      vfs.mount(new LocalBackend('/workspace', root));
      vfs.mount(new StoreBackend('/workspace/secret'));
      mkdirSync(join(root, 'secret'), { recursive: true });
      writeFileSync(join(root, 'secret', 'k'), 'v');
      expect(() => vfs.read('/workspace/secret/k')).toThrow(VfsError);
    });
  });
});

describe('VFS backend direct coverage', () => {
  it('StoreBackend list/read/delete/exists', () => {
    const sb = new StoreBackend('/memories');
    sb.write('/memories/a', Buffer.from('x'));
    sb.write('/memories/b', Buffer.from('y'));
    expect(sb.list('/memories').length).toBe(2);
    expect(sb.read('/memories/a').toString()).toBe('x');
    expect(sb.exists('/memories/a')).toBe(true);
    sb.delete('/memories/a');
    expect(sb.exists('/memories/a')).toBe(false);
    expect(() => sb.read('/memories/missing')).toThrow();
    // root path list
    expect(sb.list('/').length).toBe(1);
  });

  it('EvidenceBackend list/read/exists + WORM delete throws', () => {
    const eb = new EvidenceBackend('/evidence');
    eb.write('/evidence/1', Buffer.from('a'));
    expect(eb.list('/evidence').length).toBe(1);
    expect(eb.read('/evidence/1').toString()).toBe('a');
    expect(eb.exists('/evidence/1')).toBe(true);
    expect(() => eb.delete('/evidence/1')).toThrow();
    expect(() => eb.read('/evidence/missing')).toThrow();
  });

  it('OverlayBackend list/read/delete/exists/tombstones', () => {
    const ov = new OverlayBackend('/scratch');
    ov.write('/scratch/a', Buffer.from('1'));
    ov.write('/scratch/b', Buffer.from('2'));
    expect(ov.list('/scratch').length).toBe(2);
    expect(ov.read('/scratch/a').toString()).toBe('1');
    ov.delete('/scratch/a');
    expect(ov.exists('/scratch/a')).toBe(false);
    expect(() => ov.read('/scratch/a')).toThrow();
    expect(ov.stagedTombstones()).toContain('/scratch/a');
    expect(ov.stagedEntries().length).toBe(1);
    ov.markDiscarded();
    expect(ov.isDiscarded()).toBe(true);
    expect(() => ov.write('/scratch/c', Buffer.from('3'))).toThrow();
  });

  it('OverlayBackend markCommitted blocks further writes', () => {
    const ov = new OverlayBackend('/scratch');
    ov.write('/scratch/a', Buffer.from('1'));
    ov.markCommitted();
    expect(ov.isCommitted()).toBe(true);
    expect(() => ov.write('/scratch/b', Buffer.from('2'))).toThrow();
  });

  it('VFS exists returns false for denied path', () => {
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }, { prefix: '/workspace/secret', read: false, write: false }]);
    vfs.mount(new LocalBackend('/workspace', mkdtempSync(join(tmpdir(), 'vfsex-'))));
    expect(vfs.exists('/workspace/secret/x')).toBe(false);
  });

  it('VFS delete removes a file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vfsdel-'));
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    writeFileSync(join(tmp, 'del.txt'), 'x');
    vfs.delete('/workspace/del.txt');
    expect(vfs.exists('/workspace/del.txt')).toBe(false);
  });
});
