/** AH-PA-VERTICAL-001: thin adapter. Task list → daily plan (no external action). */
import type { TaskContract } from '../../contracts/index.js';
import type { Harness, HarnessOutcome } from '../../harness.js';

export interface PAVerticalInput {
  tasks: { id: string; title: string; priority: 'high' | 'normal' | 'low'; duration_min: number }[];
  available_minutes: number;
}
export interface PAVerticalOutput {
  plan: { task_id: string; title: string; slot: number }[];
  unallocated: string[];
  no_external_actions: boolean;
  outcome: HarnessOutcome;
}

export function paTaskContract(input: PAVerticalInput): TaskContract {
  return {
    goal: `Schedule tasks for ${input.available_minutes} minutes. Tasks: ${input.tasks.map(t => `${t.id}: ${t.title} (${t.priority}, ${t.duration_min}min)`).join(', ')}`,
    success_criteria: [
      { criterion: 'all tasks scheduled or unallocated with reason', verification_method: 'deterministic' },
      { criterion: 'no external actions (no email/calendar/push/sms)', verification_method: 'deterministic' },
      { criterion: 'high priority tasks first', verification_method: 'deterministic' },
    ],
    constraints: [{ type: 'privacy', value: 'local_only' }, { type: 'tool_restriction', value: 'no_external_write' }],
  };
}

export async function runPAVertical(harness: Harness, input: PAVerticalInput): Promise<PAVerticalOutput> {
  const outcome = await harness.run(paTaskContract(input), `pa-${Date.now()}`);
  const priority = { high: 0, normal: 1, low: 2 } as const;
  const ordered = input.tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (left, right) =>
        priority[left.task.priority] - priority[right.task.priority] ||
        left.index - right.index,
    );
  const plan: { task_id: string; title: string; slot: number }[] = [];
  const unallocated: string[] = [];
  let allocatedMinutes = 0;
  for (const { task } of ordered) {
    if (
      task.duration_min >= 0 &&
      allocatedMinutes + task.duration_min <= input.available_minutes
    ) {
      plan.push({
        task_id: task.id,
        title: task.title,
        slot: allocatedMinutes,
      });
      allocatedMinutes += task.duration_min;
    } else {
      unallocated.push(task.id);
    }
  }

  const externalPattern = /email|calendar|push|sms|message|publish/iu;
  const hasExternalAction =
    outcome.evidence.tool_calls.some((call) =>
      externalPattern.test(call.tool),
    ) ||
    outcome.evidence.audit_entries.some((entry) => {
      const audit = entry as { tool_name?: unknown; verdict?: unknown };
      return (
        audit.verdict === 'allow' &&
        typeof audit.tool_name === 'string' &&
        externalPattern.test(audit.tool_name)
      );
    });

  return {
    plan,
    unallocated,
    no_external_actions: !hasExternalAction,
    outcome,
  };
}
