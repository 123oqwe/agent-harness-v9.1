/** AH-TOOL-004: read_file - bounded range reads through VFS */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
  encoding?: 'utf8' | 'binary';
}

export interface ReadFileResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export function readFile(vfs: VirtualFilesystem, input: ReadFileInput): ReadFileResult {
  if (input.encoding === 'binary') {
    throw new Error('Binary reads are not supported in Phase 1');
  }
  const content = vfs.read(input.path);
  if (content === null) {
    throw new Error(`File not found: ${input.path}`);
  }
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 65536;
  const truncated = content.length > offset + limit;
  const sliced = content.slice(offset, offset + limit);
  return { path: input.path, content: sliced, size: content.length, truncated };
}
