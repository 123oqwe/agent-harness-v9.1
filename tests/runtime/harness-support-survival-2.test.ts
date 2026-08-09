import { describe, it, expect, vi } from 'vitest';
import {
  canonicalize,
  canonicalHash,
  normalizeWorkspaceToolInput,
  terminalFailure,
  recordTerminalFailure,
  sanitizeMessages,
  buildProviderSelectionRequest,
  gatewayResultToModelTurn,
  restoreVerificationReport,
  restoreWorkspaceChanges,
  restoreLoopResult,
  extractToolReceipts,
  buildEvidence,
  assertTimestamp,
  createDefaultExecutionContext,
  validateExecutionContext,
} from '../../runtime/harness-support.js';
import { DurableSession } from '../../session/durable-session.js';
import type { RunPlan } from '../../contracts/index.js';
import type { LoopResult, ModelTurn } from '../../runtime/loop.js';

function appendToSession(session: DurableSession, type: string, data: unknown): void {
  session.acquireWriter();
  session["append"](type as any, data as any);
  session.releaseWriter();
}

function makeRunPlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    run_id: 'test-run',
    run_plan_hash: 'plan-hash-123',
    reasoning_strategy: 'direct',
    model_bindings: [{ provider: 'test-provider' }],
    revision: 1,
    registry_snapshot_refs: { registry: 'snap-1' },
    tool_names: [],
    skill_ids: [],
    ...overrides,
  } as unknown as RunPlan;
}

// ============================================================
// normalizeWorkspaceToolInput - path normalization (L175-198)
// ============================================================

describe('Harness-support survival-2 - normalizeWorkspaceToolInput', () => {
  it('normalizes relative path to /workspace/ prefix', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'test.txt' });
    expect(result.path).toBe('/workspace/test.txt');
  });

  it('normalizes path with subdirectories', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'sub/dir/file.txt' });
    expect(result.path).toBe('/workspace/sub/dir/file.txt');
  });

  it('preserves absolute path starting with /', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: '/workspace/test.txt' });
    expect(result.path).toBe('/workspace/test.txt');
  });

  it('preserves Windows-style absolute path', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'C:\\Users\\test' });
    expect(result.path).toBe('C:\\Users\\test');
  });

  it('preserves lowercase Windows-style absolute path', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'd:/data/file.txt' });
    expect(result.path).toBe('d:/data/file.txt');
  });

  it('throws on path containing ..', () => {
    expect(() => normalizeWorkspaceToolInput('read_file', { path: '../etc/passwd' }))
      .toThrow('workspace-relative path must not contain ..');
  });

  it('throws on path with .. in middle', () => {
    expect(() => normalizeWorkspaceToolInput('read_file', { path: 'sub/../etc' }))
      .toThrow('workspace-relative path must not contain ..');
  });

  it('normalizes empty segments to /workspace', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: '.' });
    expect(result.path).toBe('/workspace');
  });

  it('normalizes path with backslash separators', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'sub\\dir\\file.txt' });
    expect(result.path).toBe('/workspace/sub/dir/file.txt');
  });

  it('returns input unchanged for unknown tool name', () => {
    const result = normalizeWorkspaceToolInput('unknown_tool', { path: 'test.txt' });
    expect(result).toEqual({ path: 'test.txt' });
  });

  it('returns input unchanged when path field is not a string', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 123 });
    expect(result).toEqual({ path: 123 });
  });

  it('returns input unchanged when path field is missing', () => {
    const result = normalizeWorkspaceToolInput('read_file', { other: 'value' });
    expect(result).toEqual({ other: 'value' });
  });

  it('handles edit_file tool with cwd field', () => {
    const result = normalizeWorkspaceToolInput('execute_command', { cwd: 'subdir' });
    expect(result.cwd).toBe('/workspace/subdir');
  });

  it('handles search_files tool with root field', () => {
    const result = normalizeWorkspaceToolInput('search_files', { root: 'subdir' });
    expect(result.root).toBe('/workspace/subdir');
  });

  it('filters empty and dot segments', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'a/./b//c' });
    expect(result.path).toBe('/workspace/a/b/c');
  });
});

// ============================================================
// buildProviderSelectionRequest - directive handling (L278-362)
// ============================================================

describe('Harness-support survival-2 - buildProviderSelectionRequest', () => {
  it('includes tools when selectedTools is non-empty', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan(),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [{ name: 'read_file' } as any],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.request.tools).toBeDefined();
    expect(result.request.tools).toHaveLength(1);
  });

  it('excludes tools when selectedTools is empty', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan(),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.request.tools).toBeUndefined();
  });

  it('throws when required_tool is not in selectedTools', () => {
    expect(() => buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan(),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [{ name: 'read_file' } as any],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
      directive: { system_instruction: 'sys', required_tool: 'write_file' } as any,
    })).toThrow('required model tool is not selected: write_file');
  });

  it('sets tool_choice to auto when directive is undefined', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan(),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [{ name: 'read_file' } as any],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.request.tool_choice).toBeUndefined();
  });

  it('sets local_only data policy when privacy constraint is local_only', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [{ type: 'privacy', value: 'local_only' }] } as any,
      runPlan: makeRunPlan(),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.data_policy.local_only).toBe(true);
    expect(result.data_policy.allowed_regions).toEqual(['local']);
    expect(result.data_policy.max_retention_days).toBe(0);
  });

  it('sets non-local data policy when no privacy constraint', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan(),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.data_policy.local_only).toBe(false);
    expect(result.data_policy.allowed_regions).toEqual(['local', 'cn', 'us', 'eu']);
    expect(result.data_policy.max_retention_days).toBe(365);
    expect(result.data_policy.training_allowed).toBe(false);
  });

  it('requires text_reasoning and tool_calling for non-direct strategy', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan({ reasoning_strategy: 'react' }),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.required_capabilities).toEqual(['text_reasoning', 'tool_calling']);
  });

  it('requires only text_reasoning for direct strategy', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan({ reasoning_strategy: 'direct' }),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.required_capabilities).toEqual(['text_reasoning']);
  });

  it('throws when RunPlan has no model binding', () => {
    expect(() => buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan({ model_bindings: [] }),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    })).toThrow('RunPlan must bind a model provider');
  });

  it('filters model_restriction constraints into allowed_provider_ids', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [{ type: 'model_restriction', value: 'glm-5.2' }] } as any,
      runPlan: makeRunPlan(),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.policy.allowed_provider_ids).toEqual(['glm-5.2']);
    expect(result.run_plan.allowed_provider_ids).toEqual(['glm-5.2']);
  });

  it('sets allowed_provider_ids to undefined when no model_restriction', () => {
    const result = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: makeRunPlan(),
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 4096 },
      messages: [],
    });
    expect(result.policy.allowed_provider_ids).toBeUndefined();
  });
});

// ============================================================
// gatewayResultToModelTurn - result conversion (L365-398)
// ============================================================

describe('Harness-support survival-2 - gatewayResultToModelTurn', () => {
  it('converts basic result with content and usage', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'hello world' },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.content).toBe('hello world');
    expect(result.decision_summary).toBe('hello world');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('includes reasoning_content when present', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'answer', reasoning_content: 'thinking...' },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.reasoning_content).toBe('thinking...');
  });

  it('excludes reasoning_content when absent', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'answer' },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.reasoning_content).toBeUndefined();
  });

  it('includes tool_calls when present', () => {
    const result = gatewayResultToModelTurn({
      response: {
        content: 'using tool',
        tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test' } }],
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.tool_calls).toBeDefined();
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0]!.id).toBe('tc-1');
    expect(result.tool_calls![0]!.name).toBe('read_file');
  });

  it('excludes tool_calls when absent', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'answer' },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.tool_calls).toBeUndefined();
  });

  it('includes stop_reason when present', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'answer', stop_reason: 'tool_use' },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.stop_reason).toBe('tool_use');
  });

  it('excludes stop_reason when absent', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'answer' },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.stop_reason).toBeUndefined();
  });

  it('truncates decision_summary to 200 chars', () => {
    const longContent = 'x'.repeat(300);
    const result = gatewayResultToModelTurn({
      response: { content: longContent },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.decision_summary).toHaveLength(200);
    expect(result.decision_summary).toBe(longContent.slice(0, 200));
  });

  it('excludes usage when absent', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'answer' },
      usage: undefined,
    } as any);
    expect(result.usage).toBeUndefined();
  });
});

// ============================================================
// extractToolReceipts (L479-500)
// ============================================================

describe('Harness-support survival-2 - extractToolReceipts', () => {
  it('extracts receipts from tool_result events', () => {
    const events = [
      { type: 'tool_result', data: { receipt: { tool_name: 'read_file', success: true } } },
      { type: 'tool_result', data: { receipt: { tool_name: 'write_file', success: false } } },
    ] as any;
    const receipts = extractToolReceipts(events);
    expect(receipts).toHaveLength(2);
    expect((receipts[0] as any).tool_name).toBe('read_file');
    expect((receipts[1] as any).tool_name).toBe('write_file');
  });

  it('skips events without receipt field', () => {
    const events = [
      { type: 'tool_result', data: { status: 'ok' } },
      { type: 'tool_result', data: { receipt: { tool_name: 'read_file' } } },
    ] as any;
    const receipts = extractToolReceipts(events);
    expect(receipts).toHaveLength(1);
  });

  it('skips non-tool_result events', () => {
    const events = [
      { type: 'assistant', data: { receipt: { tool_name: 'read_file' } } },
      { type: 'system', data: { receipt: { tool_name: 'read_file' } } },
    ] as any;
    const receipts = extractToolReceipts(events);
    expect(receipts).toHaveLength(0);
  });

  it('returns empty array for empty events', () => {
    const receipts = extractToolReceipts([]);
    expect(receipts).toHaveLength(0);
  });
});

// ============================================================
// buildEvidence (L502-556)
// ============================================================

describe('Harness-support survival-2 - buildEvidence', () => {
  it('builds evidence with exact run_id from session', () => {
    const session = new DurableSession('test-evidence-run');
    appendToSession(session, 'assistant', { decision_summary: 'test' });
    const evidence = buildEvidence({
      session,
      runPlan: makeRunPlan(),
      loopResult: {
        strategy: 'direct', iterations: 1, termination_reason: 'completed',
        turns: [], decision_summaries: ['test'], context_reset_emitted: false,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        step_states: {},
      } as LoopResult,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: 'abc123',
    });
    expect(evidence.run_id).toBe('test-evidence-run');
    expect(evidence.commit_sha).toBe('abc123');
    expect(evidence.plan_hash).toBe('plan-hash-123');
    expect(evidence.reasoning_strategy).toBe('direct');
    expect(evidence.termination_reason).toBe('completed');
    expect(evidence.iterations).toBe(1);
    expect(evidence.turns).toBe(0);
    expect(evidence.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('defaults commit_sha to unknown when buildCommitSha is undefined', () => {
    const session = new DurableSession('test-run');
    const evidence = buildEvidence({
      session,
      runPlan: makeRunPlan(),
      loopResult: {
        strategy: 'direct', iterations: 0, termination_reason: 'denied',
        turns: [], decision_summaries: [], context_reset_emitted: false,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        step_states: {},
      } as LoopResult,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: undefined,
    });
    expect(evidence.commit_sha).toBe('unknown');
  });

  it('defaults plan_hash to null when runPlan is undefined', () => {
    const session = new DurableSession('test-run');
    const evidence = buildEvidence({
      session,
      runPlan: undefined,
      loopResult: {
        strategy: 'direct', iterations: 0, termination_reason: 'denied',
        turns: [], decision_summaries: [], context_reset_emitted: false,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        step_states: {},
      } as LoopResult,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: undefined,
    });
    expect(evidence.plan_hash).toBeNull();
    expect(evidence.reasoning_strategy).toBeNull();
  });

  it('extracts tool_calls from session events', () => {
    const session = new DurableSession('test-run');
    appendToSession(session, 'tool_call', {
      tool_call_id: 'tc-1', step: 'step-1', tool: 'read_file',
      arguments: { path: '/workspace/test' },
    });
    const evidence = buildEvidence({
      session,
      runPlan: makeRunPlan(),
      loopResult: {
        strategy: 'direct', iterations: 0, termination_reason: 'completed',
        turns: [], decision_summaries: [], context_reset_emitted: false,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        step_states: {},
      } as LoopResult,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: 'abc',
    });
    expect(evidence.tool_calls).toHaveLength(1);
    expect(evidence.tool_calls[0]!.tool_call_id).toBe('tc-1');
    expect(evidence.tool_calls[0]!.tool).toBe('read_file');
    expect(evidence.tool_calls[0]!.arguments_hash).toBeDefined();
  });

  it('sets session_head_hash from last event', () => {
    const session = new DurableSession('test-run');
    appendToSession(session, 'assistant', { decision_summary: 'first' });
    appendToSession(session, 'assistant', { decision_summary: 'second' });
    const evidence = buildEvidence({
      session,
      runPlan: makeRunPlan(),
      loopResult: {
        strategy: 'direct', iterations: 0, termination_reason: 'completed',
        turns: [], decision_summaries: [], context_reset_emitted: false,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        step_states: {},
      } as LoopResult,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: 'abc',
    });
    expect(evidence.session_head_hash).toBeDefined();
    expect(typeof evidence.session_head_hash).toBe('string');
  });

  it('sets session_head_hash to null when no events', () => {
    const session = new DurableSession('test-run');
    const evidence = buildEvidence({
      session,
      runPlan: makeRunPlan(),
      loopResult: {
        strategy: 'direct', iterations: 0, termination_reason: 'completed',
        turns: [], decision_summaries: [], context_reset_emitted: false,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        step_states: {},
      } as LoopResult,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: 'abc',
    });
    expect(evidence.session_head_hash).toBeNull();
  });
});

// ============================================================
// canonicalHash and canonicalize (L139-170)
// ============================================================

describe('Harness-support survival-2 - canonicalHash', () => {
  it('produces consistent hash for same input', () => {
    const a = canonicalHash({ b: 2, a: 1 });
    const b = canonicalHash({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('produces different hash for different input', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });

  it('truncates to specified length', () => {
    const full = canonicalHash({ a: 1 });
    const truncated = canonicalHash({ a: 1 }, 16);
    expect(truncated).toBe(full.slice(0, 16));
    expect(truncated).toHaveLength(16);
  });

  it('returns full hash when length is undefined', () => {
    const hash = canonicalHash({ a: 1 });
    expect(hash).toHaveLength(64);
  });
});

// ============================================================
// assertTimestamp (L132-138)
// ============================================================

describe('Harness-support survival-2 - assertTimestamp', () => {
  it('returns valid ISO timestamp', () => {
    const ts = '2026-08-09T00:00:00.000Z';
    expect(assertTimestamp(ts, 'test')).toBe(ts);
  });

  it('throws on invalid timestamp', () => {
    expect(() => assertTimestamp('not-a-date', 'test')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => assertTimestamp('', 'test')).toThrow();
  });
});

// ============================================================
// restoreLoopResult (L434-478)
// ============================================================

describe('Harness-support survival-2 - restoreLoopResult', () => {
  it('restores from session events with exact usage and step_states', () => {
    const session = new DurableSession('test-restore');
    appendToSession(session, 'system', { event: 'step_state', step: 'step-1', status: 'done' });
    appendToSession(session, 'system', { event: 'run_terminated', termination_reason: 'completed', iterations: 2, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } });
    appendToSession(session, 'assistant', { decision_summary: 'summary-1' });

    const result = restoreLoopResult(session, makeRunPlan(), 'completed', 2);
    expect(result.termination_reason).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 10, total_tokens: 30 });
    expect(result.strategy).toBe('direct');
    expect(result.step_states).toHaveProperty('step-1', 'done');
    expect(result.decision_summaries).toEqual(['summary-1']);
  });

  it('defaults strategy to direct when runPlan is undefined', () => {
    const session = new DurableSession('test');
    const result = restoreLoopResult(session, undefined, 'denied', 0);
    expect(result.strategy).toBe('direct');
  });

  it('sets context_reset_emitted when termination is context_reset', () => {
    const session = new DurableSession('test');
    const result = restoreLoopResult(session, undefined, 'context_reset', 0);
    expect(result.context_reset_emitted).toBe(true);
  });

  it('does not set context_reset_emitted for non-context_reset termination', () => {
    const session = new DurableSession('test');
    const result = restoreLoopResult(session, undefined, 'completed', 0);
    expect(result.context_reset_emitted).toBe(false);
  });
});

// ============================================================
// restoreVerificationReport (L400-415)
// ============================================================

describe('Harness-support survival-2 - restoreVerificationReport', () => {
  it('returns verification_report from run_finalized event', () => {
    const session = new DurableSession('test');
    const report = { all_passed: true, records: [] };
    appendToSession(session, 'system', { event: 'run_finalized', verification_report: report, workspace_changes: [] });
    const result = restoreVerificationReport(session);
    expect(result).toEqual(report);
  });

  it('returns null when no run_finalized event', () => {
    const session = new DurableSession('test');
    appendToSession(session, 'assistant', { decision_summary: 'test' });
    expect(restoreVerificationReport(session)).toBeNull();
  });

  it('returns null when run_finalized has null verification_report', () => {
    const session = new DurableSession('test');
    appendToSession(session, 'system', { event: 'run_finalized', verification_report: null, workspace_changes: [] });
    expect(restoreVerificationReport(session)).toBeNull();
  });
});

// ============================================================
// restoreWorkspaceChanges (L417-432)
// ============================================================

describe('Harness-support survival-2 - restoreWorkspaceChanges', () => {
  it('returns workspace_changes from run_finalized event', () => {
    const session = new DurableSession('test');
    const changes = [{ path: '/workspace/test', operation: 'create' }];
    appendToSession(session, 'system', { event: 'run_finalized', verification_report: null, workspace_changes: changes });
    const result = restoreWorkspaceChanges(session);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(changes[0]);
  });

  it('returns empty array when no run_finalized event', () => {
    const session = new DurableSession('test');
    expect(restoreWorkspaceChanges(session)).toHaveLength(0);
  });

  it('returns empty array when workspace_changes is undefined', () => {
    const session = new DurableSession('test');
    appendToSession(session, 'system', { event: 'run_finalized', verification_report: null });
    expect(restoreWorkspaceChanges(session)).toHaveLength(0);
  });
});
