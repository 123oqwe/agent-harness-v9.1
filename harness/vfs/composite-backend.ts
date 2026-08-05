/**
 * AH-VFS-002: Composite Backend Routing + Concurrency Control
 * (P2-15, P2-16)
 *
 * Routes file operations by path prefix:
 *   /workspace/* -> LocalBackend (real FS)
 *   /scratch/*   -> OverlayBackend (per-RunPlan transaction)
 *   /memories/*  -> StoreBackend (cross-session)
 *   /evidence/*  -> EvidenceBackend (WORM)
 *
 * OverlayBackend uses file-level locking (fcntl.flock equivalent) for
 * concurrency control (P2-16).
 */

import { createHash } from 'node:crypto';

export type BackendType = 'local' | 'overlay' | 'store' | 'evidence';

export interface BackendRoute {
  prefix: string;
  backend: BackendType;
}

export const DEFAULT_ROUTES: BackendRoute[] = [
  { prefix: '/workspace/', backend: 'local' },
  { prefix: '/scratch/', backend: 'overlay' },
  { prefix: '/memories/', backend: 'store' },
  { prefix: '/evidence/', backend: 'evidence' },
];

export class CompositeBackend {
  private readonly routes: BackendRoute[];
  private readonly localStore = new Map<string, string>();
  private readonly overlayStore = new Map<string, { content: string; version: string }>();
  private readonly storeBackend = new Map<string, string>();
  private readonly evidenceLog: { id: string; content: string; hash: string; prev_hash: string }[] = [];
  private readonly locks = new Map<string, number>(); // path -> lock count (P2-16)

  constructor(routes: BackendRoute[] = DEFAULT_ROUTES) {
    this.routes = routes;
  }

  resolveBackend(path: string): BackendType {
    for (const route of this.routes) {
      if (path.startsWith(route.prefix)) return route.backend;
    }
    return 'local';
  }

  read(path: string): string | null {
    const backend = this.resolveBackend(path);
    switch (backend) {
      case 'local': return this.localStore.get(path) ?? null;
      case 'overlay':
        // After commit, overlay is cleared but data lives in localStore.
        // Check overlay first, then fall back to localStore for committed data.
        return this.overlayStore.get(path)?.content ?? this.localStore.get(path) ?? null;
      case 'store': return this.storeBackend.get(path) ?? null;
      case 'evidence':
        return this.evidenceLog.find((e) => e.id === path)?.content ?? null;
    }
  }

  write(path: string, content: string): void {
    // P2-16: file-level locking (simplified for single-agent Phase 2)
    this.acquireLock(path);
    try {
      const backend = this.resolveBackend(path);
      const version = createHash('sha256').update(content).digest('hex');

      switch (backend) {
        case 'local':
          this.localStore.set(path, content);
          break;
        case 'overlay':
          this.overlayStore.set(path, { content, version });
          break;
        case 'store':
          this.storeBackend.set(path, content);
          break;
       case 'evidence':
        {
          // WORM: append-only with hash chain
          const prevHash = this.evidenceLog.length > 0
            ? this.evidenceLog[this.evidenceLog.length - 1].hash
            : '';
          const hash = createHash('sha256')
            .update(content + prevHash)
            .digest('hex');
          this.evidenceLog.push({ id: path, content, hash, prev_hash: prevHash });
         break;
        }
      }
    } finally {
      this.releaseLock(path);
    }
  }

  delete(path: string): boolean {
    const backend = this.resolveBackend(path);
    switch (backend) {
      case 'local': return this.localStore.delete(path);
      case 'overlay': return this.overlayStore.delete(path);
      case 'store': return this.storeBackend.delete(path);
      case 'evidence': return false; // WORM: cannot delete
    }
  }

  list(prefix: string): string[] {
    const backend = this.resolveBackend(prefix);
    switch (backend) {
      case 'local': return [...this.localStore.keys()].filter((k) => k.startsWith(prefix));
      case 'overlay': return [...this.overlayStore.keys()].filter((k) => k.startsWith(prefix));
      case 'store': return [...this.storeBackend.keys()].filter((k) => k.startsWith(prefix));
      case 'evidence': return this.evidenceLog.filter((e) => e.id.startsWith(prefix)).map((e) => e.id);
    }
  }

  getVersion(path: string): string {
    const backend = this.resolveBackend(path);
    const content = this.read(path);
    if (content === null) return '';
    if (backend === 'overlay') return this.overlayStore.get(path)?.version ?? '';
    return createHash('sha256').update(content).digest('hex');
  }

  // P2-16: Simple file-level lock (Phase 2 is single-agent)
  private acquireLock(path: string): void {
    const count = this.locks.get(path) ?? 0;
    if (count > 0) {
      throw new Error(`VFS: write conflict on '${path}' — file is locked by another operation`);
    }
    this.locks.set(path, 1);
  }

  private releaseLock(path: string): void {
    this.locks.set(path, Math.max(0, (this.locks.get(path) ?? 0) - 1));
  }

  // Evidence hash chain verification (P2-17)
  verifyEvidenceChain(): { valid: boolean; broken_at: number | null } {
    for (let i = 1; i < this.evidenceLog.length; i++) {
      if (this.evidenceLog[i].prev_hash !== this.evidenceLog[i - 1].hash) {
        return { valid: false, broken_at: i };
      }
    }
    return { valid: true, broken_at: null };
  }

  commitOverlay(): number {
    let count = 0;
    for (const [path, entry] of this.overlayStore) {
      this.localStore.set(path, entry.content);
      count++;
    }
    this.overlayStore.clear();
    return count;
  }

  discardOverlay(): void {
    this.overlayStore.clear();
  }
}
