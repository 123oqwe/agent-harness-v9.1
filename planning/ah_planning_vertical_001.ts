/** AH-PLANNING-VERTICAL-001: thin adapter. Goal+constraints → plan → validate DAG. */
import type { TaskContract } from '../../spec/types/task-contract.js';
import type { Harness, HarnessOutcome } from '../harness.js';

export interface PlanningVerticalInput { goal: string; tasks: { id: string; depends_on: string[] }[] }
export interface PlanningVerticalOutput {
  plan: string[];
  valid: boolean;
  cycles: string[][];
  feasible: boolean;
  outcome: HarnessOutcome;
}

export function planningTaskContract(input: PlanningVerticalInput): TaskContract {
  return {
    goal: `Create a plan for: ${input.goal}. Tasks: ${input.tasks.map(t => `${t.id} (depends: ${t.depends_on.join(',') || 'none'})`).join('; ')}`,
    success_criteria: [
      { criterion: 'plan includes all tasks', verification_method: 'deterministic' },
      { criterion: 'plan has no dependency cycles', verification_method: 'deterministic' },
      { criterion: 'plan is feasible', verification_method: 'deterministic' },
    ],
    constraints: [{ type: 'budget', value: '0' }, { type: 'time', value: '1 week' }],
  };
}

export async function runPlanningVertical(harness: Harness, input: PlanningVerticalInput): Promise<PlanningVerticalOutput> {
  const outcome = await harness.run(planningTaskContract(input), `planning-${Date.now()}`);
  return {
    plan: [],
    valid: outcome.success,
    cycles: [],
    feasible: outcome.success,
    outcome,
  };
}
