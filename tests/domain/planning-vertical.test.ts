import { describe, it, expect } from 'vitest';
import { runPlanningVertical } from '../../planning/ah_planning_vertical_001.js';

describe('AH-PLANNING-VERTICAL-001 planning vertical', () => {
  it('generates plan with valid DAG, no cycles', async () => {
    const r = await runPlanningVertical({ goal: 'build app', tasks: [
      { id: 'design', depends_on: [] }, { id: 'code', depends_on: ['design'] }, { id: 'test', depends_on: ['code'] },
    ] });
    expect(r.valid).toBe(true);
    expect(r.plan).toEqual(['design', 'code', 'test']);
    expect(r.cycles).toHaveLength(0);
  });
  it('detects cycles and reports them', async () => {
    const r = await runPlanningVertical({ goal: 'x', tasks: [
      { id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['a'] },
    ] });
    expect(r.valid).toBe(false);
    expect(r.cycles.length).toBeGreaterThan(0);
  });
});
