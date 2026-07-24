import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalBackend,
  OverlayBackend,
  VirtualFilesystem,
  VfsError,
} from '../../vfs/virtual-filesystem.js';
import { WorkspaceTransaction } from '../../vfs/workspace-transaction.js';
import { executeCommand } from '../../tools/execute-command.js';

describe('Phase 1 workspace transaction', () => {
  let root: string;
  let stateRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ah-workspace-base-'));
    stateRoot = mkdtempSync(join(tmpdir(), 'ah-workspace-state-'));
    writeFileSync(join(root, 'existing.txt'), 'before');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  function baseVfs(): VirtualFilesystem {
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
      { prefix: '/workspace/readonly', read: true, write: false },
    ]);
    vfs.mount(new LocalBackend('/workspace', root));
    return vfs;
  }

  it('keeps staged edits isolated, then commits the complete byte diff', () => {
    const vfs = baseVfs();
    const transaction = WorkspaceTransaction.open({
      runId: 'run-commit',
      baseRoot: root,
      stateRoot,
    });
    const stagedVfs = transaction.createVfs(vfs);

    stagedVfs.writeText('/workspace/existing.txt', 'after');
    stagedVfs.writeText('/workspace/new.txt', 'new');

    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('before');
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
    expect(readFileSync(join(transaction.workspaceRoot, 'existing.txt'), 'utf8')).toBe('after');

    const overlay = new OverlayBackend('/workspace');
    overlay.setBaseBackend(vfs.route('/workspace'));
    transaction.capture(overlay);
    vfs.commitOverlay(overlay);
    transaction.complete();

    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('after');
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('new');
    expect(existsSync(transaction.workspaceRoot)).toBe(false);
  });

  it('describes staged changes with before/after hashes without exposing content', () => {
    const transaction = WorkspaceTransaction.open({
      runId: 'run-describe',
      baseRoot: root,
      stateRoot,
    });
    const staged = transaction.createVfs(baseVfs());
    staged.writeText('/workspace/existing.txt', 'after');
    staged.writeText('/workspace/new.txt', 'new');

    const changes = transaction.describeChanges();
    expect(changes).toEqual([
      expect.objectContaining({
        path: '/workspace/existing.txt',
        kind: 'modified',
        before_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        after_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
      expect.objectContaining({
        path: '/workspace/new.txt',
        kind: 'created',
        before_sha256: null,
        after_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    ]);
    expect(JSON.stringify(changes)).not.toContain('"after"');
    expect(Object.isFrozen(changes)).toBe(true);
    transaction.discard();
  });

  it('discards staged edits without changing the real workspace', () => {
    const transaction = WorkspaceTransaction.open({
      runId: 'run-discard',
      baseRoot: root,
      stateRoot,
    });
    const stagedVfs = transaction.createVfs(baseVfs());
    stagedVfs.writeText('/workspace/existing.txt', 'must-not-leak');
    stagedVfs.writeText('/workspace/new.txt', 'must-not-exist');

    transaction.discard();

    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('before');
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
    expect(existsSync(transaction.workspaceRoot)).toBe(false);
  });

  it('reopens the same durable staged workspace after a process restart', () => {
    const first = WorkspaceTransaction.open({
      runId: 'run-resume',
      baseRoot: root,
      stateRoot,
    });
    first.createVfs(baseVfs()).writeText('/workspace/existing.txt', 'staged');

    const resumed = WorkspaceTransaction.open({
      runId: 'run-resume',
      baseRoot: root,
      stateRoot,
    });

    expect(resumed.resumed).toBe(true);
    expect(resumed.createVfs(baseVfs()).readText('/workspace/existing.txt')).toBe('staged');
    resumed.discard();
  });

  it('preserves original VFS deny rules in the staged view', () => {
    const transaction = WorkspaceTransaction.open({
      runId: 'run-acl',
      baseRoot: root,
      stateRoot,
    });
    const stagedVfs = transaction.createVfs(baseVfs());

    expect(() =>
      stagedVfs.writeText('/workspace/readonly/blocked.txt', 'no'),
    ).toThrow(/permission denied/);
    transaction.discard();
  });

  it('rejects a command-created symlink instead of committing an escape', () => {
    const vfs = baseVfs();
    const transaction = WorkspaceTransaction.open({
      runId: 'run-link',
      baseRoot: root,
      stateRoot,
    });
    symlinkSync('/tmp', join(transaction.workspaceRoot, 'escape'));
    const overlay = new OverlayBackend('/workspace');
    overlay.setBaseBackend(vfs.route('/workspace'));

    expect(() => transaction.capture(overlay)).toThrow(VfsError);
    expect(existsSync(join(root, 'escape'))).toBe(false);
    transaction.discard();
  });

  it('maps only VFS or original-workspace cwd values into the staged root', () => {
    const transaction = WorkspaceTransaction.open({
      runId: 'run-cwd',
      baseRoot: root,
      stateRoot,
    });

    expect(transaction.mapCwd('/workspace')).toBe(transaction.workspaceRoot);
    expect(transaction.mapCwd(root)).toBe(transaction.workspaceRoot);
    expect(() => transaction.mapCwd('/tmp')).toThrow(VfsError);
    transaction.discard();
  });

  it('gives file tools and sandboxed commands the same staged workspace', async () => {
    const vfs = baseVfs();
    const transaction = WorkspaceTransaction.open({
      runId: 'run-command',
      baseRoot: root,
      stateRoot,
    });
    transaction
      .createVfs(vfs)
      .writeText('/workspace/existing.txt', 'from-file-tool');

    const result = await executeCommand(
      transaction.sandboxProfile({
        workspaceRoot: root,
        allowNetwork: false,
        allowUnixSockets: false,
        allowRead: [],
      }),
      {
        argv: [
          '/bin/sh',
          '-c',
          'test "$(cat existing.txt)" = "from-file-tool" && printf from-command > command.txt',
        ],
        cwd: transaction.mapCwd('/workspace'),
      },
    );

    expect(result.exit_code, result.stderr).toBe(0);
    expect(existsSync(join(root, 'command.txt'))).toBe(false);
    expect(
      readFileSync(join(transaction.workspaceRoot, 'command.txt'), 'utf8'),
    ).toBe('from-command');

    const overlay = new OverlayBackend('/workspace');
    overlay.setBaseBackend(vfs.route('/workspace'));
    transaction.capture(overlay);
    vfs.commitOverlay(overlay);
    transaction.complete();
    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe(
      'from-file-tool',
    );
    expect(readFileSync(join(root, 'command.txt'), 'utf8')).toBe('from-command');
  }, 10_000);

  it('commits executable mode changes with file content', () => {
    const vfs = baseVfs();
    const transaction = WorkspaceTransaction.open({
      runId: 'run-mode',
      baseRoot: root,
      stateRoot,
    });
    const script = join(transaction.workspaceRoot, 'run.sh');
    writeFileSync(script, '#!/bin/sh\nexit 0\n');
    chmodSync(script, 0o755);
    const overlay = new OverlayBackend('/workspace');
    overlay.setBaseBackend(vfs.route('/workspace'));

    transaction.capture(overlay);
    vfs.commitOverlay(overlay);
    transaction.complete();

    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('excludes an in-workspace state directory from the staged project', () => {
    const inWorkspaceState = join(root, '.harness-state');
    const transaction = WorkspaceTransaction.open({
      runId: 'run-nested-state',
      baseRoot: root,
      stateRoot: inWorkspaceState,
    });

    expect(
      existsSync(join(transaction.workspaceRoot, '.harness-state')),
    ).toBe(false);
    transaction.discard();
  });
});
