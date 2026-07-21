/** AH-PA-VERTICAL-001: task list -> daily plan (no external action). */
export interface PAVerticalInput { tasks: { id: string; title: string; priority: 'high' | 'normal' | 'low'; duration_min: number }[]; available_minutes: number }
export interface PAVerticalOutput { plan: { task_id: string; title: string; slot: number }[]; unallocated: string[]; no_external_actions: boolean }

export async function runPAVertical(input: PAVerticalInput): Promise<PAVerticalOutput> {
  // greedy: high -> normal -> low, fit into available minutes
  const priorityOrder = { high: 0, normal: 1, low: 2 };
  const sorted = [...input.tasks].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  let remaining = input.available_minutes;
  const plan: { task_id: string; title: string; slot: number }[] = [];
  const unallocated: string[] = [];
  for (const t of sorted) {
    if (t.duration_min <= remaining) { plan.push({ task_id: t.id, title: t.title, slot: t.duration_min }); remaining -= t.duration_min; }
    else unallocated.push(t.id);
  }
  return { plan, unallocated, no_external_actions: true };
}
