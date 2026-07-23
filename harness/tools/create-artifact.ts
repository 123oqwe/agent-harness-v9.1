/** AH-TOOL-001: create_artifact - writes a typed artifact through VFS */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { createHash } from 'node:crypto';

export interface CreateArtifactInput {
  path: string;
  content: string;
  artifact_type: string;
}

export interface CreateArtifactResult {
  path: string;
  digest: string;
  artifact_type: string;
  size: number;
}

export function createArtifact(vfs: VirtualFilesystem, input: CreateArtifactInput): CreateArtifactResult {
  vfs.write(input.path, input.content);
  const digest = createHash('sha256').update(input.content).digest('hex');
  return { path: input.path, digest, artifact_type: input.artifact_type, size: input.content.length };
}
