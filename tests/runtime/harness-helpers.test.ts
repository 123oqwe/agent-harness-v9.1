import { describe, it, expect, vi } from 'vitest';
import { emitSessionEvent, emitErrorEvent, buildHarnessOutcome } from '../../runtime/harness-support.js';
import { DurableSession } from '../../session/durable-session.js';
import type { RunEvidence } from '../../runtime/harness-support.js';
import type { LoopResult } from '../../runtime/loop.js';
import type { RunPlan, RoutingResult } from '../../router/static-router.js';
import type { VerificationReport } from '../../verification/verification-engine.js';

describe('emitSessionEvent', () => {
  it('appends a system event with proper writer lifecycle', () => {
    const session = new DurableSession('test-emit-1');
    emitSessionEvent(session, { event: 'run_finalized', termination_reason: 'goal_satisfied' });
    const events = session.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('system');
    expect((events[0]!.data as { event: string }).event).toBe('run_finalized');
    expect((events[0]!.data as { termination_reason: string }).termination_reason).toBe('goal_satisfied');
  });

  it('appends multiple events in order', () => {
    const session = new DurableSession('test-emit-2');
    emitSessionEvent(session, { event: 'pause_resume_evaluated', action: 'continue_next_step' });
    emitSessionEvent(session, { event: 'run_finalized', termination_reason: 'completed' });
    const events = session.getEvents();
    expect(events).toHaveLength(2);
    expect((events[0]!.data as { event: string }).event).toBe('pause_resume_evaluated');
    expect((events[1]!.data as { event: string }).event).toBe('run_finalized');
  });

  it('preserves complex nested data', () => {
    const session = new DurableSession('test-emit-3');
    const workspaceChanges = [{ path: '/a', action: 'write' }];
    emitSessionEvent(session, {
      event: 'run_finalized',
      termination_reason: 'goal_satisfied',
      verification_report: { all_passed: true },
      workspace_changes: workspaceChanges,
    });
    const events = session.getEvents();
    expect((events[0]!.data as { workspace_changes: unknown[] }).workspace_changes).toEqual(workspaceChanges);
  });
});

describe('emitErrorEvent', () => {
  it('appends an error event with event name and message', () => {
    const session = new DurableSession('test-emit-err-1');
    emitErrorEvent(session, 'verification_engine_failed', 'something went wrong');
    const events = session.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    expect((events[0]!.data as { event: string }).event).toBe('verification_engine_failed');
    expect((events[0]!.data as { message: string }).message).toBe('something went wrong');
  });

  it('appends multiple error events in order', () => {
    const session = new DurableSession('test-emit-err-2');
    emitErrorEvent(session, 'verification_engine_failed', 'error 1');
    emitErrorEvent(session, 'workspace_finalize_failed', 'error 2');
    const events = session.getEvents();
    expect(events).toHaveLength(2);
    expect((events[0]!.data as { event: string }).event).toBe('verification_engine_failed');
    expect((events[1]!.data as { event: string }).event).toBe('workspace_finalize_failed');
  });

  it('handles empty message string', () => {
    const session = new DurableSession('test-emit-err-3');
    emitErrorEvent(session, 'progress_write_failed', '');
    const events = session.getEvents();
    expect((events[0]!.data as { message: string }).message).toBe('');
  });
});

describe('buildHarnessOutcome', () => {
  function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
    return {
      strategy: 'direct',
      iterations: 1,
      termination_reason: 'completed',
      turns: [],
      decision_summaries: [],
      context_reset_emitted: false,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      step_states: {},
      ...overrides,
    } as LoopResult;
  }

  function makeRouting(): RoutingResult {
    return { outcome: 'route', run_plan: null } as unknown as RoutingResult;
  }

  function makeEvidence(): RunEvidence {
    return {
      session_id: 'test',
      run_id: 'test',
      commit_sha: 'abc',
      tree_sha: 'def',
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: { pass: 0, total: 0, failed: 0 },
      coverage: { lines: 0, branches: 0, functions: 0 },
      security_checks: {},
      verifier_result: '',
      verifier_model: '',
      test_output: '',
      test_output_hash: '',
      test_output_sha256: '',
      test_pass_count: 0,
      test_total_count: 0,
      independent_verifier: { model: '', verdict: '', severity: '' },
    } as unknown as RunEvidence;
  }

  it('builds outcome with all fields', () => {
    const loopResult = makeLoopResult();
    const routing = makeRouting();
    const evidence = makeEvidence();
    const session = new DurableSession('test-build-1');
    const outcome = buildHarnessOutcome(null, routing, loopResult, null, session, evidence, true);
    expect(outcome.run_plan).toBe(null);
    expect(outcome.routing).toBe(routing);
    expect(outcome.loop_result).toBe(loopResult);
    expect(outcome.verification_report).toBe(null);
    expect(outcome.session).toBe(session);
    expect(outcome.evidence).toBe(evidence);
    expect(outcome.success).toBe(true);
  });

  it('builds outcome with non-null run_plan', () => {
    const runPlan = { run_id: 'r1' } as RunPlan;
    const loopResult = makeLoopResult();
    const routing = makeRouting();
    const evidence = makeEvidence();
    const session = new DurableSession('test-build-2');
    const outcome = buildHarnessOutcome(runPlan, routing, loopResult, null, session, evidence, false);
    expect(outcome.run_plan).toBe(runPlan);
    expect(outcome.success).toBe(false);
  });

  it('builds outcome with verification_report', () => {
    const report = { all_passed: true } as VerificationReport;
    const loopResult = makeLoopResult({ termination_reason: 'goal_satisfied' });
    const routing = makeRouting();
    const evidence = makeEvidence();
    const session = new DurableSession('test-build-3');
    const outcome = buildHarnessOutcome(null, routing, loopResult, report, session, evidence, true);
    expect(outcome.verification_report).toBe(report);
    expect(outcome.success).toBe(true);
  });
});

import { buildLoopResult } from '../../runtime/harness-support.js';

describe('buildLoopResult', () => {
  it('builds result with all fields', () => {
    const result = buildLoopResult(
      'direct', 3, 'completed',
      [{ role: 'user', content: 'hi' }],
      [{ summary: 'done' }],
      '/data', false, 100, 50, 150,
      new Map([['step1', 'done']]),
    );
    expect(result.strategy).toBe('direct');
    expect(result.iterations).toBe(3);
    expect(result.termination_reason).toBe('completed');
    expect(result.turns).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result.decision_summaries).toEqual([{ summary: 'done' }]);
    expect(result.progress_path).toBeDefined();
    expect(result.context_reset_emitted).toBe(false);
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    expect(result.step_states).toEqual({ step1: 'done' });
    expect(Object.isFrozen(result.step_states)).toBe(true);
  });

  it('omits progress_path when dataDir is undefined', () => {
    const result = buildLoopResult(
      'react', 1, 'goal_satisfied',
      [], [], undefined, false, 0, 0, 0,
      new Map(),
    );
    expect(result.progress_path).toBeUndefined();
  });

  it('includes progress_path when dataDir is set', () => {
    const result = buildLoopResult(
      'plan_execute', 5, 'verification_failed',
      [], [], '/tmp/run', true, 200, 100, 300,
      new Map([['s1', 'done'], ['s2', 'pending']]),
    );
    expect(result.progress_path).toBe('/tmp/run/progress.json');
  });

  it('handles context_reset_emitted true', () => {
    const result = buildLoopResult(
      'direct', 2, 'context_reset',
      [], [], undefined, true, 50, 25, 75,
      new Map(),
    );
    expect(result.context_reset_emitted).toBe(true);
  });

  it('freezes step_states object', () => {
    const result = buildLoopResult(
      'direct', 1, 'completed',
      [], [], undefined, false, 0, 0, 0,
      new Map([['a', 'b']]),
    );
    expect(Object.isFrozen(result.step_states)).toBe(true);
  });

  it('handles empty stepStates map', () => {
    const result = buildLoopResult(
      'direct', 0, 'internal_error',
      [], [], undefined, false, 0, 0, 0,
      new Map(),
    );
    expect(result.step_states).toEqual({});
    expect(Object.isFrozen(result.step_states)).toBe(true);
  });

  it('preserves termination_reason value', () => {
    for (const reason of ['completed', 'goal_satisfied', 'verification_failed', 'budget_exhausted', 'user_cancel', 'deadline', 'internal_error', 'context_reset', 'approval_required']) {
      const result = buildLoopResult('direct', 1, reason, [], [], undefined, false, 0, 0, 0, new Map());
      expect(result.termination_reason).toBe(reason);
    }
  });

  it('handles large token counts', () => {
    const result = buildLoopResult(
      'direct', 100, 'completed',
      [], [], undefined, false, 999999, 888888, 1888877,
      new Map(),
    );
    expect(result.usage.input_tokens).toBe(999999);
    expect(result.usage.output_tokens).toBe(888888);
    expect(result.usage.total_tokens).toBe(1888877);
  });
});

import { HookIdentity } from '../../runtime/harness-support.js';

describe('HookIdentity builders', () => {
  it('builds prompt identity', () => {
    expect(HookIdentity.prompt('run-123')).toBe('prompt:run-123');
  });
  it('builds sessionStart identity', () => {
    expect(HookIdentity.sessionStart('r1')).toBe('session-start:r1');
  });
  it('builds sessionEnd identity', () => {
    expect(HookIdentity.sessionEnd('r1')).toBe('session-end:r1');
  });
  it('builds stopPrompt identity with action', () => {
    expect(HookIdentity.stopPrompt('r1', 'deny')).toBe('stop:r1:prompt-deny');
  });
  it('builds stopPrompt identity with force_prompt', () => {
    expect(HookIdentity.stopPrompt('r1', 'force_prompt')).toBe('stop:r1:prompt-force_prompt');
  });
  it('builds stopDenied identity', () => {
    expect(HookIdentity.stopDenied('r1')).toBe('stop:r1:denied');
  });
  it('builds stopSkill identity', () => {
    expect(HookIdentity.stopSkill('r1')).toBe('stop:r1:skill-activation');
  });
  it('builds stopTermination identity', () => {
    expect(HookIdentity.stopTermination('r1', 'goal_satisfied')).toBe('stop:r1:goal_satisfied');
  });
  it('builds stopTermination with verification_failed', () => {
    expect(HookIdentity.stopTermination('r1', 'verification_failed')).toBe('stop:r1:verification_failed');
  });
  it('builds stopInternalError identity', () => {
    expect(HookIdentity.stopInternalError('r1')).toBe('stop:r1:internal-error');
  });
  it('builds providerBefore identity', () => {
    expect(HookIdentity.providerBefore('r1', 1)).toBe('provider-before:r1:1');
  });
  it('builds providerAfter identity', () => {
    expect(HookIdentity.providerAfter('r1', 3)).toBe('provider-after:r1:3');
  });
  it('builds turnBefore identity', () => {
    expect(HookIdentity.turnBefore('r1', 0)).toBe('turn-before:r1:0');
  });
  it('builds turnAfter identity', () => {
    expect(HookIdentity.turnAfter('r1', 2)).toBe('turn-after:r1:2');
  });
  it('builds toolBefore identity with all params', () => {
    expect(HookIdentity.toolBefore('r1', 's1', 'tc1', 0)).toBe('tool-before:r1:s1:tc1:0');
  });
  it('builds toolAfter identity with all params', () => {
    expect(HookIdentity.toolAfter('r1', 's2', 'tc2', 1)).toBe('tool-after:r1:s2:tc2:1');
  });
  it('handles empty runId', () => {
    expect(HookIdentity.prompt('')).toBe('prompt:');
  });
  it('handles special characters in runId', () => {
    expect(HookIdentity.prompt('run-abc-123')).toBe('prompt:run-abc-123');
  });
  it('produces different identities for different runIds', () => {
    expect(HookIdentity.prompt('r1')).not.toBe(HookIdentity.prompt('r2'));
  });
  it('produces different identities for different actions', () => {
    expect(HookIdentity.stopPrompt('r1', 'deny')).not.toBe(HookIdentity.stopPrompt('r1', 'skip'));
  });
});
