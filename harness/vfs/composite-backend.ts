/**
 * AH-VFS-002: Composite Backend Routing + Concurrency Control (P2-15, P2-16, P2-17)
 */
import { createHash } from 'node:crypto';

export type BackendType = 'local' | 'overlay' | 'store' | 'evidence';
export interface BackendRoute { prefix: string; backend: BackendType }
export const DEFAULT_ROUTES: BackendRoute[] = [
  { prefix: '/workspace/', backend: 'local' }, { prefix: '/scratch/', backend: 'overlay' },
  { prefix: '/memories/', backend: 'store' }, { prefix: '/evidence/', backend: 'evidence' },
];

export class CompositeBackend {
  private readonly routes: BackendRoute[];
  private readonly localStore = new Map<string, string>();
  private readonly overlayStore = new Map<string, { content: string; version: string }>();
  private readonly storeBackend = new Map<string, string>();
  private readonly evidenceLog: { id: string; content: string; hash: string; prev_hash: string }[] = [];
  private readonly locks = new Map<string, number>();

  constructor(routes: BackendRoute[] = DEFAULT_ROUTES) { this.routes = routes; }

  resolveBackend(path: string): BackendType {
    for (const r of this.routes) if (path.startsWith(r.prefix)) return r.backend;
    return 'local';
  }

  read(path: string): string | null {
    const b = this.resolveBackend(path);
    switch (b) {
      case 'local': return this.localStore.get(path) ?? null;
      case 'overlay': return this.overlayStore.get(path)?.content ?? this.localStore.get(path) ?? null;
      case 'store': return this.storeBackend.get(path) ?? null;
      case 'evidence': return this.evidenceLog.find(e => e.id === path)?.content ?? null;
    }
  }

  write(path: string, content: string): void {
    this.locks.set(path, (this.locks.get(path) ?? 0) + 1);
    if (this.locks.get(path)! > 1) throw new Error(`VFS: write conflict on '${path}'`);
    try {
      const b = this.resolveBackend(path);
      switch (b) {
        case 'local': this.localStore.set(path, content); break;
        case 'overlay': this.overlayStore.set(path, { content, version: createHash('sha256').update(content).digest('hex') }); break;
        case 'store': this.storeBackend.set(path, content); break;
        case 'evidence': {
          const prevHash = this.evidenceLog.length > 0 ? this.evidenceLog[this.evidenceLog.length - 1]!.hash : '';
          const hash = createHash('sha256').update(content + prevHash).digest('hex');
          this.evidenceLog.push({ id: path, content, hash, prev_hash: prevHash });
          break;
        }
      }
    } finally { this.locks.set(path, Math.max(0, (this.locks.get(path) ?? 0) - 1)); }
  }

  delete(path: string): boolean {
    const b = this.resolveBackend(path);
    switch (b) {
      case 'local': return this.localStore.delete(path);
      case 'overlay': return this.overlayStore.delete(path);
      case 'store': return this.storeBackend.delete(path);
      case 'evidence': return false; // WORM
    }
  }

  getVersion(path: string): string {
    const c = this.read(path);
    return c === null ? '' : createHash('sha256').update(c).digest('hex');
  }

  verifyEvidenceChain(): { valid: boolean; broken_at: number | null } {
    for (let i = 1; i < this.evidenceLog.length; i++) if (this.evidenceLog[i]!.prev_hash !== this.evidenceLog[i - 1]!.hash) return { valid: false, broken_at: i };
    return { valid: true, broken_at: null };
  }

  commitOverlay(): number {
    let count = 0;
    for (const [path, entry] of this.overlayStore) { this.localStore.set(path, entry.content); count++; }
    this.overlayStore.clear();
    return count;
  }

  discardOverlay(): void { this.overlayStore.clear(); }
}
