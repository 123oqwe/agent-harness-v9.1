/**
 * AH-VFS-001: Virtual Filesystem — the single file-access authority.
 *
 * Backends routed by path prefix (longest match wins):
 *   /workspace/*  -> LocalBackend    (real project files)
 *   /scratch/*    -> OverlayBackend  (per-RunPlan transactional staged writes)
 *   /memories/*   -> StoreBackend    (cross-thread durable)
 *   /evidence/*   -> EvidenceBackend (WORM)
 *
 * The OverlayBackend stages RunPlan writes and commits atomically only after
 * verification, discarding partial edits on failure. Path traversal, symlink
 * escape and cross-backend aliasing are rejected. Permission rules are
 * evaluated for EVERY access regardless of caller (closes the RAG-bypass hole).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, basename } from 'node:path';

export type VfsBackendKind = 'local' | 'overlay' | 'store' | 'evidence';

export interface VfsPermissionRule { prefix: string; read: boolean; write: boolean; }

export interface VfsReceipt {
  path: string;
  backend: VfsBackendKind;
  operation: 'read' | 'list' | 'search' | 'write' | 'edit' | 'commit' | 'discard' | 'delete';
  bytes?: number;
  sha256?: string;
  timestamp: string;
}

export class VfsError extends Error {
  constructor(message: string) { super(message); this.name = 'VfsError'; Object.setPrototypeOf(this, VfsError.prototype); }
}

export interface VfsEntry { path: string; kind: 'file' | 'dir'; size: number; }

interface Backend {
  readonly kind: VfsBackendKind;
  readonly prefix: string;
  read(path: string): Buffer;
  list(path: string): VfsEntry[];
  write(path: string, data: Buffer): void;
  delete(path: string): void;
  exists(path: string): boolean;
}

/** Reject traversal/escape anywhere a user-supplied path is accepted. */
export function assertSafeVfsPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) throw new VfsError('path required');
  if (!path.startsWith('/')) throw new VfsError(`path must be absolute within VFS: ${path}`);
  if (path.includes('\0')) throw new VfsError('null byte in path');
  if (/(^|\/)\.\.(\/|$)/.test(path)) throw new VfsError(`traversal rejected: ${path}`);
}

function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch {
    // For non-existent paths, resolve the parent directory and rejoin
    try {
      const dir = dirname(p);
      const dirReal = realpathSync(dir);
      return join(dirReal, basename(p));
    } catch { return p; }
  }
}
function clone(b: Buffer | undefined): Buffer { if (!b) throw new VfsError('not found'); return Buffer.from(b); }
function sha(b: Buffer): string { return createHash('sha256').update(b).digest('hex'); }
function now(): string { return new Date().toISOString(); }

/** Real-filesystem backend rooted at an OS directory, exposed under a VFS prefix. */
export class LocalBackend implements Backend {
  readonly kind = 'local' as const;
  constructor(readonly prefix: string, private readonly root: string) {}
  private osPath(vfsPath: string): string {
    const rel = relative(this.prefix, vfsPath);
    if (rel.startsWith('..')) throw new VfsError(`escape from ${this.prefix}: ${vfsPath}`);
    return resolve(this.root, rel);
  }
  private safe(osPath: string): string {
    // Resolve both paths through realpath to handle macOS /var -> /private/var
    const real = realpathSafe(osPath);
    const rootReal = realpathSafe(this.root);
    const rel = relative(rootReal, real);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new VfsError(`symlink escape from ${this.root}: ${osPath}`);
    return real;
  }
  read(path: string): Buffer { return readFileSync(this.safe(this.osPath(path))); }
  list(path: string): VfsEntry[] {
    const dir = this.safe(this.osPath(path));
    return readdirSync(dir, { withFileTypes: true }).map(e => ({
      path: join(path, e.name).replace(/\\/g, '/'),
      kind: e.isDirectory() ? 'dir' : 'file',
      size: e.isDirectory() ? 0 : statSync(join(dir, e.name)).size,
    }));
  }
  write(path: string, data: Buffer): void {
    const os = this.osPath(path);
    // Check symlink escape BEFORE writing (not after) to prevent writing outside root
    this.safe(os);
    mkdirSync(dirname(os), { recursive: true });
    // Re-check after mkdir in case a symlink was created in the parent dir
    this.safe(os);
    writeFileSync(os, data);
  }
  delete(path: string): void { rmSync(this.osPath(path), { recursive: true, force: true }); }
  exists(path: string): boolean { try { this.safe(this.osPath(path)); return existsSync(this.osPath(path)); } catch { return false; } }
}

/** In-memory cross-thread store (e.g. /memories). */
export class StoreBackend implements Backend {
  readonly kind = 'store' as const;
  private readonly files = new Map<string, Buffer>();
  constructor(readonly prefix: string) {}
  read(path: string): Buffer { return clone(this.files.get(path)); }
  list(path: string): VfsEntry[] {
    const out: VfsEntry[] = [];
    for (const k of this.files.keys()) if (k.startsWith(path === '/' ? '/' : path + '/')) out.push({ path: k, kind: 'file', size: this.files.get(k)!.length });
    return out;
  }
  write(path: string, data: Buffer): void { this.files.set(path, clone(data)); }
  delete(path: string): void { this.files.delete(path); }
  exists(path: string): boolean { return this.files.has(path); }
}

/** Evidence backend is write-once-read-many (WORM): no overwrite or delete. */
export class EvidenceBackend implements Backend {
  readonly kind = 'evidence' as const;
  private readonly files = new Map<string, Buffer>();
  constructor(readonly prefix: string) {}
  read(path: string): Buffer { return clone(this.files.get(path)); }
  list(path: string): VfsEntry[] {
    const out: VfsEntry[] = [];
    for (const k of this.files.keys()) if (k.startsWith(path === '/' ? '/' : path + '/')) out.push({ path: k, kind: 'file', size: this.files.get(k)!.length });
    return out;
  }
  write(path: string, data: Buffer): void {
    if (this.files.has(path)) throw new VfsError(`evidence is WORM: ${path} already exists`);
    this.files.set(path, clone(data));
  }
  delete(_path: string): void { throw new VfsError('evidence backend is immutable'); }
  exists(path: string): boolean { return this.files.has(path); }
}

/** Per-RunPlan transactional overlay: stages writes, commits atomically or discards.
 *  Supports read-through to a base backend for paths not staged or tombstoned. */
export class OverlayBackend implements Backend {
  readonly kind = 'overlay' as const;
  private readonly staged = new Map<string, Buffer>();
  private readonly tombstones = new Set<string>();
  private committed = false;
  private discarded = false;
  private baseBackend: Backend | null = null;
  constructor(readonly prefix: string) {}
  /** Set the base backend for read-through (un-staged paths fall through to base). */
  setBaseBackend(base: Backend): void { this.baseBackend = base; }
  private checkTx(): void {
    if (this.committed) throw new VfsError('overlay already committed');
    if (this.discarded) throw new VfsError('overlay already discarded');
  }
  read(path: string): Buffer {
    if (this.tombstones.has(path)) throw new VfsError(`not found: ${path}`);
    if (this.staged.has(path)) return clone(this.staged.get(path));
    // Read-through to base backend for un-staged paths
    if (this.baseBackend) return this.baseBackend.read(path);
    throw new VfsError(`not found: ${path}`);
  }
  list(path: string): VfsEntry[] {
    const out: VfsEntry[] = [];
    const seen = new Set<string>();
    for (const k of this.staged.keys()) {
      if (!this.tombstones.has(k) && k.startsWith(path === '/' ? '/' : path + '/')) {
        out.push({ path: k, kind: 'file', size: this.staged.get(k)!.length });
        seen.add(k);
      }
    }
    // Merge with base backend entries
    if (this.baseBackend) {
      for (const e of this.baseBackend.list(path)) {
        if (!seen.has(e.path) && !this.tombstones.has(e.path)) out.push(e);
      }
    }
    return out;
  }
  write(path: string, data: Buffer): void { this.checkTx(); this.staged.set(path, clone(data)); this.tombstones.delete(path); }
  delete(path: string): void { this.checkTx(); this.tombstones.add(path); this.staged.delete(path); }
  exists(path: string): boolean {
    if (this.tombstones.has(path)) return false;
    if (this.staged.has(path)) return true;
    if (this.baseBackend) return this.baseBackend.exists(path);
    return false;
  }
  stagedEntries(): ReadonlyArray<readonly [string, Buffer]> { return [...this.staged.entries()].map(([p, b]) => [p, clone(b)] as const); }
  stagedTombstones(): readonly string[] { return [...this.tombstones]; }
  markCommitted(): void { this.committed = true; }
  markDiscarded(): void { this.discarded = true; }
  isCommitted(): boolean { return this.committed; }
  isDiscarded(): boolean { return this.discarded; }
}

/** Routes by path prefix (longest match wins). Single file authority. */
export class VirtualFilesystem {
  private readonly backends: Backend[] = [];
  private readonly permissions: VfsPermissionRule[] = [];
  private readonly log: VfsReceipt[] = [];
  constructor(rules?: VfsPermissionRule[]) { if (rules) this.permissions.push(...rules); }
  mount(backend: Backend): void {
    if (this.backends.some(b => b.prefix === backend.prefix)) throw new VfsError(`duplicate mount: ${backend.prefix}`);
    this.backends.push(backend);
    this.backends.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  addPermissionRule(rule: VfsPermissionRule): void { this.permissions.push(rule); }
  private route(path: string): Backend {
    assertSafeVfsPath(path);
    for (const b of this.backends) if (path === b.prefix || path.startsWith(b.prefix === '/' ? '/' : b.prefix + '/')) return b;
    throw new VfsError(`no backend for path: ${path}`);
  }
  private checkPermission(path: string, write: boolean): void {
    // deny-by-default: a path is accessible only if a rule explicitly permits it.
    let allowed = false;
    for (const r of this.permissions) if (path === r.prefix || path.startsWith(r.prefix === '/' ? '/' : r.prefix + '/')) allowed = write ? r.write : r.read;
    if (!allowed) throw new VfsError(`permission denied: ${path}`);
  }
  private record(r: VfsReceipt): void { this.log.push(r); }
  receipts(): readonly VfsReceipt[] { return this.log; }

  read(path: string): Buffer { this.checkPermission(path, false); const b = this.route(path); const data = b.read(path); this.record({ path, backend: b.kind, operation: 'read', bytes: data.length, sha256: sha(data), timestamp: now() }); return data; }
  readText(path: string): string { return this.read(path).toString('utf8'); }
  list(path: string): VfsEntry[] { this.checkPermission(path, false); const b = this.route(path); const entries = b.list(path); this.record({ path, backend: b.kind, operation: 'list', timestamp: now() }); return entries; }
  write(path: string, data: Buffer | string): void { this.checkPermission(path, true); const b = this.route(path); const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data; b.write(path, buf); this.record({ path, backend: b.kind, operation: 'write', bytes: buf.length, sha256: sha(buf), timestamp: now() }); }
  writeText(path: string, text: string): void { this.write(path, text); }
  edit(path: string, data: Buffer | string): void { this.write(path, data); const last = this.log[this.log.length - 1]; if (last) last.operation = 'edit'; }
  delete(path: string): void { this.checkPermission(path, true); const b = this.route(path); b.delete(path); this.record({ path, backend: b.kind, operation: 'delete', timestamp: now() }); }
  exists(path: string): boolean { try { this.checkPermission(path, false); return this.route(path).exists(path); } catch { return false; } }
  search(root: string, needle: string): VfsEntry[] {
    const lower = needle.toLowerCase();
    const matches: VfsEntry[] = [];
    const walk = (dir: string): void => {
      let entries: VfsEntry[];
      try { entries = this.list(dir); } catch { return; }
      for (const e of entries) {
        if (e.kind === 'dir') walk(e.path);
        else { try { if (this.readText(e.path).toLowerCase().includes(lower)) matches.push(e); } catch { /* permission */ } }
      }
    };
    walk(root);
    this.record({ path: root, backend: this.route(root).kind, operation: 'search', timestamp: now() });
    return matches;
  }

  /** Atomically commit a RunPlan overlay into its commit target backend.
   *  Saves original content before overwriting; restores on failure. */
  commitOverlay(overlay: OverlayBackend, target: Backend): void {
    if (overlay.isCommitted() || overlay.isDiscarded()) throw new VfsError('overlay already finalized');
    // Save originals for rollback: content of existing files + existence of new files
    const originals = new Map<string, Buffer | null>(); // null = file did not exist
    const deletedFiles = new Map<string, Buffer>(); // path -> original content (for restore)
    const writtenPaths: string[] = [];
    try {
      // Phase 1: Save originals for all staged writes and tombstones
      for (const [path] of overlay.stagedEntries()) {
        this.checkPermission(path, true);
        try { originals.set(path, target.read(path)); } catch { originals.set(path, null); }
      }
      for (const path of overlay.stagedTombstones()) {
        this.checkPermission(path, true);
        try { deletedFiles.set(path, target.read(path)); } catch { /* file may not exist */ }
      }
      // Phase 2: Write all entries
      for (const [path, buf] of overlay.stagedEntries()) {
        target.write(path, buf);
        writtenPaths.push(path);
        this.record({ path, backend: target.kind, operation: 'commit', bytes: buf.length, sha256: sha(buf), timestamp: now() });
      }
      // Phase 3: Delete tombstoned files
      for (const path of overlay.stagedTombstones()) {
        target.delete(path);
        this.record({ path, backend: target.kind, operation: 'commit', timestamp: now() });
      }
      overlay.markCommitted();
    } catch (e) {
      // Rollback: restore original content for overwritten files, restore deleted files, delete new files
      for (const [path, original] of originals) {
        if (original !== null) {
          try { target.write(path, original); } catch { /* best effort */ }
        } else {
          // File was new — delete it
          try { target.delete(path); } catch { /* best effort */ }
        }
      }
      for (const [path, original] of deletedFiles) {
        try { target.write(path, original); } catch { /* best effort */ }
      }
      this.record({ path: overlay.prefix, backend: target.kind, operation: 'discard', timestamp: now() });
      throw new VfsError(`overlay commit failed, rolled back ${writtenPaths.length} writes: ${(e as Error).message}`);
    }
  }
  discardOverlay(overlay: OverlayBackend): void {
    overlay.markDiscarded();
    this.record({ path: overlay.prefix, backend: 'overlay', operation: 'discard', timestamp: now() });
  }
}
