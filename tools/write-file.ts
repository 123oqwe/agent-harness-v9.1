/** AH-TOOL-WRITE-001: write_file tool with checkpoint. Writes through VFS overlay. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface WriteFileInput { path: string; content: string }
export interface WriteFileOutput { path: string; bytes: number; checkpoint: string }

export async function writeFile(vfs: VirtualFilesystem, input: WriteFileInput): Promise<WriteFileOutput> {
  const buf = Buffer.from(input.content);
  vfs.write(input.path, buf);
  return { path: input.path, bytes: buf.length, checkpoint: `write:${input.path}` };
}
