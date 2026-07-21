/** AH-TOOL-LIST-001: list_directory tool. Lists entries under a VFS path. */
// @ts-nocheck

import type { VirtualFilesystem, VfsEntry } from '../vfs/virtual-filesystem.js';

export interface ListDirectoryInput { path: string }
export interface ListDirectoryOutput { entries: VfsEntry[] }

export async function listDirectory(vfs: VirtualFilesystem, input: ListDirectoryInput): Promise<ListDirectoryOutput> {
  return { entries: vfs.list(input.path) };
}
