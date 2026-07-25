import type { SandboxProfile } from '../runtime/sandbox.js';
import {
  OverlayBackend,
  type VirtualFilesystem,
} from './virtual-filesystem.js';
import {
  WorkspaceTransaction,
  type WorkspaceChange,
} from './workspace-transaction.js';

export interface TransactionalWorkspaceConfig {
  runId: string;
  baseVfs: VirtualFilesystem;
  sandbox: SandboxProfile;
  stateRoot: string | undefined;
}

export class TransactionalWorkspace {
  readonly transaction: WorkspaceTransaction;
  readonly vfs: VirtualFilesystem;
  readonly sandbox: SandboxProfile;
  private readonly overlay: OverlayBackend;
  private readonly baseVfs: VirtualFilesystem;
  private finalized = false;

  private constructor(config: TransactionalWorkspaceConfig) {
    this.baseVfs = config.baseVfs;
    this.overlay = new OverlayBackend('/workspace');
    this.overlay.setBaseBackend(config.baseVfs.route('/workspace'));
    this.transaction = WorkspaceTransaction.open({
      runId: config.runId,
      baseRoot: config.sandbox.workspaceRoot,
      stateRoot: config.stateRoot,
    });
    this.vfs = this.transaction.createVfs(config.baseVfs);
    this.sandbox = this.transaction.sandboxProfile(config.sandbox);
  }

  static open(config: TransactionalWorkspaceConfig): TransactionalWorkspace {
    return new TransactionalWorkspace(config);
  }

  describeChanges(): readonly WorkspaceChange[] {
    return this.transaction.describeChanges();
  }

  finalize(success: boolean): void {
    if (this.finalized) {
      throw new Error('transactional workspace is already finalized');
    }
    this.finalized = true;
    try {
      if (success) {
        this.transaction.capture(this.overlay);
        this.baseVfs.commitOverlay(this.overlay);
        this.transaction.complete();
      } else {
        this.baseVfs.discardOverlay(this.overlay);
        this.transaction.discard();
      }
    } catch (error) {
      if (!this.overlay.isCommitted() && !this.overlay.isDiscarded()) {
        this.baseVfs.discardOverlay(this.overlay);
      }
      try {
        this.transaction.discard();
      } catch {
        // The primary finalization error remains authoritative.
      }
      throw error;
    }
  }

}
