import { describe, it, expect } from 'vitest';
import { staticRouter } from '../../router/static-router.js';
import { profileIntent } from '../../router/intent-profiler.js';

describe('AH-ROUTER-001: intent profiler', () => {
  it('profiles a simple no-tool prompt as low risk', () => {
    const f = profileIntent({ prompt: 'What is 2+2?' });
    expect(f.needs_tools).toBe(false);
    expect(f.effect_risk).toBe('none');
    expect(f.steps_estimated).toBe(1);
  });

  it('profiles a coding task as needing tools', () => {
    const f = profileIntent({ prompt: 'Read the file and fix the bug in the repository' });
    expect(f.needs_tools).toBe(true);
    expect(f.domains).toContain('coding');
  });

  it('profiles a research task', () => {
    const f = profileIntent({ prompt: 'Research the topic and find citations from sources' });
    expect(f.needs_tools).toBe(true);
    expect(f.domains).toContain('research');
  });

  it('profiles a writing task', () => {
    const f = profileIntent({ prompt: 'Write a draft article about AI' });
    expect(f.needs_tools).toBe(true);
    expect(f.domains).toContain('writing');
  });

  it('profiles a planning task', () => {
    const f = profileIntent({ prompt: 'Create a plan with dependencies and goals' });
    expect(f.domains).toContain('planning');
  });

  it('detects high risk operations', () => {
    const f = profileIntent({ prompt: 'Delete the file and execute the command' });
    expect(f.effect_risk).toBe('high');
  });

  it('detects file transactions', () => {
    const f = profileIntent({ prompt: 'Edit the source code file in the repository' });
    expect(f.requires_file_transaction).toBe(true);
  });

  it('is deterministic (same input = same output)', () => {
    const input = { prompt: 'Read file then write file then edit file' };
    const f1 = profileIntent(input);
    const f2 = profileIntent(input);
    expect(f1).toEqual(f2);
  });
});

describe('AH-ROUTER-001: static router', () => {
  it('routes simple no-tool prompt to direct', () => {
    const result = staticRouter({ prompt: 'What is 2+2?' });
    expect(result.strategy).toBe('direct');
    expect(result.reason.code).toBe('SINGLE_STEP_NO_TOOLS');
    expect(result.frozen_snapshot).toBe(true);
  });

  it('routes file transaction to plan_execute', () => {
    const result = staticRouter({ prompt: 'Read the repository file then edit it to fix the bug' });
    expect(result.strategy).toBe('plan_execute');
  });

  it('routes multi-step dependent task to plan_execute', () => {
    const result = staticRouter({ prompt: 'First read then after that write then finally edit the file' });
    expect(result.strategy).toBe('plan_execute');
  });

  it('routes tool-dependent uncertain task to react', () => {
    const result = staticRouter({ prompt: 'Read the content and maybe search for the pattern' });
    expect(result.strategy).toBe('react');
  });

  it('denies when policy does not allow', () => {
    const result = staticRouter({ prompt: 'What is 2+2?' }, { policy_allows: false });
    expect(result.strategy).toBe('deny');
    expect(result.reason.code).toBe('POLICY_DENIED');
  });

  it('denies high-risk uncertain tasks', () => {
    const result = staticRouter({ prompt: 'Delete the file and maybe execute the command, not sure' });
    expect(result.strategy).toBe('deny');
    expect(result.reason.code).toBe('HIGH_RISK_UNCERTAIN');
  });

  it('is deterministic (same input = same decision)', () => {
    const input = { prompt: 'Read file then write file' };
    const r1 = staticRouter(input);
    const r2 = staticRouter(input);
    expect(r1.strategy).toBe(r2.strategy);
    expect(r1.reason.code).toBe(r2.reason.code);
  });

  it('always produces a reason code', () => {
    const result = staticRouter({ prompt: 'hello' });
    expect(result.reason.code).toBeTruthy();
    expect(result.reason.message).toBeTruthy();
  });

  it('always produces features', () => {
    const result = staticRouter({ prompt: 'hello' });
    expect(result.features).toBeDefined();
    expect(result.features.domains.length).toBeGreaterThan(0);
  });

  it('model_hint is set for allowed strategies', () => {
    const result = staticRouter({ prompt: 'What is 2+2?' });
    expect(result.model_hint).toBe('scripted_test');
  });

  it('model_hint is none for denied', () => {
    const result = staticRouter({ prompt: 'What is 2+2?' }, { policy_allows: false });
    expect(result.model_hint).toBe('none');
  });
});
