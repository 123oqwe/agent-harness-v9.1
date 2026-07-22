import { describe, it, expect } from 'vitest';
import { profileIntent, selectStrategy, type ReasoningStrategy } from '../../router/static-router.js';
import type { TaskContract } from '../../../spec/types/task-contract.js';

function task(goal: string): TaskContract {
  return { goal, success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }], constraints: [] } as TaskContract;
}

describe('reasoning strategies', () => {
  it('direct: tool-free single-call task', () => {
    expect(selectStrategy(profileIntent(task('rewrite this paragraph more concisely')))).toBe<ReasoningStrategy>('direct');
  });
  it('react: observation-dependent tool task', () => {
    expect(selectStrategy(profileIntent(task('list the directory and read the matching file')))).toBe<ReasoningStrategy>('react');
  });
  it('plan_execute: dependent multi-step write+test', () => {
    expect(selectStrategy(profileIntent(task('fix the bug then run the tests then verify')))).toBe<ReasoningStrategy>('plan_execute');
  });
  it('plan_execute: explicit plan request', () => {
    expect(selectStrategy(profileIntent(task('plan the feature implementation step by step')))).toBe<ReasoningStrategy>('plan_execute');
  });
  it('direct: no tools, no multi-step', () => {
    const i = profileIntent(task('translate this to French'));
    expect(i.requires_tools).toBe(false);
    expect(i.multi_step).toBe(false);
    expect(selectStrategy(i)).toBe<ReasoningStrategy>('direct');
  });
  it('react: requires tool but not multi-step', () => {
    const i = profileIntent(task('search for the keyword in the file'));
    expect(i.requires_tools).toBe(true);
    expect(i.multi_step).toBe(false);
    expect(selectStrategy(i)).toBe<ReasoningStrategy>('react');
  });
  it('plan_execute: writes and tests together', () => {
    const i = profileIntent(task('implement the feature and run the tests'));
    expect(i.requires_writes).toBe(true);
    expect(i.requires_tests).toBe(true);
    expect(i.multi_step).toBe(true);
    expect(selectStrategy(i)).toBe<ReasoningStrategy>('plan_execute');
  });
  it('strategies are mutually exclusive for a given task', () => {
    const strategies = new Set<ReasoningStrategy>();
    strategies.add(selectStrategy(profileIntent(task('rewrite text'))));
    strategies.add(selectStrategy(profileIntent(task('read the file'))));
    strategies.add(selectStrategy(profileIntent(task('fix bug then test'))));
    expect(strategies.size).toBe(3);
  });
});
