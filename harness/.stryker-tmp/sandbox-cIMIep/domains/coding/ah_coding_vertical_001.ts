/** AH-CODING-VERTICAL-001: read repo -> fix bug -> test -> diff. Reuses Router+Runtime+Session+tools. */
// @ts-nocheck

import type { VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../../runtime/sandbox.js';
import { readFile } from '../../tools/read-file.js';
import { editFile } from '../../tools/edit-file.js';
import { executeCommand } from '../../tools/execute-command.js';

export interface CodingVerticalInput {
  repo_path: string;       // VFS path to the repo
  bug_file: string;        // file containing the bug
  bug_pattern: string;     // text to find (the bug)
  fix: string;             // replacement text
  test_command: string[];  // argv to run tests
}
export interface CodingVerticalOutput {
  read_ok: boolean;
  edited: boolean;
  test_exit_code: number | null;
  diff_before: string;
  diff_after: string;
  bug_located: boolean;
}

export async function runCodingVertical(
  vfs: VirtualFilesystem, sandbox: SandboxProfile, input: CodingVerticalInput,
): Promise<CodingVerticalOutput> {
  // 1. read repo
  const before = await readFile(vfs, { path: input.bug_file });
  const bug_located = before.content.includes(input.bug_pattern);
  // 2. fix bug
  let edited = false;
  if (bug_located) {
    await editFile(vfs, { path: input.bug_file, find: input.bug_pattern, replace: input.fix });
    edited = true;
  }
  // 3. run tests
  const test = await executeCommand(sandbox, { argv: input.test_command, cwd: sandbox.workspaceRoot });
  // 4. diff
  const after = await readFile(vfs, { path: input.bug_file });
  return { read_ok: true, edited, test_exit_code: test.exit_code, diff_before: before.content, diff_after: after.content, bug_located };
}
