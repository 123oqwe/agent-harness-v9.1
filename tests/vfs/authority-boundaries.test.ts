import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type Backend,
  EvidenceBackend,
  LocalBackend,
  OverlayBackend,
  StoreBackend,
  VirtualFilesystem,
  VfsError,
  assertSafeVfsPath,
} from '../../vfs/virtual-filesystem.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const value = mkdtempSync(join(tmpdir(), 'ah-vfs-boundary-'));
  temporaryDirectories.push(value);
  return value;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('VFS authority input boundaries', () => {
  it('preserves typed error identity and rejects each unsafe path shape exactly', () => {
    const error = new VfsError('private-path');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(VfsError);
    expect(error).toMatchObject({ name: 'VfsError', message: 'private-path' });

    const cases: Array<[unknown, string]> = [
      [null, 'path required'],
      [undefined, 'path required'],
      [17, 'path required'],
      ['', 'path required'],
      ['workspace/file', 'path must be absolute within VFS: workspace/file'],
      [`/workspace/${String.fromCharCode(0)}secret`, 'null byte in path'],
      ['/../secret', 'traversal rejected: /../secret'],
      ['/workspace/../secret', 'traversal rejected: /workspace/../secret'],
      ['/workspace/..', 'traversal rejected: /workspace/..'],
    ];
    for (const [path, message] of cases) {
      expect(() => assertSafeVfsPath(path as string)).toThrow(
        expect.objectContaining({ name: 'VfsError', message }),
      );
    }
    expect(() => assertSafeVfsPath('/workspace/.hidden/valid')).not.toThrow();
    expect(() => assertSafeVfsPath('/workspace/file..name')).not.toThrow();
  });
});

describe('LocalBackend authority boundaries', () => {
  it('maps only its exact prefix and blocks existing and missing symlink escapes', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    mkdirSync(join(root, 'safe'));
    symlinkSync(outside, join(root, 'safe', 'escape'));
    const backend = new LocalBackend('/workspace', root);

    expect(backend).toMatchObject({
      kind: 'local',
      prefix: '/workspace',
      rootPath: root,
    });
    expect(() => backend.read('/workspace-other/secret.txt')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'escape from /workspace: /workspace-other/secret.txt',
      }),
    );
    expect(() => backend.read('/workspace/safe/escape/secret.txt')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: `symlink escape from ${root}: ${join(root, 'safe', 'escape', 'secret.txt')}`,
      }),
    );
    expect(() => backend.write('/workspace/safe/escape/new.txt', Buffer.from('no'))).toThrow(
      expect.objectContaining({ name: 'VfsError' }),
    );
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
    expect(backend.exists('/workspace/safe/escape/secret.txt')).toBe(false);
    expect(backend.exists('/workspace/missing.txt')).toBe(false);
    expect(backend.mode('/workspace/missing.txt')).toBeUndefined();
  });

  it('reads, lists, writes, chmods, and deletes with exact file metadata', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'a.txt'), 'alpha');
    mkdirSync(join(root, 'dir', 'nested'));
    const backend = new LocalBackend('/workspace', root);

    expect(backend.read('/workspace/dir/a.txt')).toEqual(Buffer.from('alpha'));
    expect(backend.list('/workspace/dir')).toEqual([
      { path: '/workspace/dir/a.txt', kind: 'file', size: 5 },
      { path: '/workspace/dir/nested', kind: 'dir', size: 0 },
    ]);
    backend.write('/workspace/new/sub/file.txt', Buffer.from('payload'), 0o700);
    expect(readFileSync(join(root, 'new', 'sub', 'file.txt'))).toEqual(
      Buffer.from('payload'),
    );
    expect(statSync(join(root, 'new', 'sub', 'file.txt')).mode & 0o777).toBe(0o700);
    expect(backend.mode('/workspace/new/sub/file.txt')).toBe(0o700);

    chmodSync(join(root, 'new', 'sub', 'file.txt'), 0o600);
    backend.write('/workspace/new/sub/file.txt', Buffer.from('next'));
    expect(backend.mode('/workspace/new/sub/file.txt')).toBe(0o600);
    backend.delete('/workspace/new');
    expect(backend.exists('/workspace/new/sub/file.txt')).toBe(false);
    expect(() => backend.delete('/workspace/new')).not.toThrow();
  });
});

describe('memory and evidence backend boundaries', () => {
  it('StoreBackend isolates buffers and lists only exact descendants', () => {
    const backend = new StoreBackend('/memories');
    const input = Buffer.from('one');
    backend.write('/memories/a/one', input);
    backend.write('/memories/ab/two', Buffer.from('22'));
    input.fill(0);

    const first = backend.read('/memories/a/one');
    expect(first).toEqual(Buffer.from('one'));
    first.fill(0);
    expect(backend.read('/memories/a/one')).toEqual(Buffer.from('one'));
    expect(backend.list('/memories/a')).toEqual([
      { path: '/memories/a/one', kind: 'file', size: 3 },
    ]);
    expect(backend.list('/')).toEqual([
      { path: '/memories/a/one', kind: 'file', size: 3 },
      { path: '/memories/ab/two', kind: 'file', size: 2 },
    ]);
    expect(backend.exists('/memories/a/one')).toBe(true);
    backend.delete('/memories/a/one');
    expect(backend.exists('/memories/a/one')).toBe(false);
    expect(() => backend.read('/memories/a/one')).toThrow(
      expect.objectContaining({ name: 'VfsError', message: 'not found' }),
    );
  });

  it('EvidenceBackend is defensive WORM storage with exact public failures', () => {
    const backend = new EvidenceBackend('/evidence');
    const input = Buffer.from('proof');
    backend.write('/evidence/run/one', input);
    backend.write('/evidence/run-two/other', Buffer.from('x'));
    input.fill(0);

    const first = backend.read('/evidence/run/one');
    expect(first).toEqual(Buffer.from('proof'));
    first.fill(0);
    expect(backend.read('/evidence/run/one')).toEqual(Buffer.from('proof'));
    expect(backend.list('/evidence/run')).toEqual([
      { path: '/evidence/run/one', kind: 'file', size: 5 },
    ]);
    expect(backend.list('/')).toEqual([
      { path: '/evidence/run/one', kind: 'file', size: 5 },
      { path: '/evidence/run-two/other', kind: 'file', size: 1 },
    ]);
    expect(backend.exists('/evidence/run/one')).toBe(true);
    expect(() => backend.write('/evidence/run/one', Buffer.from('replacement'))).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'evidence is WORM: /evidence/run/one already exists',
      }),
    );
    expect(() => backend.delete('/evidence/run/one')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'evidence backend is immutable',
      }),
    );
    expect(() => backend.read('/evidence/missing')).toThrow(
      expect.objectContaining({ name: 'VfsError', message: 'not found' }),
    );
  });
});

describe('VirtualFilesystem permission authority', () => {
  it('uses the most-specific permission regardless of rule insertion order', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private', 'secret.txt'), 'secret');
    for (const rules of [
      [
        { prefix: '/workspace', read: true, write: true },
        { prefix: '/workspace/private', read: false, write: false },
      ],
      [
        { prefix: '/workspace/private', read: false, write: false },
        { prefix: '/workspace', read: true, write: true },
      ],
    ]) {
      const vfs = new VirtualFilesystem(rules);
      vfs.mount(new LocalBackend('/workspace', root));
      expect(() => vfs.read('/workspace/private/secret.txt')).toThrow(
        expect.objectContaining({
          name: 'VfsError',
          message: 'permission denied: /workspace/private/secret.txt',
        }),
      );
    }

    for (const rules of [
      [
        { prefix: '/workspace', read: true, write: true },
        { prefix: '/workspace', read: false, write: false },
      ],
      [
        { prefix: '/workspace', read: false, write: false },
        { prefix: '/workspace', read: true, write: true },
      ],
    ]) {
      const vfs = new VirtualFilesystem(rules);
      vfs.mount(new LocalBackend('/workspace', root));
      expect(() => vfs.read('/workspace/private/secret.txt')).toThrow(
        expect.objectContaining({
          name: 'VfsError',
          message: 'permission denied: /workspace/private/secret.txt',
        }),
      );
    }
  });

  it('returns immutable receipt snapshots instead of its mutable authority log', () => {
    const backend = new StoreBackend('/memories');
    const vfs = new VirtualFilesystem([
      { prefix: '/memories', read: true, write: true },
    ]);
    vfs.mount(backend);
    vfs.writeText('/memories/item', 'value');
    const receipts = vfs.receipts();

    expect(Object.isFrozen(receipts)).toBe(true);
    expect(Object.isFrozen(receipts[0])).toBe(true);
    expect(receipts[0]).toMatchObject({
      path: '/memories/item',
      backend: 'store',
      operation: 'write',
      bytes: 5,
      sha256: 'cd42404d52ad55ccfa9aca4adc828aa5800ad9d385a0671fbcbf724118320619',
    });
    expect(receipts[0]!.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
    expect(() =>
      (receipts as unknown as Array<{ operation: string }>).push({
        operation: 'forged',
      }),
    ).toThrow(TypeError);
    expect(() => {
      (receipts[0] as { operation: string }).operation = 'forged';
    }).toThrow(TypeError);
    expect(vfs.receipts()).toHaveLength(1);
    expect(vfs.receipts()[0]!.operation).toBe('write');
  });

  it('mounts, routes, and forks exact prefix authorities without widening ACLs', () => {
    const root = temporaryDirectory();
    const workspace = new LocalBackend('/workspace', root);
    const nested = new StoreBackend('/workspace/cache');
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
      { prefix: '/workspace/private', read: true, write: false },
    ]);
    vfs.mount(workspace);
    vfs.mount(nested);

    expect(vfs.route('/workspace')).toBe(workspace);
    expect(vfs.route('/workspace/file')).toBe(workspace);
    expect(vfs.route('/workspace/cache/item')).toBe(nested);
    expect(() => vfs.route('/workspace-other')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'no backend for path: /workspace-other',
      }),
    );
    expect(() => vfs.mount(new StoreBackend('/workspace'))).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'duplicate mount: /workspace',
      }),
    );

    const replacement = new StoreBackend('/workspace');
    const fork = vfs.forkReplacing('/workspace', replacement);
    expect(fork.route('/workspace')).toBe(replacement);
    expect(fork.route('/workspace/cache/item')).toBe(nested);
    fork.writeText('/workspace/allowed', 'yes');
    expect(replacement.read('/workspace/allowed')).toEqual(Buffer.from('yes'));
    expect(() => fork.writeText('/workspace/private/blocked', 'no')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'permission denied: /workspace/private/blocked',
      }),
    );
    expect(() =>
      vfs.forkReplacing('/workspace', new StoreBackend('/different')),
    ).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'replacement prefix mismatch: /different != /workspace',
      }),
    );
    expect(() =>
      vfs.forkReplacing('/missing', new StoreBackend('/missing')),
    ).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'no backend mounted at /missing',
      }),
    );

    const rootBackend = new StoreBackend('/');
    const rootVfs = new VirtualFilesystem();
    rootVfs.mount(rootBackend);
    expect(rootVfs.route('/anything')).toBe(rootBackend);
    expect(() => rootVfs.read('/anything')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'permission denied: /anything',
      }),
    );
    rootVfs.addPermissionRule({ prefix: '/', read: true, write: false });
    rootBackend.write('/anything', Buffer.from('root'));
    expect(rootVfs.read('/anything')).toEqual(Buffer.from('root'));
  });

  it('records exact read, list, edit, delete, and search outcomes', () => {
    const backend = new StoreBackend('/memories');
    const vfs = new VirtualFilesystem([
      { prefix: '/memories', read: true, write: true },
    ]);
    vfs.mount(backend);
    vfs.write('/memories/a.txt', Buffer.from('alpha'));
    vfs.edit('/memories/a.txt', 'beta');
    expect(vfs.readText('/memories/a.txt')).toBe('beta');
    expect(vfs.list('/memories')).toEqual([
      { path: '/memories/a.txt', kind: 'file', size: 4 },
    ]);
    expect(vfs.search('/memories', 'ET')).toEqual([
      { path: '/memories/a.txt', kind: 'file', size: 4 },
    ]);
    vfs.delete('/memories/a.txt');
    expect(vfs.exists('/memories/a.txt')).toBe(false);

    expect(vfs.receipts().map(({ operation, path, backend: kind, bytes }) => ({
      operation,
      path,
      backend: kind,
      ...(bytes === undefined ? {} : { bytes }),
    }))).toEqual([
      { operation: 'write', path: '/memories/a.txt', backend: 'store', bytes: 5 },
      { operation: 'edit', path: '/memories/a.txt', backend: 'store', bytes: 4 },
      { operation: 'read', path: '/memories/a.txt', backend: 'store', bytes: 4 },
      { operation: 'list', path: '/memories', backend: 'store' },
      { operation: 'list', path: '/memories', backend: 'store' },
      { operation: 'read', path: '/memories/a.txt', backend: 'store', bytes: 4 },
      { operation: 'search', path: '/memories', backend: 'store' },
      { operation: 'delete', path: '/memories/a.txt', backend: 'store' },
    ]);

    const readOnly = new VirtualFilesystem([
      { prefix: '/memories', read: true, write: false },
    ]);
    readOnly.mount(backend);
    backend.write('/memories/readonly.txt', Buffer.from('read-only'));
    expect(readOnly.readText('/memories/readonly.txt')).toBe('read-only');
    expect(readOnly.list('/memories')).toEqual([
      { path: '/memories/readonly.txt', kind: 'file', size: 9 },
    ]);
    expect(readOnly.exists('/memories/readonly.txt')).toBe(true);
    expect(() => readOnly.delete('/memories/readonly.txt')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'permission denied: /memories/readonly.txt',
      }),
    );
  });

  it('searches nested directories and skips unreadable branches', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'allowed', 'nested'), { recursive: true });
    mkdirSync(join(root, 'denied'), { recursive: true });
    writeFileSync(join(root, 'allowed', 'nested', 'match.txt'), 'Needle');
    writeFileSync(join(root, 'allowed', 'other.txt'), 'other');
    writeFileSync(join(root, 'denied', 'secret.txt'), 'Needle secret');
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: false },
      { prefix: '/workspace/denied', read: false, write: false },
    ]);
    vfs.mount(new LocalBackend('/workspace', root));

    expect(vfs.search('/workspace', 'needle')).toEqual([
      {
        path: '/workspace/allowed/nested/match.txt',
        kind: 'file',
        size: 6,
      },
    ]);
    expect(vfs.receipts().at(-1)).toMatchObject({
      path: '/workspace',
      backend: 'local',
      operation: 'search',
    });
  });
});

describe('OverlayBackend authority state', () => {
  it('merges staged and base entries without duplicates or tombstoned paths', () => {
    const base = new StoreBackend('/workspace');
    base.write('/workspace/base.txt', Buffer.from('base'));
    base.write('/workspace/replace.txt', Buffer.from('old'));
    base.write('/workspace/deleted.txt', Buffer.from('delete'));
    const overlay = new OverlayBackend('/workspace');
    overlay.setBaseBackend(base);
    overlay.write('/workspace/replace.txt', Buffer.from('new'), 0o640);
    overlay.write('/workspace/staged.txt', Buffer.from('stage'));
    overlay.delete('/workspace/deleted.txt');

    expect(overlay).toMatchObject({ kind: 'overlay', prefix: '/workspace' });
    expect(overlay.read('/workspace/base.txt')).toEqual(Buffer.from('base'));
    expect(overlay.read('/workspace/replace.txt')).toEqual(Buffer.from('new'));
    expect(() => overlay.read('/workspace/deleted.txt')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'not found: /workspace/deleted.txt',
      }),
    );
    expect(overlay.list('/workspace')).toEqual([
      { path: '/workspace/replace.txt', kind: 'file', size: 3 },
      { path: '/workspace/staged.txt', kind: 'file', size: 5 },
      { path: '/workspace/base.txt', kind: 'file', size: 4 },
    ]);
    expect(overlay.exists('/workspace/base.txt')).toBe(true);
    expect(overlay.exists('/workspace/replace.txt')).toBe(true);
    expect(overlay.exists('/workspace/deleted.txt')).toBe(false);
    expect(overlay.exists('/workspace/missing.txt')).toBe(false);
    expect(overlay.stagedEntries()).toEqual([
      ['/workspace/replace.txt', Buffer.from('new'), 0o640],
      ['/workspace/staged.txt', Buffer.from('stage')],
    ]);
    expect(overlay.stagedTombstones()).toEqual(['/workspace/deleted.txt']);
  });

  it('tracks mode replacement and exact terminal state failures', () => {
    const overlay = new OverlayBackend('/workspace');
    expect(() => overlay.read('/workspace/missing')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'not found: /workspace/missing',
      }),
    );
    expect(overlay.list('/workspace')).toEqual([]);
    expect(overlay.exists('/workspace/missing')).toBe(false);
    overlay.write('/workspace/file', Buffer.from('first'), 0o755);
    const listing = new OverlayBackend('/workspace');
    listing.write('/workspace/file', Buffer.from('first'));
    listing.write('/workspace-only', Buffer.from('outside'));
    expect(listing.list('/workspace')).toEqual([
      { path: '/workspace/file', kind: 'file', size: 5 },
    ]);
    expect(listing.list('/')).toEqual([
      { path: '/workspace/file', kind: 'file', size: 5 },
      { path: '/workspace-only', kind: 'file', size: 7 },
    ]);
    expect(listing.exists('/workspace-only')).toBe(true);
    overlay.write('/workspace/file', Buffer.from('second'));
    expect(overlay.stagedEntries()).toEqual([
      ['/workspace/file', Buffer.from('second')],
    ]);
    overlay.delete('/workspace/file');
    expect(overlay.stagedEntries()).toEqual([]);
    expect(overlay.stagedTombstones()).toEqual(['/workspace/file']);
    overlay.write('/workspace/file', Buffer.from('third'), 0o600);
    expect(overlay.stagedTombstones()).toEqual([]);
    expect(overlay.stagedEntries()).toEqual([
      ['/workspace/file', Buffer.from('third'), 0o600],
    ]);

    overlay.markCommitted();
    expect(overlay.isCommitted()).toBe(true);
    expect(overlay.isDiscarded()).toBe(false);
    expect(() => overlay.write('/workspace/late', Buffer.from('no'))).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay already committed',
      }),
    );

    const discarded = new OverlayBackend('/workspace');
    discarded.markDiscarded();
    expect(discarded.isCommitted()).toBe(false);
    expect(discarded.isDiscarded()).toBe(true);
    expect(() => discarded.delete('/workspace/late')).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay already discarded',
      }),
    );
  });
});

describe('VirtualFilesystem overlay commit authority', () => {
  it('commits exact bytes, modes, deletes, and receipts once', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'existing.txt'), 'before');
    chmodSync(join(root, 'existing.txt'), 0o600);
    writeFileSync(join(root, 'deleted.txt'), 'delete-me');
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]);
    vfs.mount(new LocalBackend('/workspace', root));
    const overlay = new OverlayBackend('/workspace');
    overlay.write('/workspace/existing.txt', Buffer.from('after'), 0o700);
    overlay.write('/workspace/new.txt', Buffer.from('new'), 0o640);
    overlay.delete('/workspace/deleted.txt');

    vfs.commitOverlay(overlay);

    expect(overlay.isCommitted()).toBe(true);
    expect(overlay.isDiscarded()).toBe(false);
    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('after');
    expect(statSync(join(root, 'existing.txt')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('new');
    expect(statSync(join(root, 'new.txt')).mode & 0o777).toBe(0o640);
    expect(() => readFileSync(join(root, 'deleted.txt'))).toThrow();
    expect(vfs.receipts().map(({ timestamp, ...receipt }) => receipt)).toEqual([
      {
        path: '/workspace/existing.txt',
        backend: 'local',
        operation: 'commit',
        bytes: 5,
        sha256: createHash('sha256').update('after').digest('hex'),
      },
      {
        path: '/workspace/new.txt',
        backend: 'local',
        operation: 'commit',
        bytes: 3,
        sha256: createHash('sha256').update('new').digest('hex'),
      },
      {
        path: '/workspace/deleted.txt',
        backend: 'local',
        operation: 'commit',
      },
    ]);
    expect(vfs.receipts().every(({ timestamp }) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp),
    )).toBe(true);
    expect(() => vfs.commitOverlay(overlay)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay already finalized',
      }),
    );
    expect(() => vfs.discardOverlay(overlay)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay already finalized',
      }),
    );
  });

  it('discards a fresh overlay once with an exact immutable receipt', () => {
    const vfs = new VirtualFilesystem();
    const overlay = new OverlayBackend('/workspace');
    vfs.discardOverlay(overlay);
    expect(overlay.isCommitted()).toBe(false);
    expect(overlay.isDiscarded()).toBe(true);
    expect(vfs.receipts().map(({ timestamp, ...receipt }) => receipt)).toEqual([
      { path: '/workspace', backend: 'overlay', operation: 'discard' },
    ]);
    expect(() => vfs.discardOverlay(overlay)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay already finalized',
      }),
    );
  });

  it('rolls back every effect, emits no false commit receipt, and finalizes a failed overlay', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'existing.txt'), 'before');
    writeFileSync(join(root, 'deleted.txt'), 'delete-me');
    const base = new LocalBackend('/workspace', root);
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]);
    vfs.mount(base);
    const overlay = new OverlayBackend('/workspace');
    overlay.write('/workspace/existing.txt', Buffer.from('after'), 0o700);
    overlay.write('/workspace/new.txt', Buffer.from('new'), 0o640);
    overlay.delete('/workspace/deleted.txt');
    let failDelete = true;
    const target: Backend = {
      kind: 'local',
      prefix: '/workspace',
      read: (path) => base.read(path),
      list: (path) => base.list(path),
      write: (path, data, mode) => base.write(path, data, mode),
      delete: (path) => {
        if (failDelete) {
          failDelete = false;
          throw new Error('delete failed');
        }
        base.delete(path);
      },
      exists: (path) => base.exists(path),
      mode: (path) => base.mode(path),
    };

    expect(() => vfs.commitOverlay(overlay, target)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay commit failed, rolled back 2 writes: delete failed',
      }),
    );
    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('before');
    expect(statSync(join(root, 'existing.txt')).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(root, 'deleted.txt'), 'utf8')).toBe('delete-me');
    expect(() => readFileSync(join(root, 'new.txt'))).toThrow();
    expect(overlay.isCommitted()).toBe(false);
    expect(overlay.isDiscarded()).toBe(true);
    expect(() => overlay.write('/workspace/retry.txt', Buffer.from('no'))).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay already discarded',
      }),
    );
    expect(vfs.receipts().map(({ path, backend, operation }) => ({
      path,
      backend,
      operation,
    }))).toEqual([
      { path: '/workspace', backend: 'local', operation: 'discard' },
    ]);
  });

  it('denies commit with read-only authority before any target effect', () => {
    const target = new StoreBackend('/workspace');
    target.write('/workspace/existing.txt', Buffer.from('before'));
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: false },
    ]);
    vfs.mount(target);
    const overlay = new OverlayBackend('/workspace');
    overlay.write('/workspace/existing.txt', Buffer.from('after'));

    expect(() => vfs.commitOverlay(overlay)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay commit failed, rolled back 0 writes: permission denied: /workspace/existing.txt',
      }),
    );
    expect(target.read('/workspace/existing.txt')).toEqual(Buffer.from('before'));
    expect(overlay.isDiscarded()).toBe(true);
    expect(vfs.receipts().map(({ path, backend, operation }) => ({
      path,
      backend,
      operation,
    }))).toEqual([
      { path: '/workspace', backend: 'store', operation: 'discard' },
    ]);
  });

  it('restores an earlier deletion when a later deletion fails', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'first.txt'), 'first');
    chmodSync(join(root, 'first.txt'), 0o600);
    writeFileSync(join(root, 'second.txt'), 'second');
    const base = new LocalBackend('/workspace', root);
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]);
    vfs.mount(base);
    const overlay = new OverlayBackend('/workspace');
    overlay.delete('/workspace/first.txt');
    overlay.delete('/workspace/second.txt');
    let deletes = 0;
    const target: Backend = {
      kind: 'local',
      prefix: '/workspace',
      read: (path) => base.read(path),
      list: (path) => base.list(path),
      write: (path, data, mode) => base.write(path, data, mode),
      delete: (path) => {
        deletes += 1;
        if (deletes === 2) throw new Error('second delete failed');
        base.delete(path);
      },
      exists: (path) => base.exists(path),
      mode: (path) => base.mode(path),
    };

    expect(() => vfs.commitOverlay(overlay, target)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay commit failed, rolled back 0 writes: second delete failed',
      }),
    );
    expect(readFileSync(join(root, 'first.txt'), 'utf8')).toBe('first');
    expect(statSync(join(root, 'first.txt')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, 'second.txt'), 'utf8')).toBe('second');
    expect(overlay.isDiscarded()).toBe(true);
  });

  it('restores an existing file through a target without a mode port', () => {
    const target = new StoreBackend('/workspace');
    target.write('/workspace/existing.txt', Buffer.from('before'));
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]);
    vfs.mount(target);
    const overlay = new OverlayBackend('/workspace');
    overlay.write('/workspace/existing.txt', Buffer.from('after'));
    const failing: Backend = {
      kind: 'store',
      prefix: '/workspace',
      read: (path) => target.read(path),
      list: (path) => target.list(path),
      write: (path, data) => {
        if (data.equals(Buffer.from('after'))) throw new Error('write failed');
        target.write(path, data);
      },
      delete: (path) => target.delete(path),
      exists: (path) => target.exists(path),
    };

    expect(() => vfs.commitOverlay(overlay, failing)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'overlay commit failed, rolled back 0 writes: write failed',
      }),
    );
    expect(target.read('/workspace/existing.txt')).toEqual(Buffer.from('before'));
  });
});
