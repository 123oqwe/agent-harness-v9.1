/**
 * AH-CODING-VERTICAL-001: read repo -> fix bug -> test -> diff.
 *
 * LLM-driven: the model reads the buggy file, identifies the bug, generates
 * the fix, then we apply it and run tests in the sandbox. The full chain is
 * Router → ModelGateway → Runtime → Tools → Sandbox → VFS → Evidence.
 */
import type { VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../../runtime/sandbox.js';
import { readFile } from '../../tools/read-file.js';
import { executeCommand } from '../../tools/execute-command.js';

export interface CodingVerticalInput {
  repo_path: string;
  bug_file: string;
  test_command: string[];
}
export interface CodingVerticalOutput {
  read_ok: boolean;
  original_code: string;
  llm_analysis: string;
  llm_fix: string;
  fix_applied: boolean;
  test_exit_code: number | null;
  test_stdout: string;
  diff_before: string;
  diff_after: string;
  bug_located_by_llm: boolean;
}

/** Model call interface — accepts any provider that returns text. */
export interface ModelCallFn {
  (systemPrompt: string, userPrompt: string): Promise<string>;
}

export async function runCodingVertical(
  vfs: VirtualFilesystem,
  sandbox: SandboxProfile,
  input: CodingVerticalInput,
  modelCall: ModelCallFn,
): Promise<CodingVerticalOutput> {
  // 1. Read the buggy file
  const before = await readFile(vfs, { path: input.bug_file });
  const original_code = before.content;

  // 2. LLM analyzes the code and generates a fix
  const analysisPrompt = `You are a coding agent. Read the following TypeScript code and identify any bugs. 
If there is a bug, output ONLY the corrected code. If there is no bug, output the code unchanged.

File: ${input.bug_file}
\`\`\`typescript
${original_code}
\`\`\``;

  const llm_response = await modelCall(
    'You are a coding agent that fixes bugs in TypeScript code. Output only the corrected code, no explanations.',
    analysisPrompt,
  );

  // 3. Extract the fix from LLM response (strip markdown code fences if present)
  const llm_fix = llm_response.replace(/```typescript\n?/g, '').replace(/```\n?/g, '').trim();
  const bug_located_by_llm = llm_fix !== original_code.trim();

  // 4. Apply the fix via VFS
  let fix_applied = false;
  if (bug_located_by_llm) {
    vfs.write(input.bug_file, llm_fix);
    fix_applied = true;
  }

  // 5. Run tests in the sandbox
  const test = await executeCommand(sandbox, { argv: input.test_command, cwd: sandbox.workspaceRoot });

  // 6. Read the final state for diff
  const after = await readFile(vfs, { path: input.bug_file });

  return {
    read_ok: true,
    original_code,
    llm_analysis: llm_response.slice(0, 500),
    llm_fix,
    fix_applied,
    test_exit_code: test.exit_code,
    test_stdout: test.stdout.slice(0, 1000),
    diff_before: original_code,
    diff_after: after.content,
    bug_located_by_llm,
  };
}
