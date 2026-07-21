import { describe, it, expect } from 'vitest';
import { TaskController } from '../../ui/ah_ui_task_001.js';
describe('AH-UI-TASK-001 task view', () => {
  it('empty state when no tasks', () => { const c = new TaskController(); expect(c.list().state).toBe('empty'); });
  it('create task success', () => { const c = new TaskController(); const r = c.create('fix bug', 'plan_execute'); expect(r.state).toBe('success'); expect(r.data!.goal).toBe('fix bug'); });
  it('update task status', () => { const c = new TaskController(); const t = c.create('g'); c.update(t.data!.id, { status: 'completed' }); expect(c.list().data![0]!.status).toBe('completed'); });
  it('update not found error', () => { const c = new TaskController(); expect(c.update('x', {}).state).toBe('error'); });
});
