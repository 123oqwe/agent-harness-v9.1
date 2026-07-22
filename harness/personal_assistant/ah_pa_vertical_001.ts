/** AH-PA-VERTICAL-001: thin adapter. Task list → daily plan (no external action). */
import type { TaskContract } from '../../spec/types/task-contract.js';
import type { Harness, HarnessOutcome } from '../harness.js';

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
    goal: `Schedule tasks for ${input.available_minutes} minutes. Tasks: ${input.tasks.map(t => `${t.id}: ${t.title} (${t.priority}, ${t.duration_min}min)`).join('; ')}`,
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

  // Extract plan from model output — parse task IDs from the response
  const modelOutput = outcome.loop_result.turns.at(-1)?.model.content ?? '';
  const plan: { task_id: string; title: string; slot: number }[] = [];
  const unallocated: string[] = [];
  for (const task of input.tasks) {
    if (modelOutput.includes(task.id)) {
      plan.push({ task_id: task.id, title: task.title, slot: task.duration_min });
    } else {
      unallocated.push(task.id);
    }
  }

  // no_external_actions proven by: no external-write tools in the frozen snapshot,
  // no external-write tool_calls in the session event log, Policy denies external_write.
  const events = outcome.session.getEvents();
  const hasExternalAction = events.some(e => {
    if (e.type !== 'tool_call') return false;
    const tool = (e.data as { tool: string }).tool;
    return tool.includes('email') || tool.includes('calendar') || tool.includes('push') || tool.includes('sms');
  });

  return {
    plan,
    unallocated,
    no_external_actions: !hasExternalAction,
    outcome,
  };
}
