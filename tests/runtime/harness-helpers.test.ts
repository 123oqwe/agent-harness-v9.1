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
