import { describe, expect, it } from 'vitest';
import {
  TaskController,
  type Task,
  type TaskRuntimePort,
} from '../../ui/ah_ui_task_001.js';

function runtime(): TaskRuntimePort & { tasks: Task[] } {
  return {
    tasks: [],
    submit(goal, strategy) {
      const task: Task = {
        id: `task-${this.tasks.length + 1}`,
        goal,
        status: 'pending',
        ...(strategy === undefined ? {} : { strategy }),
      };
      this.tasks.push(task);
      return task;
    },
    list() { return this.tasks; },
  };
}

describe('AH-UI-TASK-001 runtime-derived task state', () => {
  it('submits through runtime and projects runtime-owned status', () => {
    const backend = runtime();
    const controller = new TaskController(backend);
    const created = controller.create('fix bug', 'plan_execute');
    expect(created).toMatchObject({
      state: 'success',
      data: { status: 'pending' },
    });
    backend.tasks[0] = { ...backend.tasks[0]!, status: 'completed' };
    expect(controller.list().data![0]!.status).toBe('completed');
    expect('update' in controller).toBe(false);
  });

  it('rejects an empty goal and reports an empty runtime', () => {
    const controller = new TaskController(runtime());
    expect(controller.create(' ').state).toBe('error');
    expect(controller.list().state).toBe('empty');
  });
});
