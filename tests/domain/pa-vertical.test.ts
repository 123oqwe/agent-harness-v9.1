import { describe, it, expect } from 'vitest';
import { runPAVertical } from '../../personal_assistant/ah_pa_vertical_001.js';

describe('AH-PA-VERTICAL-001 personal assistant vertical', () => {
  it('takes task list, generates daily plan, respects constraints, no external actions', async () => {
    const r = await runPAVertical({
      tasks: [
        { id: 't1', title: 'urgent meeting', priority: 'high', duration_min: 30 },
        { id: 't2', title: 'write report', priority: 'normal', duration_min: 60 },
        { id: 't3', title: 'optional reading', priority: 'low', duration_min: 45 },
      ],
      available_minutes: 90,
    });
    expect(r.plan).toHaveLength(2); // t1 (30) + t2 (60) = 90
    expect(r.unallocated).toContain('t3');
    expect(r.no_external_actions).toBe(true);
  });
});
