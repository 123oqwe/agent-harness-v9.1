import { describe, it, expect, beforeEach } from 'vitest';
import { EvalRunner, type EvalFixture } from '../../verification/eval-runner.js';

describe('AH-EVAL-001: eval runner', () => {
  let runner: EvalRunner;

  beforeEach(() => {
    runner = new EvalRunner();
  });

  it('registers and runs fixtures', async () => {
    const fixture: EvalFixture = {
      id: 'test-1', name: 'Test fixture', description: 'test',
      run: async () => ({ passed: true, output: 'ok' }),
      expected: {},
    };
    runner.register(fixture);
    const summary = await runner.runAll();
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.digest).toBeTruthy();
  });

  it('counts failures correctly', async () => {
    runner.register({
      id: 'pass', name: 'Pass', description: '',
      run: async () => ({ passed: true, output: 'ok' }), expected: {},
    });
    runner.register({
      id: 'fail', name: 'Fail', description: '',
      run: async () => ({ passed: false, output: '', error: 'assertion' }), expected: {},
    });
    const summary = await runner.runAll();
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('handles fixture errors', async () => {
    runner.register({
      id: 'error', name: 'Error', description: '',
      run: async () => { throw new Error('crash'); }, expected: {},
    });
    const summary = await runner.runAll();
    expect(summary.failed).toBe(1);
    expect(summary.results[0].error).toContain('crash');
  });
});
