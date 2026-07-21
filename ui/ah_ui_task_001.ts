/** AH-UI-TASK-001: Task view screen with real API dependencies. */
import type { UiResult } from './ui-state.js';

export interface Task { id: string; goal: string; status: 'pending' | 'running' | 'completed' | 'failed'; strategy?: string | undefined }
export class TaskController {
  private tasks: Task[] = [];
  create(goal: string, strategy?: string): UiResult<Task> {
    const t: Task = { id: 'task-' + Date.now(), goal, status: 'pending', strategy };
    this.tasks.push(t);
    return { state: 'success', data: t };
  }
  list(): UiResult<Task[]> { return { state: this.tasks.length === 0 ? 'empty' : 'success', data: [...this.tasks] }; }
  update(id: string, patch: Partial<Task>): UiResult<Task> {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return { state: 'error', error: 'not found' };
    Object.assign(t, patch);
    return { state: 'success', data: t };
  }
}
