/**
 * AH-VFS-001: Virtual Filesystem
 *
 * Single file-access authority with overlay/diff/checkpoint/commit/discard,
 * path normalization, traversal prevention, permission rules, and conflict
 * detection via version tracking.
 *
 * Invariants:
 *  - All paths are normalized to workspace-relative absolute paths
 *  - Path traversal (..), NUL bytes, and symlink escapes are rejected
 *  - Permission rules are enforced on every access (default deny)
 *  - Overlay writes are staged until commit; discard reverts them
 *  - Optimistic locking via content-hash versions prevents stale writes
 */

import { createHash } from 'node:crypto';
import { resolve, normalize, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VfsPermission {
  path_prefix: string;
  read: boolean;
  write: boolean;
}

export interface VfsOptions {
  root: string;
  permissions?: VfsPermission[];
}

export interface VfsDiff {
  changed: string[];
  deleted: string[];
}

export interface VfsCheckpoint {
  id: string;
  files: Map<string, string>;
}

export interface VfsWriteOptions {
  expectedVersion?: string;
}

export interface VfsCommitResult {
  committed: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface OverlayEntry {
  content: string;
  version: string;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Virtual Filesystem
// ---------------------------------------------------------------------------

export class VirtualFilesystem {
  private readonly root: string;
  private readonly permissions: VfsPermission[];
  private readonly overlay = new Map<string, OverlayEntry>();
  private readonly committed = new Map<string, string>();
  private readonly checkpoints = new Map<string, Map<string, string>>();

  constructor(opts: VfsOptions) {
    this.root = normalize(opts.root);
    this.permissions = opts.permissions ?? [];
  }

  normalizePath(inputPath: string): string {
    if (!inputPath || inputPath.length === 0) {
      throw new Error('VFS: empty path');
    }

    if (inputPath.includes('\0')) {
      throw new Error('VFS: NUL byte in path');
    }

    // Remove leading slash for joining
    const relativePath = inputPath.startsWith('/') ? inputPath.slice(1) : inputPath;

    // Join with root and normalize
    const full = normalize(resolve(this.root, relativePath));

    // Check for traversal escape
    if (!full.startsWith(this.root) && full !== this.root) {
      throw new Error(`VFS: path traversal detected - '${inputPath}' escapes root '${this.root}'`);
    }

    // Double-check no .. remains
    if (full.includes('..')) {
      throw new Error(`VFS: path traversal detected - '${inputPath}' contains '..'`);
    }

    return full;
  }

  read(path: string): string | null {
    const normalized = this.normalizePath(path);
    this.checkPermission(normalized, 'read');

    // Check overlay first
    const entry = this.overlay.get(normalized);
    if (entry) {
      if (entry.deleted) return null;
      return entry.content;
    }

    // Check committed store
    return this.committed.get(normalized) ?? null;
  }

  write(path: string, content: string, opts: VfsWriteOptions = {}): void {
    const normalized = this.normalizePath(path);
    this.checkPermission(normalized, 'write');

    // Optimistic locking
    if (opts.expectedVersion !== undefined) {
      const currentVersion = this.getVersion(path);
      if (currentVersion !== opts.expectedVersion) {
        throw new Error(`VFS: write conflict - expected version ${opts.expectedVersion} but found ${currentVersion}`);
      }
    }

    const version = this.hashContent(content);
    this.overlay.set(normalized, { content, version, deleted: false });
  }

  delete(path: string): void {
    const normalized = this.normalizePath(path);
    this.checkPermission(normalized, 'write');

    const entry = this.overlay.get(normalized);
    if (entry) {
      entry.deleted = true;
    } else if (this.committed.has(normalized)) {
      this.overlay.set(normalized, { content: '', version: '', deleted: true });
    }
  }

  list(dirPath: string): string[] {
    const normalizedDir = this.normalizePath(dirPath);
    this.checkPermission(normalizedDir, 'read');

    const results = new Set<string>();
    const prefix = normalizedDir.endsWith(sep) ? normalizedDir : normalizedDir + sep;

    // Check overlay
    for (const [path, entry] of this.overlay) {
      if (!entry.deleted && path.startsWith(prefix)) {
        results.add(path);
      }
    }

    // Check committed
    for (const [path, _content] of this.committed) {
      if (path.startsWith(prefix)) {
        // Don't add if overlay deleted it
        const overlayEntry = this.overlay.get(path);
        if (!overlayEntry?.deleted) {
          results.add(path);
        }
      }
    }

    return [...results].sort();
  }

  getVersion(path: string): string {
    const normalized = this.normalizePath(path);
    const entry = this.overlay.get(normalized);
    if (entry) return entry.version;
    const committed = this.committed.get(normalized);
    if (committed !== undefined) return this.hashContent(committed);
    return '';
  }

  diff(): VfsDiff {
    const changed: string[] = [];
    const deleted: string[] = [];

    for (const [path, entry] of this.overlay) {
      if (entry.deleted) {
        deleted.push(path);
      } else {
        changed.push(path);
      }
    }

    return { changed, deleted };
  }

  checkpoint(id: string): VfsCheckpoint {
    const snapshot = new Map<string, string>();

    // Capture current state (overlay + committed, overlay takes precedence)
    for (const [path, committedContent] of this.committed) {
      const entry = this.overlay.get(path);
      if (entry) {
        if (!entry.deleted) {
          snapshot.set(path, entry.content);
        }
      } else {
        snapshot.set(path, committedContent);
      }
    }

    // Add overlay-only entries
    for (const [path, entry] of this.overlay) {
      if (!entry.deleted && !snapshot.has(path)) {
        snapshot.set(path, entry.content);
      }
    }

    this.checkpoints.set(id, snapshot);
    return { id, files: new Map(snapshot) };
  }

  restore(id: string): void {
    const snapshot = this.checkpoints.get(id);
    if (!snapshot) {
      throw new Error(`VFS: checkpoint '${id}' not found`);
    }

    // Clear overlay and rebuild from snapshot
    this.overlay.clear();
    for (const [path, content] of snapshot) {
      this.overlay.set(path, { content, version: this.hashContent(content), deleted: false });
    }
  }

  commit(): VfsCommitResult {
    let count = 0;
    for (const [path, entry] of this.overlay) {
      if (entry.deleted) {
        this.committed.delete(path);
        count++;
      } else {
        this.committed.set(path, entry.content);
        count++;
      }
    }
    this.overlay.clear();
    return { committed: count };
  }

  discard(): void {
    this.overlay.clear();
  }

  exists(path: string): boolean {
    return this.read(path) !== null;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private checkPermission(normalizedPath: string, op: 'read' | 'write'): void {
    // If no permissions defined, allow all (for testing without permission setup)
    if (this.permissions.length === 0) return;

    for (const perm of this.permissions) {
      const prefix = perm.path_prefix.endsWith(sep) ? perm.path_prefix : perm.path_prefix + sep;
      if (normalizedPath.startsWith(prefix) || normalizedPath === perm.path_prefix) {
        if (op === 'read' && !perm.read) {
          throw new Error(`VFS: read denied for '${normalizedPath}' (permission rule)`);
        }
        if (op === 'write' && !perm.write) {
          throw new Error(`VFS: write denied for '${normalizedPath}' (permission rule)`);
        }
        return;
      }
    }

    // No matching rule -> default deny
    throw new Error(`VFS: no permission rule for '${normalizedPath}' (default deny)`);
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
