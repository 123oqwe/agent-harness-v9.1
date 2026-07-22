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

  // Extract plan from model output
  const modelOutput = outcome.loop_result.turns.at(-1)?.model.content ?? '';
  const plan = modelOutput.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

  // Real DAG validation: topological sort with cycle detection
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();
  for (const t of input.tasks) { inDegree.set(t.id, 0); graph.set(t.id, []); }
  for (const t of input.tasks) for (const dep of t.depends_on) { graph.get(dep)?.push(t.id); inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1); }
  const queue: string[] = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const sorted: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const next of graph.get(id) ?? []) { inDegree.set(next, (inDegree.get(next) ?? 0) - 1); if (inDegree.get(next) === 0) queue.push(next); }
  }
  const valid = sorted.length === input.tasks.length;
  const cycles = valid ? [] : [input.tasks.filter(t => !sorted.includes(t.id)).map(t => t.id)];
  // feasible = no cycles AND all tasks in plan
  const feasible = valid && input.tasks.every(t => plan.some(p => p.includes(t.id)));

  return {
    plan: valid ? sorted : plan,
    valid,
    cycles,
    feasible,
    outcome,
  };
}
