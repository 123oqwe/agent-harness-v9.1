/** AH-PLANNING-VERTICAL-001: thin adapter. Goal+constraints → plan → validate DAG. */
import type { TaskContract } from '../contracts/index.js';
import type { Harness, HarnessOutcome } from '../harness.js';

export interface PlanningVerticalInput { goal: string; tasks: { id: string; depends_on: string[] }[] }
export interface PlanningVerticalOutput {
  plan: string[];
  valid: boolean;
  cycles: string[][];
  feasible: boolean;
  outcome: HarnessOutcome;
}

export class PlanningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningInputError';
  }
}

function unknownDependencies(
  input: PlanningVerticalInput,
): Array<{ task: string; dependency: string }> {
  const ids = new Set(input.tasks.map((task) => task.id));
  return input.tasks.flatMap((task) =>
    task.depends_on
      .filter((dependency) => !ids.has(dependency))
      .map((dependency) => ({ task: task.id, dependency })),
  );
}

function findCycles(
  tasks: PlanningVerticalInput['tasks'],
): string[][] {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.depends_on]]),
  );
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (state.get(dependency) === 'visiting') {
        const start = stack.indexOf(dependency);
        const cycle = [...stack.slice(start), dependency];
        const members = [...new Set(cycle.slice(0, -1))].sort();
        const key = members.join('\0');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (state.get(dependency) !== 'done') {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const task of tasks) visit(task.id);
  return cycles;
}

export function planningTaskContract(input: PlanningVerticalInput): TaskContract {
  const ids = input.tasks.map((task) => task.id);
  if (ids.some((id) => id.trim() === '') || new Set(ids).size !== ids.length) {
    throw new PlanningInputError('task IDs must be non-empty and unique');
  }
  const unknown = unknownDependencies(input);
  if (unknown.length > 0) {
    throw new PlanningInputError(
      `unknown dependencies: ${unknown
        .map((entry) => `${entry.task}->${entry.dependency}`)
        .join(', ')}`,
    );
  }
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
  const cycles = findCycles(input.tasks);
  const valid = sorted.length === input.tasks.length && cycles.length === 0;
  // feasible = no cycles AND all tasks in plan
  const plan = valid ? sorted : [];
  const feasible = valid && outcome.success;

  return {
    plan: valid ? sorted : plan,
    valid,
    cycles,
    feasible,
    outcome,
  };
}
