/** AH-UI-TASK-001: Task view screen with real API dependencies. */
import type { UiResult } from './ui-state.js';

export interface Task { id: string; goal: string; status: 'pending' | 'running' | 'completed' | 'failed'; strategy?: string | undefined }
export interface TaskRuntimePort {
  submit(goal: string, strategy?: string): Task;
  list(): readonly Task[];
}

export class TaskController {
  constructor(private readonly runtime: TaskRuntimePort) {}

  create(goal: string, strategy?: string): UiResult<Task> {
    if (goal.trim() === '') return { state: 'error', error: 'goal required' };
    return { state: 'success', data: this.runtime.submit(goal, strategy) };
  }
  list(): UiResult<Task[]> {
    const tasks = [...this.runtime.list()];
    return {
      state: tasks.length === 0 ? 'empty' : 'success',
      data: tasks,
    };
  }
}
