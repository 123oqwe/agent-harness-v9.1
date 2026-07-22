/** AH-PA-VERTICAL-001: task list -> LLM daily plan (no external action). */
export interface PAVerticalInput { tasks: { id: string; title: string; priority: 'high' | 'normal' | 'low'; duration_min: number }[]; available_minutes: number }
export interface PAVerticalOutput { plan: { task_id: string; title: string; slot: number }[]; unallocated: string[]; no_external_actions: boolean; llm_plan?: string }

export type ModelCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export async function runPAVertical(
  input: PAVerticalInput,
  modelCall?: ModelCallFn,
): Promise<PAVerticalOutput> {
  let llm_plan: string | undefined;
  if (modelCall) {
    llm_plan = await modelCall(
      'You are a personal assistant. Create a daily plan fitting the available time. No external actions (no email, calendar, or sending).',
      `Available: ${input.available_minutes} minutes\nTasks: ${input.tasks.map(t => `${t.id}: ${t.title} (${t.priority}, ${t.duration_min}min)`).join('; ')}`,
    );
  }

  const priorityOrder = { high: 0, normal: 1, low: 2 };
  const sorted = [...input.tasks].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  let remaining = input.available_minutes;
  const plan: { task_id: string; title: string; slot: number }[] = [];
  const unallocated: string[] = [];
  for (const t of sorted) {
    if (t.duration_min <= remaining) { plan.push({ task_id: t.id, title: t.title, slot: t.duration_min }); remaining -= t.duration_min; }
    else unallocated.push(t.id);
  }
  const result: PAVerticalOutput = { plan, unallocated, no_external_actions: true };
  if (llm_plan) result.llm_plan = llm_plan;
  return result;
}
