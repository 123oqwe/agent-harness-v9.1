import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SandboxProfile } from '../../sandbox/process-sandbox.js';
import {
  LocalBackend,
  VirtualFilesystem,
} from '../../vfs/virtual-filesystem.js';
import { TransactionalWorkspace } from '../../vfs/transactional-workspace.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(stateRoot?: string) {
  const root = mkdtempSync(join(tmpdir(), 'transactional-workspace-'));
  roots.push(root);
  const vfs = new VirtualFilesystem([
    { prefix: '/workspace', read: true, write: true },
  ]);
  vfs.mount(new LocalBackend('/workspace', root));
  const sandbox: SandboxProfile = {
    workspaceRoot: root,
    allowNetwork: false,
    allowUnixSockets: false,
    allowRead: [],
  };
  return {
    root,
    vfs,
    sandbox,
    open(runId = 'run-1') {
      return TransactionalWorkspace.open({
        runId,
        baseVfs: vfs,
        sandbox,
        stateRoot,
      });
    },
  };
}

describe('TransactionalWorkspace', () => {
  it('stages VFS and sandbox work under the same transaction and commits verified changes', () => {
    const setup = fixture();
    writeFileSync(join(setup.root, 'existing.txt'), 'before');
    const workspace = setup.open();
    expect(workspace.sandbox.workspaceRoot).not.toBe(setup.root);
    expect(workspace.sandbox.allowRead.map((path) => realpathSync(path))).toContain(
      realpathSync(setup.root),
    );
    workspace.vfs.writeText('/workspace/existing.txt', 'after');
    workspace.vfs.writeText('/workspace/new.txt', 'new');
    expect(workspace.describeChanges()).toEqual([
      expect.objectContaining({
        path: '/workspace/existing.txt',
        kind: 'modified',
      }),
      expect.objectContaining({
        path: '/workspace/new.txt',
        kind: 'created',
      }),
    ]);
    expect(readFileSync(join(setup.root, 'existing.txt'), 'utf8')).toBe(
      'before',
    );
    workspace.finalize(true);
    expect(readFileSync(join(setup.root, 'existing.txt'), 'utf8')).toBe(
      'after',
    );
    expect(readFileSync(join(setup.root, 'new.txt'), 'utf8')).toBe('new');
  });

  it('discards unverified changes and removes the staged workspace', () => {
    const setup = fixture();
    const workspace = setup.open();
    const stagedRoot = workspace.transaction.workspaceRoot;
    workspace.vfs.writeText('/workspace/new.txt', 'new');
    expect(existsSync(stagedRoot)).toBe(true);
    workspace.finalize(false);
    expect(existsSync(join(setup.root, 'new.txt'))).toBe(false);
    expect(existsSync(stagedRoot)).toBe(false);
  });

  it('persists transaction metadata under an explicit state root', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'transaction-state-'));
    roots.push(stateRoot);
    const setup = fixture(stateRoot);
    const workspace = setup.open('run-state');
    expect(workspace.transaction.workspaceRoot).toContain(stateRoot);
    workspace.finalize(false);
  });

  it('allows finalization exactly once', () => {
    const workspace = fixture().open();
    workspace.finalize(false);
    expect(() => workspace.finalize(false)).toThrow(
      'transactional workspace is already finalized',
    );
    expect(() => workspace.finalize(true)).toThrow(
      'transactional workspace is already finalized',
    );
  });

  it('fails closed and discards the stage when base commit fails', () => {
    const setup = fixture();
    const workspace = setup.open();
    const stagedRoot = workspace.transaction.workspaceRoot;
    workspace.vfs.writeText('/workspace/new.txt', 'new');
    vi.spyOn(setup.vfs, 'commitOverlay').mockImplementation(() => {
      throw new Error('commit failed');
    });
    expect(() => workspace.finalize(true)).toThrow('commit failed');
    expect(existsSync(join(setup.root, 'new.txt'))).toBe(false);
    expect(existsSync(stagedRoot)).toBe(false);
    expect(setup.vfs.receipts()).toEqual([
      expect.objectContaining({
        path: '/workspace',
        operation: 'discard',
      }),
    ]);
  });

  it('preserves the authoritative rollback error when VFS already discarded the overlay', () => {
    const setup = fixture();
    const workspace = setup.open();
    workspace.vfs.writeText('/workspace/new.txt', 'new');
    const backend = setup.vfs.route('/workspace');
    vi.spyOn(backend, 'write').mockImplementationOnce(() => {
      throw new Error('backend unavailable');
    });
    expect(() => workspace.finalize(true)).toThrow(
      'overlay commit failed, rolled back 0 writes: backend unavailable',
    );
    expect(existsSync(join(setup.root, 'new.txt'))).toBe(false);
    expect(setup.vfs.receipts()).toEqual([
      expect.objectContaining({
        path: '/workspace',
        operation: 'discard',
      }),
    ]);
  });

  it('detects a concurrent base change and does not overwrite it', () => {
    const setup = fixture();
    writeFileSync(join(setup.root, 'shared.txt'), 'before');
    const workspace = setup.open();
    workspace.vfs.writeText('/workspace/shared.txt', 'agent');
    writeFileSync(join(setup.root, 'shared.txt'), 'external');
    expect(() => workspace.finalize(true)).toThrow(
      'workspace changed concurrently: shared.txt',
    );
    expect(readFileSync(join(setup.root, 'shared.txt'), 'utf8')).toBe(
      'external',
    );
  });
});
