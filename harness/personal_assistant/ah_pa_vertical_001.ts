/** AH-PA-001: Personal Assistant vertical - task list to daily plan */
export interface PAVerticalInput {
  tasks: { id: string; title: string; duration_minutes: number; priority: 'high' | 'medium' | 'low' }[];
  available_minutes: number;
}

export interface PAVerticalResult {
  schedule: { task_id: string; title: string; start_minute: number; duration_minutes: number }[];
  unscheduled: string[];
  conflicts: boolean;
  total_scheduled_minutes: number;
}

export function runPAVertical(input: PAVerticalInput): PAVerticalResult {
  // Sort by priority then duration
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const sorted = [...input.tasks].sort((a, b) => {
    const pr = priorityRank[a.priority] - priorityRank[b.priority];
    if (pr !== 0) return pr;
    return b.duration_minutes - a.duration_minutes;
  });

  const schedule: PAVerticalResult['schedule'] = [];
  const unscheduled: string[] = [];
  let currentTime = 0;

  for (const task of sorted) {
    if (currentTime + task.duration_minutes <= input.available_minutes) {
      schedule.push({
        task_id: task.id,
        title: task.title,
        start_minute: currentTime,
        duration_minutes: task.duration_minutes,
      });
      currentTime += task.duration_minutes;
    } else {
      unscheduled.push(task.id);
    }
  }

  return {
    schedule,
    unscheduled,
    conflicts: false, // No conflicts in a linear schedule
    total_scheduled_minutes: currentTime,
  };
}
