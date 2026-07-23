/** AH-TOOL-005: write_file - overlay-only write with version enforcement */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface WriteFileInput {
  path: string;
  content: string;
  expected_version?: string;
}

export interface WriteFileResult {
  path: string;
  version: string;
  size: number;
}

export function writeFile(vfs: VirtualFilesystem, input: WriteFileInput): WriteFileResult {
  vfs.write(input.path, input.content, { expectedVersion: input.expected_version });
  const version = vfs.getVersion(input.path);
  return { path: input.path, version, size: input.content.length };
}
