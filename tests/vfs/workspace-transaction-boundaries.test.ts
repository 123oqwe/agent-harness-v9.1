import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalBackend,
  OverlayBackend,
  StoreBackend,
  VirtualFilesystem,
  VfsError,
} from '../../vfs/virtual-filesystem.js';
import { WorkspaceTransaction } from '../../vfs/workspace-transaction.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = 'ah-workspace-boundary-'): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(value);
  return value;
}

function baseVfs(root: string): VirtualFilesystem {
  const vfs = new VirtualFilesystem([
    { prefix: '/workspace', read: true, write: true },
  ]);
  vfs.mount(new LocalBackend('/workspace', root));
  return vfs;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('WorkspaceTransaction construction boundaries', () => {
  it('rejects empty identity and a state root equal to the workspace', () => {
    const root = temporaryDirectory();
    expect(() => WorkspaceTransaction.open({
      runId: '   ',
      baseRoot: root,
    })).toThrow(
      expect.objectContaining({ name: 'VfsError', message: 'runId required' }),
    );
    expect(() => WorkspaceTransaction.open({
      runId: 'run-equal',
      baseRoot: root,
      stateRoot: root,
    })).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'stateRoot cannot be the workspace root',
      }),
    );
  });

  it('copies files, directories, symlinks, and protected dependency roots exactly', () => {
    const root = temporaryDirectory();
    const stateRoot = temporaryDirectory();
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'script.sh'), '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(join(root, 'nested', 'node_modules'));
    writeFileSync(join(root, 'nested', 'node_modules', 'marker'), 'nested');
    symlinkSync('nested/script.sh', join(root, 'script-link'));
    for (const name of ['.git', 'node_modules', '.pnpm-store']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'marker'), name);
    }

    const transaction = WorkspaceTransaction.open({
      runId: 'run-copy',
      baseRoot: root,
      stateRoot,
    });
    const realRoot = realpathSync(root);
    const realStateRoot = realpathSync(stateRoot);

    expect(transaction.resumed).toBe(false);
    expect(readFileSync(join(transaction.workspaceRoot, 'nested', 'script.sh'), 'utf8'))
      .toBe('#!/bin/sh\n');
    expect(statSync(join(transaction.workspaceRoot, 'nested', 'script.sh')).mode & 0o777)
      .toBe(0o755);
    expect(lstatSync(join(transaction.workspaceRoot, 'script-link')).isSymbolicLink())
      .toBe(true);
    expect(readlinkSync(join(transaction.workspaceRoot, 'script-link')))
      .toBe('nested/script.sh');
    for (const name of ['.git', 'node_modules', '.pnpm-store']) {
      const staged = join(transaction.workspaceRoot, name);
      expect(lstatSync(staged).isSymbolicLink()).toBe(true);
      expect(readlinkSync(staged)).toBe(join(realRoot, name));
    }

    const transactionRoot = join(
      realStateRoot,
      'workspace-transactions',
      createHash('sha256').update('run-copy').digest('hex').slice(0, 24),
    );
    expect(statSync(transactionRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(transactionRoot, 'metadata.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(transactionRoot, 'metadata.json'), 'utf8')))
      .toEqual({
        version: 1,
        run_id: 'run-copy',
        base_root: realRoot,
        initial: {
          'nested/script.sh': {
            kind: 'file',
            sha256: createHash('sha256').update('#!/bin/sh\n').digest('hex'),
            mode: 0o755,
          },
          'nested/node_modules/marker': {
            kind: 'file',
            sha256: createHash('sha256').update('nested').digest('hex'),
            mode: 0o644,
          },
          'script-link': { kind: 'symlink', target: 'nested/script.sh' },
        },
        protected_links: {
          '.git': join(realRoot, '.git'),
          '.pnpm-store': join(realRoot, '.pnpm-store'),
          node_modules: join(realRoot, 'node_modules'),
        },
        excluded_base_paths: [],
      });
    const resumed = WorkspaceTransaction.open({
      runId: 'run-copy',
      baseRoot: root,
      stateRoot,
    });
    expect(resumed.resumed).toBe(true);
    resumed.discard();
  });

  it('rebuilds a partial transaction and resumes a valid durable transaction', () => {
    const root = temporaryDirectory();
    const stateRoot = temporaryDirectory();
    writeFileSync(join(root, 'file.txt'), 'base');
    const digest = createHash('sha256')
      .update('run-rebuild')
      .digest('hex')
      .slice(0, 24);
    const container = join(stateRoot, 'workspace-transactions', digest);
    mkdirSync(join(container, 'workspace'), { recursive: true });
    writeFileSync(join(container, 'workspace', 'partial.txt'), 'partial');

    const rebuilt = WorkspaceTransaction.open({
      runId: 'run-rebuild',
      baseRoot: root,
      stateRoot,
    });
    expect(rebuilt.resumed).toBe(false);
    expect(existsSync(join(rebuilt.workspaceRoot, 'partial.txt'))).toBe(false);
    expect(readFileSync(join(rebuilt.workspaceRoot, 'file.txt'), 'utf8')).toBe('base');
    writeFileSync(join(rebuilt.workspaceRoot, 'file.txt'), 'staged');

    const resumed = WorkspaceTransaction.open({
      runId: 'run-rebuild',
      baseRoot: root,
      stateRoot,
    });
    expect(resumed.resumed).toBe(true);
    expect(readFileSync(join(resumed.workspaceRoot, 'file.txt'), 'utf8')).toBe('staged');
    resumed.discard();
  });

  it('rejects malformed durable metadata before trusting resumed state', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'file.txt'), 'base');
    symlinkSync('file.txt', join(root, 'file-link'));
    mkdirSync(join(root, '.git'));
    const validHash = createHash('sha256').update('base').digest('hex');
    const descendant = join(realpathSync(root), 'state-child');
    const corruptions: ReadonlyArray<{
      name: string;
      metadata?: (metadata: Record<string, unknown>) => unknown;
      workspace?: (workspaceRoot: string) => void;
      raw?: string;
    }> = [
      { name: 'invalid JSON', raw: '{' },
      { name: 'non-record root', raw: 'null' },
      { name: 'version', metadata: (value) => ({ ...value, version: 2 }) },
      { name: 'run ID', metadata: (value) => ({ ...value, run_id: 'other-run' }) },
      { name: 'base root', metadata: (value) => ({ ...value, base_root: '/wrong' }) },
      { name: 'initial collection', metadata: (value) => ({ ...value, initial: null }) },
      {
        name: 'protected collection',
        metadata: (value) => ({ ...value, protected_links: null }),
      },
      {
        name: 'excluded collection',
        metadata: (value) => ({ ...value, excluded_base_paths: null }),
      },
      {
        name: 'empty manifest path',
        metadata: (value) => ({ ...value, initial: { '': value.initial } }),
      },
      {
        name: 'absolute manifest path',
        metadata: (value) => ({
          ...value,
          initial: { '/absolute': { kind: 'file', sha256: validHash, mode: 0o644 } },
        }),
      },
      {
        name: 'NUL manifest path',
        metadata: (value) => ({
          ...value,
          initial: { 'bad\0path': { kind: 'file', sha256: validHash, mode: 0o644 } },
        }),
      },
      {
        name: 'traversing manifest path',
        metadata: (value) => ({
          ...value,
          initial: { '../escape': { kind: 'file', sha256: validHash, mode: 0o644 } },
        }),
      },
      {
        name: 'non-record manifest entry',
        metadata: (value) => ({ ...value, initial: { 'file.txt': null } }),
      },
      {
        name: 'unknown manifest kind',
        metadata: (value) => ({
          ...value,
          initial: { 'file.txt': { kind: 'directory' } },
        }),
      },
      {
        name: 'non-string file hash',
        metadata: (value) => ({
          ...value,
          initial: { 'file.txt': { kind: 'file', sha256: 1, mode: 0o644 } },
        }),
      },
      ...[
        validHash.slice(1),
        `${validHash}0`,
        validHash.toUpperCase(),
        `g${validHash.slice(1)}`,
      ].map((sha256) => ({
        name: `invalid file hash ${sha256.length}`,
        metadata: (value: Record<string, unknown>) => ({
          ...value,
          initial: { 'file.txt': { kind: 'file', sha256, mode: 0o644 } },
        }),
      })),
      ...[1.5, -1, 0o1000].map((mode) => ({
        name: `invalid file mode ${mode}`,
        metadata: (value: Record<string, unknown>) => ({
          ...value,
          initial: { 'file.txt': { kind: 'file', sha256: validHash, mode } },
        }),
      })),
      {
        name: 'non-string symlink target',
        metadata: (value) => ({
          ...value,
          initial: { 'file-link': { kind: 'symlink', target: 1 } },
        }),
      },
      {
        name: 'missing workspace',
        workspace: (workspaceRoot) => rmSync(workspaceRoot, {
          recursive: true,
          force: true,
        }),
      },
      {
        name: 'symlink workspace',
        workspace: (workspaceRoot) => {
          rmSync(workspaceRoot, { recursive: true, force: true });
          symlinkSync(root, workspaceRoot);
        },
      },
      {
        name: 'file workspace',
        workspace: (workspaceRoot) => {
          rmSync(workspaceRoot, { recursive: true, force: true });
          writeFileSync(workspaceRoot, 'not a directory');
        },
      },
      {
        name: 'unprotected link entry',
        metadata: (value) => ({
          ...value,
          protected_links: { source: join(realpathSync(root), 'source') },
        }),
      },
      {
        name: 'wrong protected link target',
        metadata: (value) => ({
          ...value,
          protected_links: { '.git': join(realpathSync(root), 'wrong') },
        }),
      },
      {
        name: 'non-string excluded path',
        metadata: (value) => ({ ...value, excluded_base_paths: [null] }),
      },
      {
        name: 'relative excluded path',
        metadata: (value) => ({ ...value, excluded_base_paths: ['relative'] }),
      },
      {
        name: 'base excluded path',
        metadata: (value) => ({
          ...value,
          excluded_base_paths: [realpathSync(root)],
        }),
      },
      {
        name: 'parent excluded path',
        metadata: (value) => ({
          ...value,
          excluded_base_paths: [realpathSync(join(root, '..'))],
        }),
      },
      {
        name: 'duplicate excluded path',
        metadata: (value) => ({
          ...value,
          excluded_base_paths: [descendant, descendant],
        }),
      },
    ];

    for (const [index, corruption] of corruptions.entries()) {
      const stateRoot = temporaryDirectory(`ah-workspace-state-${index}-`);
      const runId = `run-corrupt-${index}`;
      const transaction = WorkspaceTransaction.open({
        runId,
        baseRoot: root,
        stateRoot,
      });
      const metadataPath = join(transaction.workspaceRoot, '..', 'metadata.json');
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<
        string,
        unknown
      >;
      if (corruption.workspace !== undefined) {
        corruption.workspace(transaction.workspaceRoot);
      }
      writeFileSync(
        metadataPath,
        corruption.raw ??
          JSON.stringify(corruption.metadata?.(metadata) ?? metadata),
        'utf8',
      );
      expect(() => WorkspaceTransaction.open({
        runId,
        baseRoot: root,
        stateRoot,
      }), corruption.name).toThrow(
        expect.objectContaining({
          name: 'VfsError',
          message: 'workspace transaction metadata mismatch',
        }),
      );
    }
  });

  it('records an in-workspace state directory as an excluded durable path', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'file.txt'), 'base');
    const stateRoot = join(root, '.harness-state');
    const transaction = WorkspaceTransaction.open({
      runId: 'run-excluded-metadata',
      baseRoot: root,
      stateRoot,
    });
    const metadata = JSON.parse(
      readFileSync(join(transaction.workspaceRoot, '..', 'metadata.json'), 'utf8'),
    ) as { excluded_base_paths: string[] };
    expect(metadata.excluded_base_paths).toEqual([realpathSync(stateRoot)]);
    expect(existsSync(join(transaction.workspaceRoot, '.harness-state'))).toBe(false);
    const resumed = WorkspaceTransaction.open({
      runId: 'run-excluded-metadata',
      baseRoot: root,
      stateRoot,
    });
    expect(resumed.resumed).toBe(true);
    resumed.discard();
  });

  it('creates an identifiable ephemeral container when no state root is supplied', () => {
    const root = temporaryDirectory();
    const transaction = WorkspaceTransaction.open({
      runId: 'run-ephemeral-name',
      baseRoot: root,
    });
    expect(basename(join(transaction.workspaceRoot, '..'))).toMatch(
      /^ah-workspace-tx-/u,
    );
    transaction.discard();
  });
});

describe('WorkspaceTransaction authority bindings', () => {
  it('rejects mismatched VFS and sandbox roots and preserves allowed reads', () => {
    const root = temporaryDirectory();
    const other = temporaryDirectory();
    const transaction = WorkspaceTransaction.open({
      runId: 'run-bindings',
      baseRoot: root,
    });

    const nonLocal = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]);
    nonLocal.mount(new StoreBackend('/workspace'));
    expect(() => transaction.createVfs(nonLocal)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'VFS and sandbox workspace roots do not match',
      }),
    );
    expect(() => transaction.createVfs(baseVfs(other))).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'VFS and sandbox workspace roots do not match',
      }),
    );
    expect(() => transaction.sandboxProfile({
      workspaceRoot: other,
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: [],
    })).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'sandbox and VFS workspace roots do not match',
      }),
    );

    const profile = {
      workspaceRoot: root,
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: [root, '/usr/lib'],
    };
    expect(transaction.sandboxProfile(profile)).toEqual({
      ...profile,
      workspaceRoot: transaction.workspaceRoot,
      allowRead: [root, '/usr/lib', realpathSync(root)],
    });
    expect(profile).toEqual({
      workspaceRoot: root,
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: [root, '/usr/lib'],
    });
    transaction.discard();
  });

  it('maps only existing paths inside the VFS or base workspace', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    mkdirSync(join(root, 'nested'));
    const transaction = WorkspaceTransaction.open({
      runId: 'run-map',
      baseRoot: root,
    });

    expect(transaction.mapCwd('/workspace')).toBe(transaction.workspaceRoot);
    expect(transaction.mapCwd('/workspace/nested'))
      .toBe(join(transaction.workspaceRoot, 'nested'));
    expect(transaction.mapCwd(root)).toBe(transaction.workspaceRoot);
    expect(transaction.mapCwd(join(root, 'nested')))
      .toBe(join(transaction.workspaceRoot, 'nested'));
    expect(transaction.mapCwd('nested'))
      .toBe(join(transaction.workspaceRoot, 'nested'));
    expect(() => transaction.mapCwd('/workspace/../escape')).toThrow(
      expect.objectContaining({ name: 'VfsError' }),
    );
    expect(() => transaction.mapCwd(outside)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: `path outside workspace transaction: ${realpathSync(outside)}`,
      }),
    );
    expect(() => transaction.mapCwd(join(root, '..'))).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: `path outside workspace transaction: ${realpathSync(join(root, '..'))}`,
      }),
    );
    transaction.discard();
  });
});

describe('WorkspaceTransaction change authority', () => {
  it('captures only changed files and represents deletions as tombstones', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'unchanged.txt'), 'same', { mode: 0o640 });
    writeFileSync(join(root, 'deleted.txt'), 'remove');
    const transaction = WorkspaceTransaction.open({
      runId: 'run-capture-diff',
      baseRoot: root,
    });
    rmSync(join(transaction.workspaceRoot, 'deleted.txt'));
    writeFileSync(join(transaction.workspaceRoot, 'created.txt'), 'create', {
      mode: 0o600,
    });
    const overlay = new OverlayBackend('/workspace');

    transaction.capture(overlay);

    expect(overlay.stagedEntries()).toEqual([
      ['/workspace/created.txt', Buffer.from('create'), 0o600],
    ]);
    expect(overlay.stagedTombstones()).toEqual(['/workspace/deleted.txt']);
    expect(overlay.stagedEntries().some(([path]) =>
      path === '/workspace/unchanged.txt')).toBe(false);
    transaction.discard();
  });

  it('describes created, deleted, content, mode, and symlink changes exactly', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'deleted.txt'), 'deleted', { mode: 0o600 });
    writeFileSync(join(root, 'modified.txt'), 'before', { mode: 0o640 });
    writeFileSync(join(root, 'mode.txt'), 'same', { mode: 0o600 });
    symlinkSync('modified.txt', join(root, 'link'));
    const transaction = WorkspaceTransaction.open({
      runId: 'run-describe-all',
      baseRoot: root,
    });
    rmSync(join(transaction.workspaceRoot, 'deleted.txt'));
    writeFileSync(join(transaction.workspaceRoot, 'modified.txt'), 'after');
    chmodSync(join(transaction.workspaceRoot, 'modified.txt'), 0o644);
    chmodSync(join(transaction.workspaceRoot, 'mode.txt'), 0o700);
    writeFileSync(join(transaction.workspaceRoot, 'created.txt'), 'created', {
      mode: 0o640,
    });
    rmSync(join(transaction.workspaceRoot, 'link'));
    symlinkSync('mode.txt', join(transaction.workspaceRoot, 'link'));

    const changes = transaction.describeChanges();
    expect(changes.map(({ path, kind, before_mode, after_mode }) => ({
      path,
      kind,
      before_mode,
      after_mode,
    }))).toEqual([
      {
        path: '/workspace/created.txt',
        kind: 'created',
        before_mode: null,
        after_mode: 0o640,
      },
      {
        path: '/workspace/deleted.txt',
        kind: 'deleted',
        before_mode: 0o600,
        after_mode: null,
      },
      {
        path: '/workspace/link',
        kind: 'modified',
        before_mode: null,
        after_mode: null,
      },
      {
        path: '/workspace/mode.txt',
        kind: 'modified',
        before_mode: 0o600,
        after_mode: 0o700,
      },
      {
        path: '/workspace/modified.txt',
        kind: 'modified',
        before_mode: 0o640,
        after_mode: 0o644,
      },
    ]);
    expect(changes.find(({ path }) => path.endsWith('created.txt'))).toMatchObject({
      before_sha256: null,
      after_sha256: createHash('sha256').update('created').digest('hex'),
    });
    expect(changes.find(({ path }) => path.endsWith('deleted.txt'))).toMatchObject({
      before_sha256: createHash('sha256').update('deleted').digest('hex'),
      after_sha256: null,
    });
    transaction.discard();
  });

  it('fails capture on a concurrent base change before staging any effect', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'file.txt'), 'base');
    const transaction = WorkspaceTransaction.open({
      runId: 'run-concurrent',
      baseRoot: root,
    });
    writeFileSync(join(transaction.workspaceRoot, 'file.txt'), 'staged');
    writeFileSync(join(root, 'file.txt'), 'concurrent');
    const overlay = new OverlayBackend('/workspace');

    expect(() => transaction.capture(overlay)).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'workspace changed concurrently: file.txt',
      }),
    );
    expect(overlay.stagedEntries()).toEqual([]);
    expect(overlay.stagedTombstones()).toEqual([]);
    transaction.discard();
  });

  it('distinguishes symlink equality and file-to-symlink concurrency', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'one.txt'), 'one');
    writeFileSync(join(root, 'two.txt'), 'two');
    symlinkSync('one.txt', join(root, 'link'));
    const symlinkTransaction = WorkspaceTransaction.open({
      runId: 'run-symlink-equality',
      baseRoot: root,
    });
    unlinkSync(join(symlinkTransaction.workspaceRoot, 'link'));
    symlinkSync('two.txt', join(symlinkTransaction.workspaceRoot, 'link'));
    expect(() =>
      symlinkTransaction.capture(new OverlayBackend('/workspace')),
    ).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'new or modified symlink cannot be committed: link',
      }),
    );
    symlinkTransaction.discard();

    writeFileSync(join(root, 'file.txt'), 'base');
    const kindTransaction = WorkspaceTransaction.open({
      runId: 'run-kind-concurrent',
      baseRoot: root,
    });
    writeFileSync(join(kindTransaction.workspaceRoot, 'file.txt'), 'staged');
    rmSync(join(root, 'file.txt'));
    symlinkSync('one.txt', join(root, 'file.txt'));
    expect(() => kindTransaction.capture(new OverlayBackend('/workspace'))).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'workspace changed concurrently: file.txt',
      }),
    );
    kindTransaction.discard();
  });

  it('rejects protected-link and commit-overlay violations exactly', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, '.git'));
    const transaction = WorkspaceTransaction.open({
      runId: 'run-protected',
      baseRoot: root,
    });
    unlinkSync(join(transaction.workspaceRoot, '.git'));
    mkdirSync(join(transaction.workspaceRoot, '.git'));
    expect(() => transaction.describeChanges()).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'protected workspace path modified: .git',
      }),
    );
    expect(() => transaction.capture(new OverlayBackend('/scratch'))).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'workspace transaction requires /workspace overlay',
      }),
    );
    transaction.discard();

    const wrongTarget = temporaryDirectory();
    const wrongLink = WorkspaceTransaction.open({
      runId: 'run-protected-target',
      baseRoot: root,
    });
    unlinkSync(join(wrongLink.workspaceRoot, '.git'));
    symlinkSync(wrongTarget, join(wrongLink.workspaceRoot, '.git'));
    expect(() => wrongLink.describeChanges()).toThrow(
      expect.objectContaining({
        name: 'VfsError',
        message: 'protected workspace path modified: .git',
      }),
    );
    wrongLink.discard();
  });

  it('allows complete or discard exactly once and removes owned state', () => {
    const root = temporaryDirectory();
    for (const method of ['complete', 'discard'] as const) {
      const transaction = WorkspaceTransaction.open({
        runId: `run-${method}`,
        baseRoot: root,
      });
      const container = join(transaction.workspaceRoot, '..');
      transaction[method]();
      expect(existsSync(container)).toBe(false);
      expect(() => transaction.describeChanges()).toThrow(
        expect.objectContaining({
          name: 'VfsError',
          message: 'workspace transaction finalized',
        }),
      );
      expect(() => transaction[method]()).toThrow(
        expect.objectContaining({
          name: 'VfsError',
          message: 'workspace transaction finalized',
        }),
      );
    }
  });
});
