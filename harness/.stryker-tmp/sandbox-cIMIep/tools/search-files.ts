/** AH-TOOL-SEARCH-001: search_files tool. Searches file contents via VFS. */
// @ts-nocheck

import type { VirtualFilesystem, VfsEntry } from '../vfs/virtual-filesystem.js';

export interface SearchFilesInput { root: string; needle: string; max_results?: number }
export interface SearchFilesOutput { matches: VfsEntry[]; truncated: boolean }

export async function searchFiles(vfs: VirtualFilesystem, input: SearchFilesInput): Promise<SearchFilesOutput> {
  const all = vfs.search(input.root, input.needle);
  const max = input.max_results ?? 100;
  return { matches: all.slice(0, max), truncated: all.length > max };
}
