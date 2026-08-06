/**
 * AH-TOOL-APPLY-PATCH-001: Multi-hunk file editing tool.
 *
 * Applies structured hunks to files via VFS. Each hunk specifies a file,
 * a starting line number, the expected old lines (context verification),
 * and the replacement new lines. Supports editing multiple files and
 * multiple regions in a single call.
 */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface ApplyPatchHunk {
  file: string;
  old_start: number;
  old_lines: string[];
  new_lines: string[];
}

export interface ApplyPatchInput {
  hunks: ApplyPatchHunk[];
}

export interface ApplyPatchOutput {
  applied: Array<{ file: string; hunks_applied: number }>;
  bytes_changed: number;
}

export class ApplyPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyPatchError';
    Object.setPrototypeOf(this, ApplyPatchError.prototype);
  }
}

/**
 * Group hunks by file, then apply within each file in reverse order
 * (by old_start descending) so earlier line numbers are unaffected by
 * later replacements.
 */
export async function applyPatch(
  vfs: VirtualFilesystem,
  input: ApplyPatchInput,
): Promise<ApplyPatchOutput> {
  if (!input.hunks || input.hunks.length === 0) {
    throw new ApplyPatchError('apply_patch requires at least one hunk');
  }

  // Group by file
  const byFile = new Map<string, ApplyPatchHunk[]>();
  for (const hunk of input.hunks) {
    if (!hunk.file || hunk.file.length === 0) {
      throw new ApplyPatchError('hunk.file is required');
    }
    if (!Array.isArray(hunk.old_lines) || !Array.isArray(hunk.new_lines)) {
      throw new ApplyPatchError('hunk old_lines and new_lines must be arrays');
    }
    if (!Number.isSafeInteger(hunk.old_start) || hunk.old_start < 1) {
      throw new ApplyPatchError(`hunk old_start must be a positive integer: ${hunk.old_start}`);
    }
    const list = byFile.get(hunk.file) ?? [];
    list.push(hunk);
    byFile.set(hunk.file, list);
  }

  const applied: Array<{ file: string; hunks_applied: number }> = [];
  let totalBytesChanged = 0;

  for (const [file, hunks] of byFile) {
    // Sort by old_start descending so we edit from bottom to top
    const sorted = [...hunks].sort((a, b) => b.old_start - a.old_start);
    const original = vfs.readText(file);
    const lines = original.split('\n');
    let bytesChanged = 0;

    for (const hunk of sorted) {
      const startIdx = hunk.old_start - 1; // convert 1-based to 0-based
      if (startIdx < 0 || startIdx + hunk.old_lines.length > lines.length) {
        throw new ApplyPatchError(
          `hunk range out of bounds for ${file}: start=${hunk.old_start}, old_lines=${hunk.old_lines.length}, file_lines=${lines.length}`,
        );
      }
      // Context verification: old_lines must match existing content
      for (let i = 0; i < hunk.old_lines.length; i++) {
        if (lines[startIdx + i] !== hunk.old_lines[i]) {
          throw new ApplyPatchError(
            `hunk context mismatch in ${file} at line ${hunk.old_start + i}: expected ${JSON.stringify(hunk.old_lines[i])}, got ${JSON.stringify(lines[startIdx + i])}`,
          );
        }
      }
      // Replace old_lines with new_lines
      const before = lines.slice(startIdx, startIdx + hunk.old_lines.length).join('\n');
      const after = hunk.new_lines.join('\n');
      bytesChanged += Math.abs(Buffer.byteLength(after) - Buffer.byteLength(before));
      lines.splice(startIdx, hunk.old_lines.length, ...hunk.new_lines);
    }

    const updated = lines.join('\n');
    if (updated !== original) {
      vfs.edit(file, updated);
    }
    applied.push({ file, hunks_applied: hunks.length });
    totalBytesChanged += bytesChanged;
  }

  return { applied, bytes_changed: totalBytesChanged };
}
