/** AH-PLANNING-001: Planning vertical - normalize goal, build DAG, reject cycles */
import type { PlanStep } from '../runtime/plan-execute.js';

export interface PlanningVerticalInput {
  goal: string;
  constraints: string[];
  tasks: { id: string; name: string; dependencies: string[] }[];
}

export interface PlanningVerticalResult {
  plan: PlanStep[];
  valid: boolean;
  cycle_detected: boolean;
  rejected_tasks: string[];
}

export function runPlanningVertical(input: PlanningVerticalInput): PlanningVerticalResult {
  const steps: PlanStep[] = input.tasks.map((t) => ({
    id: t.id,
    tool_name: 'create_artifact',
    arguments: { name: t.name },
    dependencies: t.dependencies,
  }));

  // Detect cycles
  const visited = new Set<string>();
  const stack = new Set<string>();
  let cycleFound = false;

  const dfs = (id: string) => {
    if (stack.has(id)) { cycleFound = true; return; }
    if (visited.has(id)) return;
    visited.add(id);
    stack.add(id);
    const step = steps.find((s) => s.id === id);
    if (step) for (const dep of step.dependencies) dfs(dep);
    stack.delete(id);
  };

  for (const step of steps) dfs(step.id);

  const rejected: string[] = [];
  if (cycleFound) {
    return { plan: [], valid: false, cycle_detected: true, rejected_tasks: steps.map((s) => s.id) };
  }

  return { plan: steps, valid: true, cycle_detected: false, rejected_tasks: rejected };
}
