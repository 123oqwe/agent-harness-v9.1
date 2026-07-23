/** AH-TOOL-003: list_directory - bounded VFS entries with ordering and pagination */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface ListDirectoryInput {
  path: string;
  limit?: number;
  offset?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: string[];
  total: number;
  has_more: boolean;
}

export function listDirectory(vfs: VirtualFilesystem, input: ListDirectoryInput): ListDirectoryResult {
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const all = vfs.list(input.path).sort();
  const total = all.length;
  const entries = all.slice(offset, offset + limit);
  return { path: input.path, entries, total, has_more: offset + limit < total };
}
