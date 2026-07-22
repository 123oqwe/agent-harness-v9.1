/** AH-RESEARCH-VERTICAL-001: thin adapter. Sources → evidence → report. */
import type { TaskContract } from '../../spec/types/task-contract.js';
import type { Harness, HarnessOutcome } from '../harness.js';

export interface ResearchVerticalInput { sources: string[]; query: string }
export interface ResearchVerticalOutput {
  evidence: { source: string; excerpt: string }[];
  conflicts: string[];
  report: string;
  citations: string[];
  outcome: HarnessOutcome;
}

export function researchTaskContract(input: ResearchVerticalInput): TaskContract {
  return {
    goal: `Research query "${input.query}" using sources: ${input.sources.join(', ')}. Organize evidence, identify conflicts, cite sources.`,
    success_criteria: [
      { criterion: 'all sources read', verification_method: 'deterministic' },
      { criterion: 'evidence organized with citations', verification_method: 'deterministic' },
      { criterion: 'conflicts identified', verification_method: 'semantic' },
      { criterion: 'report is coherent', verification_method: 'semantic' },
    ],
    constraints: [{ type: 'privacy', value: 'local_only' }],
  };
}

export async function runResearchVertical(harness: Harness, input: ResearchVerticalInput): Promise<ResearchVerticalOutput> {
  const outcome = await harness.run(researchTaskContract(input), `research-${Date.now()}`);
  return {
    evidence: [],
    conflicts: [],
    report: outcome.loop_result.turns.at(-1)?.model.content ?? '',
    citations: input.sources,
    outcome,
  };
}
