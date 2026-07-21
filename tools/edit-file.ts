/** AH-TOOL-EDIT-001: edit_file tool with checkpoint. Reads, applies replacement, writes. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface EditFileInput { path: string; find: string; replace: string }
export interface EditFileOutput { path: string; bytes: number; replacements: number; checkpoint: string }

export async function editFile(vfs: VirtualFilesystem, input: EditFileInput): Promise<EditFileOutput> {
  const original = vfs.readText(input.path);
  const parts = original.split(input.find);
  const replacements = parts.length - 1;
  if (replacements === 0) throw new Error(`edit_file: pattern not found in ${input.path}`);
  const updated = parts.join(input.replace);
  vfs.edit(input.path, updated);
  return { path: input.path, bytes: Buffer.byteLength(updated), replacements, checkpoint: `edit:${input.path}` };
}
