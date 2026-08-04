/**
 * AH-MM-ARTIFACT-001: Store multimodal artifacts with provenance.
 */
import type { MultimodalArtifact } from './types.js';

const store = new Map<string, { artifact: MultimodalArtifact; data: Buffer }>();

export function storeArtifact(artifact: MultimodalArtifact, data: Buffer): void {
  store.set(artifact.artifact_id, { artifact, data });
}

export function retrieveArtifact(id: string): { artifact: MultimodalArtifact; data: Buffer } | undefined {
  return store.get(id);
}

export function listArtifacts(type?: MultimodalArtifact['type']): readonly MultimodalArtifact[] {
  const all = [...store.values()].map(v => v.artifact);
  return type ? all.filter(a => a.type === type) : all;
}

export function deleteArtifact(id: string): boolean {
  return store.delete(id);
}

export function getArtifactCount(): number {
  return store.size;
}
