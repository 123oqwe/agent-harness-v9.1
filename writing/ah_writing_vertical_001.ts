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
  const draftLower = draft.toLowerCase();
  const self_check = input.requirements.map(r => {
    // Check if the requirement is addressed: all significant words present
    const words = r.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matched = words.filter(w => draftLower.includes(w)).length;
    const met = words.length === 0 || matched / words.length >= 0.6;
    return { requirement: r, met };
  });
  const allMet = self_check.every(s => s.met);
  const output = allMet ? draft : draft + '\n\n[WARNING: some requirements may need further work]';
  return { draft, self_check, output, outcome };
}
