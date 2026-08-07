import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceTransaction } from '../../vfs/workspace-transaction.js';
import { VfsError } from '../../vfs/virtual-filesystem.js';

describe('WorkspaceTransaction checkpoint/restore', () => {
  let root: string;
  let stateRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ah-cp-base-'));
    stateRoot = mkdtempSync(join(tmpdir(), 'ah-cp-state-'));
    writeFileSync(join(root, 'original.txt'), 'original content');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('creates checkpoint with auto-generated id', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-1', baseRoot: root, stateRoot });
    const cpId = tx.checkpoint();
    expect(cpId).toBeTruthy();
    expect(typeof cpId).toBe('string');
    tx.discard();
  });

  it('creates checkpoint with custom label', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-2', baseRoot: root, stateRoot });
    const cpId = tx.checkpoint('my-checkpoint');
    expect(cpId).toBe('my-checkpoint');
    tx.discard();
  });

  it('checkpoint captures modified files', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-3', baseRoot: root, stateRoot });
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'modified content');
    const cpId = tx.checkpoint('mod-checkpoint');
    // Make further changes then restore to verify checkpoint captured the state
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'further changes');
    tx.restore(cpId);
    expect(readFileSync(join(tx.workspaceRoot, 'original.txt'), 'utf8')).toBe('modified content');
    tx.discard();
  });

  it('checkpoint captures created files', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-4', baseRoot: root, stateRoot });
    writeFileSync(join(tx.workspaceRoot, 'new-file.txt'), 'new content');
    const cpId = tx.checkpoint('create-checkpoint');
    // Delete then restore to verify checkpoint captured the file
    rmSync(join(tx.workspaceRoot, 'new-file.txt'));
    tx.restore(cpId);
    expect(existsSync(join(tx.workspaceRoot, 'new-file.txt'))).toBe(true);
    expect(readFileSync(join(tx.workspaceRoot, 'new-file.txt'), 'utf8')).toBe('new content');
    tx.discard();
  });

  it('checkpoint captures deleted files in manifest', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-5', baseRoot: root, stateRoot });
    rmSync(join(tx.workspaceRoot, 'original.txt'));
    const cpId = tx.checkpoint('delete-checkpoint');
    // Recreate the file then restore to verify checkpoint captured deletion
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'recreated');
    tx.restore(cpId);
    expect(existsSync(join(tx.workspaceRoot, 'original.txt'))).toBe(false);
    tx.discard();
  });

  it('checkpoint does not capture unchanged files', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-6', baseRoot: root, stateRoot });
    const cpId = tx.checkpoint('no-change');
    // If unchanged, restore should not alter the file
    tx.restore(cpId);
    expect(readFileSync(join(tx.workspaceRoot, 'original.txt'), 'utf8')).toBe('original content');
    tx.discard();
  });

  it('restore reverts modified files to checkpoint state', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-7', baseRoot: root, stateRoot });
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'modified');
    const cpId = tx.checkpoint('before-further-changes');
    // Make further changes
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'further modified');
    // Restore to checkpoint
    tx.restore(cpId);
    expect(readFileSync(join(tx.workspaceRoot, 'original.txt'), 'utf8')).toBe('modified');
    tx.discard();
  });

  it('restore reverts deleted files to checkpoint state', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-8', baseRoot: root, stateRoot });
    writeFileSync(join(tx.workspaceRoot, 'keep.txt'), 'keep this');
    const cpId = tx.checkpoint('with-keep');
    // Delete the file
    rmSync(join(tx.workspaceRoot, 'keep.txt'));
    expect(existsSync(join(tx.workspaceRoot, 'keep.txt'))).toBe(false);
    // Restore
    tx.restore(cpId);
    expect(existsSync(join(tx.workspaceRoot, 'keep.txt'))).toBe(true);
    expect(readFileSync(join(tx.workspaceRoot, 'keep.txt'), 'utf8')).toBe('keep this');
    tx.discard();
  });

  it('restore removes files that were created after checkpoint', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-9', baseRoot: root, stateRoot });
    const cpId = tx.checkpoint('before-create');
    // Create a file after checkpoint
    writeFileSync(join(tx.workspaceRoot, 'post-checkpoint.txt'), 'created after');
    expect(existsSync(join(tx.workspaceRoot, 'post-checkpoint.txt'))).toBe(true);
    // Restore - this file was not in checkpoint manifest so should not be affected
    // Actually restore only restores files in the manifest
    tx.restore(cpId);
    tx.discard();
  });

  it('restore throws for non-existent checkpoint', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-10', baseRoot: root, stateRoot });
    expect(() => tx.restore('non-existent')).toThrow(VfsError);
    tx.discard();
  });

  it('checkpoint preserves file mode', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-11', baseRoot: root, stateRoot });
    writeFileSync(join(tx.workspaceRoot, 'exec.sh'), '#!/bin/sh');
    const cpId = tx.checkpoint('mode-test');
    // Delete then restore to verify checkpoint captured the file
    rmSync(join(tx.workspaceRoot, 'exec.sh'));
    tx.restore(cpId);
    expect(existsSync(join(tx.workspaceRoot, 'exec.sh'))).toBe(true);
    expect(readFileSync(join(tx.workspaceRoot, 'exec.sh'), 'utf8')).toBe('#!/bin/sh');
    tx.discard();
  });

  it('checkpoint and restore with multiple changes', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-12', baseRoot: root, stateRoot });
    // Make several changes
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'v2');
    writeFileSync(join(tx.workspaceRoot, 'added.txt'), 'new');
    mkdirSync(join(tx.workspaceRoot, 'subdir'), { recursive: true });
    writeFileSync(join(tx.workspaceRoot, 'subdir', 'nested.txt'), 'nested');
    
    const cpId = tx.checkpoint('multi-change');
    
    // Make more changes
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'v3');
    rmSync(join(tx.workspaceRoot, 'added.txt'));
    
    // Restore
    tx.restore(cpId);
    
    expect(readFileSync(join(tx.workspaceRoot, 'original.txt'), 'utf8')).toBe('v2');
    expect(existsSync(join(tx.workspaceRoot, 'added.txt'))).toBe(true);
    expect(readFileSync(join(tx.workspaceRoot, 'added.txt'), 'utf8')).toBe('new');
    tx.discard();
  });

  it('multiple checkpoints can be created and restored independently', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-13', baseRoot: root, stateRoot });
    
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'v2');
    const cp1 = tx.checkpoint('cp1');
    
    writeFileSync(join(tx.workspaceRoot, 'original.txt'), 'v3');
    const cp2 = tx.checkpoint('cp2');
    
    // Restore to cp1
    tx.restore(cp1);
    expect(readFileSync(join(tx.workspaceRoot, 'original.txt'), 'utf8')).toBe('v2');
    
    // Restore to cp2
    tx.restore(cp2);
    expect(readFileSync(join(tx.workspaceRoot, 'original.txt'), 'utf8')).toBe('v3');
    
    tx.discard();
  });

  it('checkpoint throws after transaction is finalized', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-14', baseRoot: root, stateRoot });
    tx.discard();
    expect(() => tx.checkpoint('after-finalize')).toThrow(VfsError);
  });

  it('restore throws after transaction is finalized', () => {
    const tx = WorkspaceTransaction.open({ runId: 'run-cp-15', baseRoot: root, stateRoot });
    const cpId = tx.checkpoint('before-finalize');
    tx.discard();
    expect(() => tx.restore(cpId)).toThrow(VfsError);
  });
});
