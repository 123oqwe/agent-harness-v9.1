/** AH-TOOL-READ-001: read_file tool. Reads a file through VFS with size limit. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface ReadFileInput { path: string; max_bytes?: number }
export interface ReadFileOutput { path: string; content: string; bytes: number; truncated: boolean }

export async function readFile(vfs: VirtualFilesystem, input: ReadFileInput): Promise<ReadFileOutput> {
  const data = vfs.read(input.path);
  const max = input.max_bytes ?? 1_048_576; // 1 MiB default
  const truncated = data.length > max;
  return { path: input.path, content: data.subarray(0, max).toString('utf8'), bytes: data.length, truncated };
}
