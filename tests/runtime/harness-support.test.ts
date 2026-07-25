import { describe, expect, it } from 'vitest';

import type { RunPlan, TaskContract } from '../../contracts/index.js';
import type { ProviderTool } from '../../gateway/scripted-provider.js';
import {
  assertTimestamp,
  buildEvidence,
  buildProviderSelectionRequest,
  canonicalHash,
  canonicalize,
  createDefaultExecutionContext,
  deterministicRunId,
  extractToolReceipts,
  gatewayResultToModelTurn,
  recordTerminalFailure,
  restoreLoopResult,
  restoreVerificationReport,
  restoreWorkspaceChanges,
  sanitizeMessages,
  terminalFailure,
  validateExecutionContext,
} from '../../runtime/harness-support.js';
import type { LoopResult } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';
import type { VerificationReport } from '../../verification/verification-engine.js';

const CLOCK = '2026-07-25T00:00:00.000Z';

function task(
  constraints: TaskContract['constraints'] = [],
): TaskContract {
  return {
    goal: 'answer the question',
    success_criteria: [
      {
        criterion: 'answered',
        verification_method: 'deterministic',
      },
    ],
    constraints,
  };
}

function plan(
  strategy: RunPlan['reasoning_strategy'] = 'direct',
): RunPlan {
  return {
    run_id: 'run-1',
    revision: 3,
    run_plan_hash: 'plan-hash',
    reasoning_strategy: strategy,
    model_bindings: [{ provider: 'provider-1' }],
    tool_grants: [],
    registry_snapshot_refs: {
      tools: 'tool-snapshot',
      skills: 'skill-snapshot',
    },
  } as unknown as RunPlan;
}

function session(id = 'session-1'): DurableSession {
  return new DurableSession(id, { clock: () => CLOCK });
}

describe('Harness runtime support', () => {
  it('creates an isolated default context and honors a caller clock', () => {
    const context = createDefaultExecutionContext('abc', () => CLOCK);
    expect(context).toEqual({
      tenant_id: 'default-tenant',
      user_id: 'default-user',
      session_id: 'abc',
      run_id: 'abc',
      plan_id: 'plan-abc',
      step_id: 'step-001',
      attempt_id: 'attempt-001',
      operation_id: 'op-abc',
      idempotency_key: 'idem-abc',
      policy_snapshot: 'policy-v1',
      tool_snapshot: 'tool-v1',
      budget: { token_limit: 100_000, usd_micros: 5_000_000 },
      risk_level: 2,
      confirmation_key_thumbprint: 'test-thumbprint',
      clock: expect.any(Function),
    });
    expect(context.clock()).toBe(CLOCK);
    const generated = createDefaultExecutionContext('generated');
    expect(Number.isFinite(Date.parse(generated.clock()))).toBe(true);
  });

  it.each([
    'tenant_id',
    'user_id',
    'session_id',
    'run_id',
    'plan_id',
    'step_id',
    'attempt_id',
    'operation_id',
    'idempotency_key',
    'policy_snapshot',
    'tool_snapshot',
    'confirmation_key_thumbprint',
  ] as const)('rejects blank execution identity %s', (field) => {
    const context = createDefaultExecutionContext('abc', () => CLOCK);
    expect(() =>
      validateExecutionContext({ ...context, [field]: ' \t' }),
    ).toThrow(`executionContext.${field} is required`);
  });

  it.each([
    ['token_limit', -1],
    ['token_limit', 1.5],
    ['token_limit', Number.MAX_SAFE_INTEGER + 1],
    ['usd_micros', -1],
    ['usd_micros', 1.5],
    ['usd_micros', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects invalid budget %s=%s', (field, value) => {
    const context = createDefaultExecutionContext('abc', () => CLOCK);
    expect(() =>
      validateExecutionContext({
        ...context,
        budget: { ...context.budget, [field]: value },
      }),
    ).toThrow(
      `executionContext.budget.${field} must be a non-negative safe integer`,
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid risk level %s',
    (riskLevel) => {
      const context = createDefaultExecutionContext('abc', () => CLOCK);
      expect(() =>
        validateExecutionContext({ ...context, risk_level: riskLevel }),
      ).toThrow(
        'executionContext.risk_level must be a non-negative safe integer',
      );
    },
  );

  it('accepts zero budgets and risk and validates timestamps exactly', () => {
    const context = createDefaultExecutionContext('abc', () => CLOCK);
    expect(() =>
      validateExecutionContext({
        ...context,
        budget: { token_limit: 0, usd_micros: 0 },
        risk_level: 0,
      }),
    ).not.toThrow();
    expect(assertTimestamp(CLOCK, 'clock')).toBe(CLOCK);
    expect(() => assertTimestamp('invalid', 'runtime clock')).toThrow(
      'runtime clock returned an invalid timestamp',
    );
  });

  it('canonicalizes nested objects without reordering arrays', () => {
    expect(
      canonicalize({
        z: [{ b: 2, a: 1 }, null],
        a: 'first',
      }),
    ).toEqual({
      a: 'first',
      z: [{ a: 1, b: 2 }, null],
    });
    expect(canonicalHash({ b: 2, a: 1 })).toBe(
      canonicalHash({ a: 1, b: 2 }),
    );
    expect(canonicalHash({ a: 1 }, 12)).toHaveLength(12);
    expect(canonicalHash({ a: 1 })).toHaveLength(64);
  });

  it('derives a stable goal-scoped fallback run id', () => {
    const first = deterministicRunId(task());
    expect(first).toMatch(/^run-[0-9a-f]{12}$/u);
    expect(deterministicRunId(task())).toBe(first);
    expect(
      deterministicRunId({ ...task(), goal: 'different' }),
    ).not.toBe(first);
  });

  it('returns a complete immutable terminal failure shape', () => {
    const result = terminalFailure('react', 'provider_failure');
    expect(result).toEqual({
      strategy: 'react',
      iterations: 0,
      termination_reason: 'provider_failure',
      turns: [],
      decision_summaries: [],
      context_reset_emitted: false,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      step_states: {},
    });
    expect(Object.isFrozen(result.step_states)).toBe(true);
  });

  it('records an exact terminal failure event chain and snapshot', () => {
    const value = session('terminal');
    value.acquireWriter();
    const result = recordTerminalFailure(value, 'plan_execute', {
      reason: 'blocked',
      detail: 'policy',
    });
    value.releaseWriter();
    expect(result).toEqual(
      terminalFailure('plan_execute', 'denied'),
    );
    expect(
      value.getEvents().map((event) => ({
        type: event.type,
        data: event.data,
      })),
    ).toEqual([
      {
        type: 'error',
        data: { reason: 'blocked', detail: 'policy' },
      },
      {
        type: 'system',
        data: {
          event: 'run_terminated',
          termination_reason: 'denied',
          iterations: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
      },
      {
        type: 'system',
        data: {
          event: 'run_finalized',
          termination_reason: 'denied',
          verification_report: null,
          workspace_changes: [],
        },
      },
    ]);
    expect(value.export_().snapshot).toMatchObject({
      session_id: 'terminal',
      last_seq: 3,
      summary: {
        termination_reason: 'denied',
        iterations: 0,
        last_event_seq: 3,
      },
    });
  });

  it('strips strategy-only message fields and preserves provider fields', () => {
    expect(
      sanitizeMessages([
        {
          role: 'assistant',
          content: 'tool',
          decision_summary: 'internal',
          tool_calls: [
            {
              id: 'call-1',
              name: 'read_file',
              arguments: { path: '/workspace/a' },
            },
          ],
        },
        {
          role: 'tool',
          content: 'result',
          tool_call_id: 'call-1',
          extra: true,
        },
        { role: 'user', content: 'next' },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: 'tool',
        tool_calls: [
          {
            id: 'call-1',
            name: 'read_file',
            arguments: { path: '/workspace/a' },
          },
        ],
      },
      { role: 'tool', content: 'result', tool_call_id: 'call-1' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('builds exact direct, non-local provider selection without tool metadata', () => {
    const request = buildProviderSelectionRequest({
      task: task(),
      runPlan: plan('direct'),
      messages: [{ role: 'user', content: 'hello' }],
      modelBudget: { remaining_tokens: 50, max_output_tokens: 40 },
      registrySnapshotHash: 'registry-1',
      selectedTools: [],
    });
    expect(request).toEqual({
      registry_snapshot_hash: 'registry-1',
      request: {
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 40,
      },
      estimated_input_tokens: 5,
      required_capabilities: ['text_reasoning'],
      requires_structured_output: false,
      data_policy: {
        local_only: false,
        allowed_regions: ['local', 'cn', 'us', 'eu'],
        max_retention_days: 365,
        training_allowed: false,
      },
      policy: {
        allowed_provider_ids: ['provider-1'],
        denied_provider_ids: [],
      },
      run_plan: {
        allowed_provider_ids: ['provider-1'],
        required_capabilities: ['text_reasoning'],
      },
    });
  });

  it('builds local tool-capable selection and caps the input estimate', () => {
    const selectedTools = [
      { name: 'read_file' },
    ] as readonly ProviderTool[];
    const request = buildProviderSelectionRequest({
      task: task([{ type: 'privacy', value: 'local_only' }]),
      runPlan: plan('react'),
      messages: [
        {
          role: 'assistant',
          content: 'x'.repeat(100_001),
          tool_call_id: 'prior',
        },
      ],
      modelBudget: { remaining_tokens: 1, max_output_tokens: 1 },
      registrySnapshotHash: 'registry-2',
      selectedTools,
    });
    expect(request.request.tools).toBe(selectedTools);
    expect(request.request.max_tokens).toBe(1);
    expect(request.estimated_input_tokens).toBe(100_000);
    expect(request.required_capabilities).toEqual([
      'text_reasoning',
      'tool_calling',
    ]);
    expect(request.data_policy).toEqual({
      local_only: true,
      allowed_regions: ['local'],
      max_retention_days: 0,
      training_allowed: false,
    });
  });

  it('fails closed when a RunPlan has no model binding', () => {
    const invalid = { ...plan(), model_bindings: [] } as unknown as RunPlan;
    expect(() =>
      buildProviderSelectionRequest({
        task: task(),
        runPlan: invalid,
        messages: [],
        modelBudget: { remaining_tokens: 1, max_output_tokens: 1 },
        registrySnapshotHash: 'registry',
        selectedTools: [],
      }),
    ).toThrow('RunPlan must bind a model provider');
  });

  it('maps gateway results without emitting undefined protocol fields', () => {
    expect(
      gatewayResultToModelTurn({
        response: { content: 'short' },
        usage: undefined,
      }),
    ).toEqual({
      content: 'short',
      decision_summary: 'short',
    });
    const long = 'x'.repeat(201);
    expect(
      gatewayResultToModelTurn({
        response: {
          content: long,
          tool_calls: [
            {
              id: '1',
              name: 'read_file',
              arguments: { path: '/workspace/a' },
            },
          ],
          stop_reason: 'tool_use',
        },
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    ).toEqual({
      content: long,
      decision_summary: 'x'.repeat(200),
      tool_calls: [
        {
          id: '1',
          name: 'read_file',
          arguments: { path: '/workspace/a' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 2, output_tokens: 3 },
    });
  });

  it('restores the last final record, terminal usage, step state, and summaries', () => {
    const value = session();
    value.acquireWriter();
    value.append('system', {
      event: 'run_finalized',
      verification_report: null,
      workspace_changes: [{ path: '/workspace/old', kind: 'delete' }],
    });
    value.append('assistant', { decision_summary: 'first' });
    value.append('assistant', {});
    value.append('system', {
      event: 'step_state',
      step: 'step-1',
      status: 'done',
    });
    value.append('system', {
      event: 'step_state',
      step: '',
      status: 'failed',
    });
    value.append('system', {
      event: 'run_terminated',
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
    const report = {
      plan_revision: 3,
      all_passed: true,
      records: [],
      started_at: CLOCK,
      completed_at: CLOCK,
    } satisfies VerificationReport;
    const changes = [{ path: '/workspace/new', kind: 'create' }] as const;
    value.append('system', {
      event: 'run_finalized',
      verification_report: report,
      workspace_changes: changes,
    });
    value.releaseWriter();

    expect(restoreVerificationReport(value)).toEqual(report);
    expect(restoreWorkspaceChanges(value)).toEqual(changes);
    expect(Object.isFrozen(restoreWorkspaceChanges(value))).toBe(true);
    expect(restoreLoopResult(value, plan('react'), 'context_reset', 2)).toEqual({
      strategy: 'react',
      iterations: 2,
      termination_reason: 'context_reset',
      turns: [],
      decision_summaries: ['first', ''],
      context_reset_emitted: true,
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      step_states: { 'step-1': 'done' },
    });
  });

  it('returns explicit empty restore defaults without a final record', () => {
    const value = session();
    value.acquireWriter();
    value.append('user', { content: 'hello' });
    value.append('system', { event: 'unrelated' });
    value.releaseWriter();
    expect(restoreVerificationReport(value)).toBeNull();
    expect(restoreWorkspaceChanges(value)).toEqual([]);
    expect(restoreLoopResult(value, undefined, 'denied', 0)).toEqual({
      strategy: 'direct',
      iterations: 0,
      termination_reason: 'denied',
      turns: [],
      decision_summaries: [],
      context_reset_emitted: false,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      step_states: {},
    });
  });

  it('extracts receipts only from tool_result events and freezes the result', () => {
    const value = session();
    value.acquireWriter();
    value.append('assistant', { receipt: { wrong: true } });
    value.append('tool_result', {});
    value.append('tool_result', { receipt: { success: true } });
    value.releaseWriter();
    const receipts = extractToolReceipts(value.getEvents());
    expect(receipts).toEqual([{ success: true }]);
    expect(Object.isFrozen(receipts)).toBe(true);
  });

  it('builds immutable, receipt-backed evidence and rejects incomplete calls', () => {
    const value = session('evidence-session');
    value.acquireWriter();
    value.append('tool_call', {
      tool_call_id: 'call-1',
      step: 'step-1',
      tool: 'read_file',
      arguments: { b: 2, a: 1 },
    });
    value.append('tool_call', {
      tool_call_id: '',
      step: 'step-2',
      tool: 'read_file',
      arguments: {},
    });
    value.append('tool_result', { receipt: { success: true } });
    value.append('tool_result', {});
    value.releaseWriter();
    const loopResult: LoopResult = {
      strategy: 'react',
      iterations: 2,
      termination_reason: 'goal_satisfied',
      turns: [
        {
          iteration: 1,
          model: { content: 'done', decision_summary: 'done' },
          tool_observations: [],
          timestamp: CLOCK,
        },
      ],
      decision_summaries: ['done'],
      context_reset_emitted: false,
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
      step_states: { 'step-1': 'done' },
    };
    const report = {
      plan_revision: 3,
      all_passed: true,
      records: [
        {
          verification_id: 'verify-1',
          criterion_index: 0,
          criterion: 'answered',
          method: 'deterministic',
          adapter_id: 'adapter',
          status: 'passed',
          evidence: {},
          started_at: CLOCK,
          completed_at: CLOCK,
        },
      ],
      started_at: CLOCK,
      completed_at: CLOCK,
    } satisfies VerificationReport;
    const evidence = buildEvidence({
      session: value,
      runPlan: {
        ...plan('react'),
        registry_snapshot_refs: {
          tools: 'tools-1',
          invalid: 42,
        },
      } as unknown as RunPlan,
      loopResult,
      verificationReport: report,
      workspaceChanges: [
        {
          path: '/workspace/a',
          kind: 'created',
          before_sha256: null,
          after_sha256: 'a',
          before_mode: null,
          after_mode: 0o644,
        },
      ],
      auditEntries: [
        {
          timestamp: CLOCK,
          tool_name: 'read_file',
          verdict: 'allow',
          risk_tier: 0,
          manifest_hash_match: true,
          reason: 'allowed',
        },
      ],
      buildCommitSha: 'a'.repeat(40),
    });
    expect(evidence).toMatchObject({
      run_id: 'evidence-session',
      commit_sha: 'a'.repeat(40),
      plan_hash: 'plan-hash',
      plan_revision: 3,
      reasoning_strategy: 'react',
      registry_snapshot_refs: { tools: 'tools-1' },
      termination_reason: 'goal_satisfied',
      iterations: 2,
      turns: 1,
      decision_summaries: ['done'],
      session_events: 4,
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
      step_states: { 'step-1': 'done' },
      tool_calls: [
        {
          tool_call_id: 'call-1',
          step: 'step-1',
          tool: 'read_file',
          arguments_hash: canonicalHash({ a: 1, b: 2 }),
        },
      ],
      tool_receipts: [{ success: true }],
      verification_records: report.records,
      workspace_changes: [
        {
          path: '/workspace/a',
          kind: 'created',
          before_sha256: null,
          after_sha256: 'a',
          before_mode: null,
          after_mode: 0o644,
        },
      ],
    });
    expect(evidence.audit_entries).toHaveLength(1);
    expect(evidence.session_head_hash).toMatch(/^[0-9a-f]{64}$/u);
    for (const field of [
      evidence.registry_snapshot_refs,
      evidence.tool_calls,
      evidence.tool_receipts,
      evidence.audit_entries,
      evidence.verification_records,
      evidence.workspace_changes,
      evidence.step_states,
    ]) {
      expect(Object.isFrozen(field)).toBe(true);
    }
  });

  it('builds truthful empty evidence without a plan, report, or events', () => {
    const value = session('empty');
    const result = terminalFailure('direct', 'denied');
    expect(
      buildEvidence({
        session: value,
        runPlan: undefined,
        loopResult: result,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: undefined,
    }),
    ).toEqual({
      run_id: 'empty',
      commit_sha: 'unknown',
      plan_hash: null,
      plan_revision: null,
      reasoning_strategy: null,
      registry_snapshot_refs: {},
      termination_reason: 'denied',
      iterations: 0,
      turns: 0,
      decision_summaries: [],
      session_events: 0,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      step_states: {},
      tool_calls: [],
      tool_receipts: [],
      audit_entries: [],
      verification_records: [],
      workspace_changes: [],
      session_head_hash: null,
    });
  });
});
