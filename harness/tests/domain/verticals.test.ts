import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import { runCodingVertical } from '../../domains/coding/ah_coding_vertical_001.js';
import { runDocVertical } from '../../ingestion/ah_doc_vertical_001.js';
import { runResearchVertical } from '../../research/ah_research_vertical_001.js';
import { runWritingVertical } from '../../writing/ah_writing_vertical_001.js';
import { runPlanningVertical } from '../../planning/ah_planning_vertical_001.js';
import { runPAVertical } from '../../personal_assistant/ah_pa_vertical_001.js';

describe('AH-VERTICALS: six product verticals', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    vfs = new VirtualFilesystem({ root: '/workspace' });
  });

  it('coding: reads repo, fixes bug, returns diff', () => {
    vfs.write('/repo/src/index.ts', 'export const bug = true;');
    const result = runCodingVertical(vfs, { repository_path: '/repo', bug_description: 'bug in index.ts' });
    expect(result.bug_fixed).toBe(true);
    expect(result.tests_passed).toBe(true);
    expect(result.diff).toBeTruthy();
  });

  it('documents: parses, summarizes, cites pages', () => {
    const result = runDocVertical({ document_path: 'doc.txt', content: 'Page 1\fPage 2', format: 'txt' });
    expect(result.summary).toBeTruthy();
    expect(result.citations.length).toBe(2);
    expect(result.total_pages).toBe(2);
  });

  it('research: reads sources, organizes claims', () => {
    vfs.write('/sources/a.txt', 'important topic here');
    const result = runResearchVertical(vfs, { source_directory: '/sources', research_question: 'important topic' });
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.summary).toContain('important topic');
  });

  it('writing: brief to draft with rubric check', () => {
    const result = runWritingVertical(vfs, { brief: 'Write about AI', output_path: '/scratch/draft.md' });
    expect(result.draft).toBeTruthy();
    expect(result.passed).toBe(true);
  });

  it('planning: constructs valid DAG', () => {
    const result = runPlanningVertical({
      goal: 'Build app', constraints: [],
      tasks: [
        { id: 'a', name: 'design', dependencies: [] },
        { id: 'b', name: 'implement', dependencies: ['a'] },
        { id: 'c', name: 'test', dependencies: ['b'] },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.cycle_detected).toBe(false);
    expect(result.plan.length).toBe(3);
  });

  it('planning: rejects cyclic dependency', () => {
    const result = runPlanningVertical({
      goal: 'Build app', constraints: [],
      tasks: [
        { id: 'a', name: 'task-a', dependencies: ['b'] },
        { id: 'b', name: 'task-b', dependencies: ['a'] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.cycle_detected).toBe(true);
  });

  it('personal assistant: task list to daily plan', () => {
    const result = runPAVertical({
      tasks: [
        { id: '1', title: 'Meeting', duration_minutes: 30, priority: 'high' },
        { id: '2', title: 'Code review', duration_minutes: 60, priority: 'medium' },
      ],
      available_minutes: 120,
    });
    expect(result.schedule.length).toBe(2);
    expect(result.conflicts).toBe(false);
    expect(result.total_scheduled_minutes).toBe(90);
  });

  it('personal assistant: unschedules when over budget', () => {
    const result = runPAVertical({
      tasks: [
        { id: '1', title: 'Big task', duration_minutes: 120, priority: 'high' },
        { id: '2', title: 'Small task', duration_minutes: 30, priority: 'medium' },
      ],
      available_minutes: 60,
    });
    expect(result.schedule.length).toBe(1);
    expect(result.unscheduled.length).toBe(1);
  });
});
