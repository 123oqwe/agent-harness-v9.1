/** AH-TOOL-006: edit_file - exact patch with stale-content conflict detection */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface EditFileInput {
  path: string;
  old_text: string;
  new_text: string;
  expected_version?: string;
}

export interface EditFileResult {
  path: string;
  version: string;
  edits_applied: number;
}

export function editFile(vfs: VirtualFilesystem, input: EditFileInput): EditFileResult {
  const content = vfs.read(input.path);
  if (content === null) {
    throw new Error(`File not found: ${input.path}`);
  }

  if (!content.includes(input.old_text)) {
    throw new Error(`Stale content conflict: old_text not found in file (file may have been modified)`);
  }

  const newContent = content.replace(input.old_text, input.new_text);
  vfs.write(input.path, newContent, { expectedVersion: input.expected_version });
  const version = vfs.getVersion(input.path);
  return { path: input.path, version, edits_applied: 1 };
}
