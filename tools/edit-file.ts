/** AH-TOOL-EDIT-001: edit_file tool with checkpoint. Reads, applies replacement, writes. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface EditFileInput { path: string; find: string; replace: string }
export interface EditFileOutput { path: string; bytes: number; replacements: number; checkpoint: string }

export async function editFile(vfs: VirtualFilesystem, input: EditFileInput): Promise<EditFileOutput> {
  const original = vfs.readText(input.path);
  if (input.find.length === 0) {
    throw new Error('edit_file: find must not be empty');
  }
  if (input.find === input.replace) {
    throw new Error('edit_file: replacement must change the file');
  }
  let find = input.find;
  let replace = input.replace;
  let parts = original.split(find);
  let replacements = parts.length - 1;
  if (replacements === 0) {
    const trimmedFind = find.trim();
    if (trimmedFind.length === 0 || trimmedFind === find) {
      throw new Error(`edit_file: pattern not found in ${input.path}`);
    }
    parts = original.split(trimmedFind);
    replacements = parts.length - 1;
    if (replacements === 0) {
      throw new Error(`edit_file: pattern not found in ${input.path}`);
    }
    if (replacements > 1) {
      throw new Error(
        `edit_file: whitespace-trimmed pattern is ambiguous in ${input.path}`,
      );
    }
    find = trimmedFind;
    replace = replace.trim();
  }
  const updated = original.split(find).join(replace);
  if (updated === original) {
    throw new Error('edit_file: replacement must change the file');
  }
  vfs.edit(input.path, updated);
  return { path: input.path, bytes: Buffer.byteLength(updated), replacements, checkpoint: `edit:${input.path}` };
}
