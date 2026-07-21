/** AH-PLANNING-VERTICAL-001: goal+constraints -> plan -> validate DAG (no cycles). */
export interface PlanningVerticalInput { goal: string; tasks: { id: string; depends_on: string[] }[] }
export interface PlanningVerticalOutput { plan: string[]; valid: boolean; cycles: string[][]; feasible: boolean }

export async function runPlanningVertical(input: PlanningVerticalInput): Promise<PlanningVerticalOutput> {
  // topological sort with cycle detection
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();
  for (const t of input.tasks) { inDegree.set(t.id, 0); graph.set(t.id, []); }
  for (const t of input.tasks) for (const dep of t.depends_on) { graph.get(dep)?.push(t.id); inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1); }
  const queue: string[] = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const plan: string[] = [];
  const cycles: string[][] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    plan.push(id);
    for (const next of graph.get(id) ?? []) { inDegree.set(next, (inDegree.get(next) ?? 0) - 1); if (inDegree.get(next) === 0) queue.push(next); }
  }
  const valid = plan.length === input.tasks.length;
  if (!valid) {
    // find cycle nodes
    const remaining = input.tasks.filter(t => !plan.includes(t.id)).map(t => t.id);
    cycles.push(remaining);
  }
  return { plan, valid, cycles, feasible: valid };
}
