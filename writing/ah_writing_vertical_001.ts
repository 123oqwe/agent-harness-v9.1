/** AH-WRITING-VERTICAL-001: thin adapter. Brief → draft → self-check → output. */
import type { TaskContract } from '../../spec/types/task-contract.js';
import type { Harness, HarnessOutcome } from '../harness.js';

export interface WritingVerticalInput { brief: string; requirements: string[] }
export interface WritingVerticalOutput {
  draft: string;
  self_check: { requirement: string; met: boolean }[];
  output: string;
  outcome: HarnessOutcome;
}

export function writingTaskContract(input: WritingVerticalInput): TaskContract {
  return {
    goal: `Compose a draft based on brief: ${input.brief}. Requirements: ${input.requirements.join('; ')}`,
    success_criteria: input.requirements.map(r => ({ criterion: r, verification_method: 'semantic' as const })),
    constraints: [{ type: 'privacy', value: 'local_only' }],
  };
}

export async function runWritingVertical(harness: Harness, input: WritingVerticalInput): Promise<WritingVerticalOutput> {
  const outcome = await harness.run(writingTaskContract(input), `writing-${Date.now()}`);
  const draft = outcome.loop_result.turns.at(-1)?.model.content ?? '';
  const self_check = input.requirements.map(r => ({ requirement: r, met: draft.toLowerCase().includes(r.toLowerCase().split(' ')[0]!) }));
  return { draft, self_check, output: draft, outcome };
}
