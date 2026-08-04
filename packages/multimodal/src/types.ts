import { createHash } from 'node:crypto';

export interface MultimodalArtifact {
  readonly artifact_id: string;
  readonly type: 'image' | 'audio' | 'video' | 'document';
  readonly mime_type: string;
  readonly byte_size: number;
  readonly content_hash: string;
  readonly created_at: string;
  readonly provenance: MultimodalProvenance;
}

export interface MultimodalProvenance {
  readonly source: 'generated' | 'edited' | 'input' | 'verified';
  readonly generator?: string;
  readonly input_artifacts?: readonly string[];
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export class MultimodalUnavailableError extends Error {
  constructor(message: string, readonly reason: 'no_credentials' | 'not_implemented' | 'provider_unavailable') {
    super(message);
    this.name = 'MultimodalUnavailableError';
    Object.setPrototypeOf(this, MultimodalUnavailableError.prototype);
  }
}

export function computeContentHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function createArtifact(
  type: MultimodalArtifact['type'],
  mimeType: string,
  data: Buffer,
  provenance: MultimodalProvenance,
): MultimodalArtifact {
  return {
    artifact_id: computeContentHash(data).slice(0, 32),
    type,
    mime_type: mimeType,
    byte_size: data.byteLength,
    content_hash: computeContentHash(data),
    created_at: new Date().toISOString(),
    provenance,
  };
}
