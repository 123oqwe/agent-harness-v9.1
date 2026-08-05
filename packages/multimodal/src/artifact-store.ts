/**
 * AH-MM-ARTIFACT-001: Store multimodal artifacts with provenance.
 */
import type { MultimodalArtifact } from './types.js';

const MAX_ARTIFACTS = 1000;
const MAX_DATA_BYTES = 256 * 1024 * 1024; // 256 MB total budget

const store = new Map<string, { artifact: MultimodalArtifact; data: Buffer }>();
let totalDataBytes = 0;

function evictOldest(): void {
  if (store.size === 0) return;
  const oldest = store.keys().next().value;
  if (oldest !== undefined) {
    const entry = store.get(oldest);
    if (entry) totalDataBytes -= entry.data.byteLength;
    store.delete(oldest);
  }
}

export function storeArtifact(artifact: MultimodalArtifact, data: Buffer): void {
  if (!artifact?.artifact_id || typeof artifact.artifact_id !== 'string') {
    throw new TypeError('artifact.artifact_id is required');
  }
  if (!Buffer.isBuffer(data)) {
    throw new TypeError('data must be a Buffer');
  }
  // Evict existing entry if overwriting
  const existing = store.get(artifact.artifact_id);
  if (existing) {
    totalDataBytes -= existing.data.byteLength;
  }
  // Enforce max size and byte budget
  while ((store.size >= MAX_ARTIFACTS || totalDataBytes + data.byteLength > MAX_DATA_BYTES) && store.size > 0) {
    evictOldest();
  }
  store.set(artifact.artifact_id, { artifact, data });
  totalDataBytes += data.byteLength;
}

export function retrieveArtifact(id: string): { artifact: MultimodalArtifact; data: Buffer } | undefined {
  const entry = store.get(id);
  if (!entry) return undefined;
  // Return a copy to prevent mutation of stored data
  return { artifact: entry.artifact, data: Buffer.from(entry.data) };
}

export function listArtifacts(type?: MultimodalArtifact['type']): readonly MultimodalArtifact[] {
  const all = [...store.values()].map(v => v.artifact);
  return type ? all.filter(a => a.type === type) : all;
}

export function deleteArtifact(id: string): boolean {
  const entry = store.get(id);
  if (entry) totalDataBytes -= entry.data.byteLength;
  return store.delete(id);
}

export function getArtifactCount(): number {
  return store.size;
}

export function getArtifactDataBytes(): number {
  return totalDataBytes;
}

export function clearAllArtifacts(): void {
  store.clear();
  totalDataBytes = 0;
}
