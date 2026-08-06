/** AH-TOOL-READ-001: read_file tool. Reads a file through VFS with size limit. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface ReadFileInput { path: string; max_bytes?: number }
export interface ReadFileInput { path: string; max_bytes?: number; encoding?: 'utf8' | 'base64' }
export interface ReadFileOutput { path: string; content: string; bytes: number; truncated: boolean; encoding?: string }

export async function readFile(vfs: VirtualFilesystem, input: ReadFileInput): Promise<ReadFileOutput> {
  const data = vfs.read(input.path);
  const max = input.max_bytes ?? 1_048_576; // 1 MiB default
  const truncated = data.length > max;
  const encoding = input.encoding ?? 'utf8';
  const sliced = data.subarray(0, max);
  const content = encoding === 'base64' ? sliced.toString('base64') : sliced.toString('utf8');
  return { path: input.path, content, bytes: data.length, truncated, encoding };
}
