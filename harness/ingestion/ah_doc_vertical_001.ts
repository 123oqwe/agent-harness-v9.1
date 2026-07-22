/** AH-DOC-VERTICAL-001: thin adapter. Read doc → summarize → cite pages. */
import type { TaskContract } from '../../spec/types/task-contract.js';
import type { Harness, HarnessOutcome } from '../harness.js';

export interface DocVerticalInput { path: string; max_pages?: number }
export interface DocVerticalOutput {
  summary: string;
  citations: { page: number; excerpt: string }[];
  outcome: HarnessOutcome;
}

export function docTaskContract(input: DocVerticalInput): TaskContract {
  return {
    goal: `Read document at ${input.path}, extract text, summarize content, cite page numbers`,
    success_criteria: [
      { criterion: 'document parsed and text extracted', verification_method: 'deterministic' },
      { criterion: 'summary mentions key content', verification_method: 'semantic' },
      { criterion: 'citations reference correct page numbers', verification_method: 'deterministic' },
    ],
    constraints: [{ type: 'privacy', value: 'local_only' }],
  };
}

export async function runDocVertical(harness: Harness, input: DocVerticalInput): Promise<DocVerticalOutput> {
  const outcome = await harness.run(docTaskContract(input), `doc-${Date.now()}`);
  return {
    summary: outcome.loop_result.turns.at(-1)?.model.content ?? '',
    citations: [],
    outcome,
  };
}
