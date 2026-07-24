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
    expect(() => norm.normalize({ prompt: '' })).toThrowError(
      'TaskNormalizer: prompt must not be empty',
    );
    expect(() => norm.normalize({ prompt: '   ' })).toThrowError(
      'TaskNormalizer: prompt must not be empty',
    );
  });

  it('extracts Chinese privacy, test and priority intent', () => {
    const result = norm.normalize({ prompt: '紧急：只在本地修复这个代码问题，然后运行测试验证' });
    expect(result.constraints).toContainEqual({ type: 'privacy', value: 'local_only' });
    expect(result.success_criteria).toContainEqual({
      criterion: 'tests pass',
      verification_method: 'test',
    });
    expect(result.priority).toBe('urgent');
  });

  it('trims the goal and emits the exact semantic default contract', () => {
    expect(norm.normalize({ prompt: '  explain this clearly  ' })).toEqual({
      goal: 'explain this clearly',
      success_criteria: [
        {
          criterion: 'task completed as described',
          verification_method: 'semantic',
        },
      ],
      constraints: [],
      priority: 'normal',
    });
  });

  it.each([
    ['12 dollar budget', '12000000'],
    ['$12.5 usd', '12500000'],
    ['$12.34 usd', '12340000'],
    ['12budget', '12000000'],
    ['123 budget', '123000000'],
  ])('extracts exact budget syntax from %s', (prompt, value) => {
    expect(norm.normalize({ prompt }).constraints).toContainEqual({
      type: 'budget',
      value,
    });
  });

  it.each([
    ['finish in 2 hours', '7200000'],
    ['finish in 2hours', '7200000'],
    ['finish in 3 minutes', '180000'],
    ['finish in 4 seconds', '4000'],
    ['finish in 1 hour', '3600000'],
  ])('converts exact time units from %s', (prompt, value) => {
    expect(norm.normalize({ prompt }).constraints).toContainEqual({
      type: 'time',
      value,
    });
  });

  it.each([
    'safe',
    'read-only',
    'read only',
    'readonly',
    'no-write',
    'no write',
    'nowrite',
    'local-only',
    'local only',
    'localonly',
    '只读',
    '安全模式',
    '禁止写入',
  ])('maps %s to the read-only risk ceiling', (phrase) => {
    expect(norm.normalize({ prompt: `work in ${phrase} mode` }).constraints).toContainEqual({
      type: 'risk_ceiling',
      value: 'read_only',
    });
  });

  it.each([
    'private',
    'no-network',
    'no network',
    'nonetwork',
    'offline',
    'local',
    '只在本地',
    '本地运行',
    '离线',
    '不联网',
    '禁止联网',
    '隐私',
  ])('maps %s to local-only privacy', (phrase) => {
    expect(norm.normalize({ prompt: `process ${phrase}` }).constraints).toContainEqual({
      type: 'privacy',
      value: 'local_only',
    });
  });

  it('emits exact and cumulative success criteria', () => {
    expect(norm.normalize({ prompt: 'verify the result' }).success_criteria).toEqual([
      { criterion: 'tests pass', verification_method: 'test' },
    ]);
    expect(norm.normalize({ prompt: 'produce a document' }).success_criteria).toEqual([
      {
        criterion: 'output artifact produced',
        verification_method: 'deterministic',
      },
    ]);
    expect(norm.normalize({ prompt: 'test the code artifact' }).success_criteria).toEqual([
      { criterion: 'tests pass', verification_method: 'test' },
      {
        criterion: 'output artifact produced',
        verification_method: 'deterministic',
      },
    ]);
  });

  it.each(['low priority', 'whenever', 'no rush', '低优先级', '不着急', '不急'])(
    'derives low priority from %s',
    (phrase) => {
      expect(norm.normalize({ prompt: `do this ${phrase}` }).priority).toBe('low');
    },
  );
});
