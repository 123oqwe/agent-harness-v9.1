/**
 * AH-CODING-VERTICAL-001: read repo → fix bug → test → diff.
 *
 * Thin domain adapter. Converts domain input to TaskContract, calls the
 * unified Harness, converts the Outcome to domain output. Does NOT call
 * Provider, Tool, VFS or Sandbox directly.
 */
import type { TaskContract } from '../../../spec/types/task-contract.js';
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
      { type: 'tool_restriction', value: 'read_file,edit_file,execute_command_sandboxed' },
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

  // Extract domain-specific results from the session event log
  const events = outcome.session.getEvents();
  const toolCalls = events.filter(e => e.type === 'tool_call');
  const toolResults = events.filter(e => e.type === 'tool_result');

  const readEvents = toolCalls.filter(e => (e.data as { tool: string }).tool === 'read_file');
  const editEvent = toolCalls.find(e => (e.data as { tool: string }).tool === 'edit_file');
  const execResult = toolResults.find(e => (e.data as { tool: string }).tool === 'execute_command_sandboxed');

  // Extract file content from read_file results (before and after edit)
  const readResults = readEvents.map(e => {
    
    const resultEvent = toolResults.find(r => r.seq > e.seq);
    return resultEvent ? (resultEvent.data as { tool: string; result?: string }).result ?? '' : '';
  });
  const diff_before = readResults[0] ?? '';
  const diff_after = readResults.length > 1 ? readResults[readResults.length - 1]! : (editEvent ? diff_before : '');

  // Extract test exit code from execute_command result
  const execData = execResult?.data as { tool: string; result?: string } | undefined;
  let test_exit_code: number | null = null;
  if (execData?.result) {
    try { test_exit_code = JSON.parse(execData.result).exit_code ?? 0; } catch { test_exit_code = 0; }
  }

  return {
    read_ok: readEvents.length > 0,
    fix_applied: !!editEvent,
    test_exit_code,
    diff_before,
    diff_after,
    bug_located: !!editEvent,
    outcome,
  };
}
