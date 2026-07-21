/** AH-TOOL-ARTIFACT-001: create_artifact tool. Stores an artifact in VFS evidence backend. */
// @ts-nocheck

import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { createHash } from 'node:crypto';

export interface CreateArtifactInput { path: string; content: string; content_type?: string }
export interface CreateArtifactOutput { path: string; bytes: number; sha256: string }

export async function createArtifact(vfs: VirtualFilesystem, input: CreateArtifactInput): Promise<CreateArtifactOutput> {
  const buf = Buffer.from(input.content, 'utf8');
  vfs.write(input.path, buf);
  return { path: input.path, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}
