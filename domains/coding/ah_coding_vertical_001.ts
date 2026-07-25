/**
 * AH-CODING-VERTICAL-001: read repo → fix bug → test → diff.
 *
 * Thin domain adapter. Converts domain input to TaskContract, calls the
 * unified Harness, converts the Outcome to domain output. Does NOT call
 * Provider, Tool, VFS or Sandbox directly.
 */
import type { TaskContract } from '../../contracts/index.js';
import type { Harness, HarnessOutcome } from '../../harness.js';

export interface CodingVerticalInput {
  repo_path: string;
  bug_file: string;
  test_command: string[];
}
export interface CodingVerticalOutput {
  read_ok: boolean;
  fix_applied: boolean;
  test_exit_code: number | null;
  diff_before: string;
  diff_after: string;
  bug_located: boolean;
  outcome: HarnessOutcome;
}

/**
 * Convert coding domain input to a TaskContract.
 * The Router will select plan_execute because the task involves writes + tests.
 */
export function codingTaskContract(input: CodingVerticalInput): TaskContract {
  return {
    goal: `Read the file ${input.bug_file}, locate the bug, fix it, then run ${input.test_command.join(' ')}`,
    success_criteria: [
      { criterion: 'bug file read and bug located', verification_method: 'deterministic' },
      { criterion: 'fix applied to file', verification_method: 'deterministic' },
      { criterion: 'tests pass', verification_method: 'test' },
      { criterion: 'diff generated', verification_method: 'deterministic' },
    ],
    constraints: [
      { type: 'tool_restriction', value: 'read_file,edit_file,execute_command' },
      { type: 'privacy', value: 'local_only' },
    ],
  };
}

/**
 * Run the coding vertical through the unified Harness.
 * The provider is a typed HarnessProvider, not a raw callback.
 */
export async function runCodingVertical(
  harness: Harness,
  input: CodingVerticalInput,
): Promise<CodingVerticalOutput> {
  const task = codingTaskContract(input);
  const outcome = await harness.run(task, `coding-${Date.now()}`);
  const observations = outcome.loop_result.turns.flatMap(
    (turn) => turn.tool_observations,
  );
  const read = observations.find(
    (observation) =>
      observation.name === 'read_file' &&
      observation.status === 'ok' &&
      (observation.result as { path?: unknown } | undefined)?.path ===
        input.bug_file,
  );
  const edit = observations.find(
    (observation) =>
      observation.name === 'edit_file' &&
      observation.status === 'ok' &&
      (observation.result as { path?: unknown } | undefined)?.path ===
        input.bug_file,
  );
  const test = observations.find(
    (observation) =>
      observation.name === 'execute_command' &&
      observation.status === 'ok' &&
      JSON.stringify(observation.arguments.argv) ===
        JSON.stringify(input.test_command) &&
      observation.arguments.cwd === input.repo_path,
  );
  const readResult = read?.result as
    | { content?: string; truncated?: boolean }
    | undefined;
  const editResult = edit?.result as { replacements?: number } | undefined;
  const testResult = test?.result as
    | { exit_code?: number | null; timed_out?: boolean }
    | undefined;
  const fileChange = outcome.evidence.workspace_changes.find(
    (change) => change.path === input.bug_file,
  );

  return {
    read_ok:
      read !== undefined &&
      typeof readResult?.content === 'string' &&
      readResult.truncated !== true,
    fix_applied:
      edit !== undefined &&
      (editResult?.replacements ?? 0) > 0 &&
      fileChange?.after_sha256 !== fileChange?.before_sha256,
    test_exit_code: testResult?.exit_code ?? null,
    diff_before: fileChange?.before_sha256 ?? '',
    diff_after: fileChange?.after_sha256 ?? '',
    bug_located:
      typeof readResult?.content === 'string' &&
      readResult.content.length > 0 &&
      (editResult?.replacements ?? 0) > 0,
    outcome,
  };
}
