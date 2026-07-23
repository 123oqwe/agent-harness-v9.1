import { describe, it, expect } from 'vitest';
import { TaskNormalizer } from '../../router/task-normalizer.js';

describe('Task Normalizer', () => {
  const norm = new TaskNormalizer();

  it('normalizes a simple prompt into TaskContract', () => {
    const result = norm.normalize({ prompt: 'Fix the bug in the code' });
    expect(result.goal).toBe('Fix the bug in the code');
    expect(result.success_criteria.length).toBeGreaterThan(0);
    expect(result.constraints).toBeDefined();
  });

  it('extracts budget constraint', () => {
    const result = norm.normalize({ prompt: 'Fix the bug with $5 budget' });
    const budget = result.constraints.find(c => c.type === 'budget');
    expect(budget).toBeDefined();
    expect(budget!.value).toBe('5000000');
  });

  it('extracts time constraint', () => {
    const result = norm.normalize({ prompt: 'Run the tests in 30 minutes' });
    const time = result.constraints.find(c => c.type === 'time');
    expect(time).toBeDefined();
    expect(time!.value).toBe('1800000');
  });

  it('extracts privacy constraint', () => {
    const result = norm.normalize({ prompt: 'Search files locally only' });
    const privacy = result.constraints.find(c => c.type === 'privacy');
    expect(privacy).toBeDefined();
    expect(privacy!.value).toBe('local_only');
  });

  it('derives urgent priority', () => {
    const result = norm.normalize({ prompt: 'Fix this urgent bug ASAP' });
    expect(result.priority).toBe('urgent');
  });

  it('derives high priority', () => {
    const result = norm.normalize({ prompt: 'This is important, fix it' });
    expect(result.priority).toBe('high');
  });

  it('derives normal priority by default', () => {
    const result = norm.normalize({ prompt: 'Fix the bug' });
    expect(result.priority).toBe('normal');
  });

  it('adds test-based success criterion when tests mentioned', () => {
    const result = norm.normalize({ prompt: 'Fix the bug and run tests' });
    const testCriterion = result.success_criteria.find(c => c.verification_method === 'test');
    expect(testCriterion).toBeDefined();
  });

  it('throws on empty prompt', () => {
    expect(() => norm.normalize({ prompt: '' })).toThrow();
    expect(() => norm.normalize({ prompt: '   ' })).toThrow();
  });
});
