import { describe, it, expect, vi } from 'vitest';
import {
  canonicalize,
  canonicalHash,
  normalizeWorkspaceToolInput,
  terminalFailure,
  sanitizeMessages,
  buildProviderSelectionRequest,
  gatewayResultToModelTurn,
  restoreVerificationReport,
  restoreWorkspaceChanges,
  restoreLoopResult,
  extractToolReceipts,
  buildEvidence,
  validateExecutionContext,
  assertTimestamp,
  createDefaultExecutionContext,
} from '../../runtime/harness-support.js';
import { DurableSession } from '../../session/durable-session.js';

// ===== canonicalize + canonicalHash =====

describe('harness-support: canonicalize', () => {
  it('sorts object keys', () => {
    const result = JSON.stringify(canonicalize({ b: 1, a: 2 }));
    expect(result).toBe('{"a":2,"b":1}');
  });

  it('handles nested objects', () => {
    const result = JSON.stringify(canonicalize({ z: { y: 1, x: 2 } }));
    expect(result).toBe('{"z":{"x":2,"y":1}}');
  });

  it('handles arrays (order preserved)', () => {
    const result = JSON.stringify(canonicalize([3, 1, 2]));
    expect(result).toBe('[3,1,2]');
  });

  it('handles primitives', () => {
    expect(canonicalize(null)).toBe(null);
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize('hello')).toBe('hello');
    expect(canonicalize(true)).toBe(true);
  });

  it('handles undefined values by omitting them', () => {
    const result = JSON.stringify(canonicalize({ a: 1, b: undefined, c: 3 }));
    expect(result).toBe('{"a":1,"c":3}');
  });
});

describe('harness-support: canonicalHash', () => {
  it('produces consistent hash for same input', () => {
    const h1 = canonicalHash({ b: 1, a: 2 });
    const h2 = canonicalHash({ a: 2, b: 1 });
    expect(h1).toBe(h2);
  });

  it('produces different hash for different input', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });

  it('returns full 64-char hex when no length specified', () => {
    const hash = canonicalHash({ a: 1 });
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('truncates to specified length', () => {
    const hash = canonicalHash({ a: 1 }, 16);
    expect(hash).toHaveLength(16);
  });
});

// ===== normalizeWorkspaceToolInput =====

describe('harness-support: normalizeWorkspaceToolInput', () => {
  it('normalizes relative path for read_file', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'src/file.ts' });
    expect(result.path).toBe('/workspace/src/file.ts');
  });

  it('normalizes relative path for write_file', () => {
    const result = normalizeWorkspaceToolInput('write_file', { path: 'out.txt' });
    expect(result.path).toBe('/workspace/out.txt');
  });

  it('normalizes relative path for edit_file', () => {
    const result = normalizeWorkspaceToolInput('edit_file', { path: 'file.ts' });
    expect(result.path).toBe('/workspace/file.ts');
  });

  it('normalizes relative path for list_directory', () => {
    const result = normalizeWorkspaceToolInput('list_directory', { path: 'src' });
    expect(result.path).toBe('/workspace/src');
  });

  it('normalizes relative path for execute_command', () => {
    const result = normalizeWorkspaceToolInput('execute_command', { cwd: 'project' });
    expect(result.cwd).toBe('/workspace/project');
  });

  it('normalizes relative path for search_files', () => {
    const result = normalizeWorkspaceToolInput('search_files', { root: 'src' });
    expect(result.root).toBe('/workspace/src');
  });

  it('normalizes relative path for create_artifact', () => {
    const result = normalizeWorkspaceToolInput('create_artifact', { path: 'output' });
    expect(result.path).toBe('/workspace/output');
  });

  it('normalizes relative path for parse_document', () => {
    const result = normalizeWorkspaceToolInput('parse_document', { path: 'doc.pdf' });
    expect(result.path).toBe('/workspace/doc.pdf');
  });

  it('keeps absolute Unix path unchanged', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: '/workspace/file.ts' });
    expect(result.path).toBe('/workspace/file.ts');
  });

  it('keeps absolute Windows path unchanged (C:)', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'C:\\Users\\file.ts' });
    expect(result.path).toBe('C:\\Users\\file.ts');
  });

  it('keeps absolute Windows path unchanged (D:)', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'D:/data/file.ts' });
    expect(result.path).toBe('D:/data/file.ts');
  });

  it('throws on path containing ..', () => {
    expect(() => normalizeWorkspaceToolInput('read_file', { path: '../etc/passwd' }))
      .toThrow('workspace-relative path must not contain ..');
  });

  it('normalizes path with backslash separators', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'src\\file.ts' });
    expect(result.path).toBe('/workspace/src/file.ts');
  });

  it('normalizes path with mixed separators', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'src\\sub/file.ts' });
    expect(result.path).toBe('/workspace/src/sub/file.ts');
  });

  it('normalizes path with . segments', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: './src/./file.ts' });
    expect(result.path).toBe('/workspace/src/file.ts');
  });

  it('normalizes empty path to /workspace', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: '' });
    expect(result.path).toBe('/workspace');
  });

  it('returns input unchanged for unknown tool', () => {
    const result = normalizeWorkspaceToolInput('unknown_tool', { path: 'file.ts' });
    expect(result.path).toBe('file.ts');
  });

  it('returns input unchanged when path field is not a string', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 42 });
    expect(result.path).toBe(42);
  });

  it('returns input unchanged when path field is missing', () => {
    const result = normalizeWorkspaceToolInput('read_file', { other: 'value' });
    expect(result.other).toBe('value');
    expect(result.path).toBeUndefined();
  });
});

// ===== terminalFailure =====

describe('harness-support: terminalFailure', () => {
  it('creates a LoopResult with correct strategy and termination', () => {
    const result = terminalFailure('direct', 'denied');
    expect(result.strategy).toBe('direct');
    expect(result.termination_reason).toBe('denied');
    expect(result.iterations).toBe(0);
    expect(result.turns).toEqual([]);
    expect(result.decision_summaries).toEqual([]);
    expect(result.context_reset_emitted).toBe(false);
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    expect(Object.isFrozen(result.step_states)).toBe(true);
  });

  it('creates terminalFailure with context_reset termination', () => {
    const result = terminalFailure('react', 'context_reset');
    expect(result.strategy).toBe('react');
    expect(result.termination_reason).toBe('context_reset');
  });
});

// ===== sanitizeMessages =====

describe('harness-support: sanitizeMessages', () => {
  it('preserves role and content', () => {
    const result = sanitizeMessages([{ role: 'user', content: 'hello' }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content).toBe('hello');
  });

  it('preserves reasoning_content when present', () => {
    const result = sanitizeMessages([
      { role: 'assistant', content: 'answer', reasoning_content: 'thinking' },
    ]);
    expect(result[0]!.reasoning_content).toBe('thinking');
  });

  it('omits reasoning_content when undefined', () => {
    const result = sanitizeMessages([
      { role: 'assistant', content: 'answer' },
    ]);
    expect(result[0]!.reasoning_content).toBeUndefined();
  });

  it('preserves tool_call_id when present', () => {
    const result = sanitizeMessages([
      { role: 'tool', content: 'result', tool_call_id: 'call-1' },
    ]);
    expect(result[0]!.tool_call_id).toBe('call-1');
  });

  it('omits tool_call_id when undefined', () => {
    const result = sanitizeMessages([
      { role: 'tool', content: 'result' },
    ]);
    expect(result[0]!.tool_call_id).toBeUndefined();
  });

  it('preserves tool_calls when present', () => {
    const calls = [{ id: '1', name: 'test', arguments: {} }];
    const result = sanitizeMessages([
      { role: 'assistant', content: '', tool_calls: calls },
    ]);
    expect(result[0]!.tool_calls).toEqual(calls);
  });

  it('omits tool_calls when undefined', () => {
    const result = sanitizeMessages([
      { role: 'assistant', content: '' },
    ]);
    expect(result[0]!.tool_calls).toBeUndefined();
  });
});

// ===== buildProviderSelectionRequest =====

describe('harness-support: buildProviderSelectionRequest', () => {
  function makeInput(overrides: any = {}) {
    return {
      task: {
        id: 'task-1',
        goal: 'test goal',
        constraints: [],
        ...overrides.task,
      },
      runPlan: {
        reasoning_strategy: 'direct',
        model_bindings: [{ provider: 'test-provider' }],
        run_plan_hash: 'hash-1',
        revision: 1,
        registry_snapshot_refs: {},
        ...overrides.runPlan,
      },
      messages: [{ role: 'user', content: 'hello' }],
      modelBudget: { max_output_tokens: 4096 },
      registrySnapshotHash: 'snap-hash',
      selectedTools: [],
      ...overrides,
    };
  }

  it('builds request with messages and model budget', () => {
    const result = buildProviderSelectionRequest(makeInput());
    expect(result.request.max_tokens).toBe(4096);
    expect(result.request.messages).toHaveLength(1);
  });

  it('throws when no provider bound', () => {
    const input = makeInput({
      runPlan: { reasoning_strategy: 'direct', model_bindings: [], run_plan_hash: 'h', revision: 1, registry_snapshot_refs: {} },
    });
    expect(() => buildProviderSelectionRequest(input)).toThrow('RunPlan must bind a model provider');
  });

  it('includes tools when selectedTools non-empty', () => {
    const input = makeInput({
      selectedTools: [{ name: 'read_file' }],
    });
    const result = buildProviderSelectionRequest(input);
    expect(result.request.tools).toHaveLength(1);
  });

  it('omits tools when selectedTools empty', () => {
    const result = buildProviderSelectionRequest(makeInput());
    expect(result.request.tools).toBeUndefined();
  });

  it('sets tool_choice to function when required_tool specified', () => {
    const input = makeInput({
      selectedTools: [{ name: 'read_file' }],
      directive: { system_instruction: 'test', required_tool: 'read_file' },
    });
    const result = buildProviderSelectionRequest(input);
    expect(result.request.tool_choice).toEqual({
      type: 'function',
      function: { name: 'read_file' },
    });
  });

  it('throws when required_tool not in selectedTools', () => {
    const input = makeInput({
      selectedTools: [{ name: 'read_file' }],
      directive: { system_instruction: 'test', required_tool: 'write_file' },
    });
    expect(() => buildProviderSelectionRequest(input)).toThrow('required model tool is not selected: write_file');
  });

  it('sets tool_choice to none when allowed_tools empty', () => {
    const input = makeInput({
      directive: { system_instruction: 'test', allowed_tools: [] },
    });
    const result = buildProviderSelectionRequest(input);
    expect(result.request.tool_choice).toBe('none');
  });

  it('sets tool_choice to auto when directive present but no required/allowed', () => {
    const input = makeInput({
      directive: { system_instruction: 'test' },
    });
    const result = buildProviderSelectionRequest(input);
    expect(result.request.tool_choice).toBe('auto');
  });

  it('omits tool_choice when no directive', () => {
    const result = buildProviderSelectionRequest(makeInput());
    expect(result.request.tool_choice).toBeUndefined();
  });

  it('includes system instruction as first message when directive has it', () => {
    const input = makeInput({
      directive: { system_instruction: 'You are a helpful assistant' },
    });
    const result = buildProviderSelectionRequest(input);
    expect(result.request.messages[0]!.role).toBe('system');
    expect(result.request.messages[0]!.content).toBe('You are a helpful assistant');
  });

  it('sets local_only data policy when privacy constraint present', () => {
    const input = makeInput({
      task: { id: 't1', goal: 'g', constraints: [{ type: 'privacy', value: 'local_only' }] },
    });
    const result = buildProviderSelectionRequest(input);
    expect(result.data_policy.local_only).toBe(true);
    expect(result.data_policy.allowed_regions).toEqual(['local']);
    expect(result.data_policy.max_retention_days).toBe(0);
  });

  it('sets non-local data policy when no privacy constraint', () => {
    const result = buildProviderSelectionRequest(makeInput());
    expect(result.data_policy.local_only).toBe(false);
    expect(result.data_policy.allowed_regions).toEqual(['local', 'cn', 'us', 'eu']);
    expect(result.data_policy.max_retention_days).toBe(365);
  });

  it('training_allowed is always false', () => {
    const result = buildProviderSelectionRequest(makeInput());
    expect(result.data_policy.training_allowed).toBe(false);
  });

  it('requires text_reasoning only for direct strategy', () => {
    const result = buildProviderSelectionRequest(makeInput());
    expect(result.required_capabilities).toEqual(['text_reasoning']);
  });

  it('requires text_reasoning + tool_calling for non-direct strategy', () => {
    const input = makeInput({
      runPlan: { reasoning_strategy: 'react', model_bindings: [{ provider: 'p' }], run_plan_hash: 'h', revision: 1, registry_snapshot_refs: {} },
    });
    const result = buildProviderSelectionRequest(input);
    expect(result.required_capabilities).toEqual(['text_reasoning', 'tool_calling']);
  });

  it('sets allowed_provider_ids from model_restriction constraints', () => {
    const input = makeInput({
      task: { id: 't1', goal: 'g', constraints: [{ type: 'model_restriction', value: 'provider-a' }] },
    });
    const result = buildProviderSelectionRequest(input);
    expect(result.policy.allowed_provider_ids).toEqual(['provider-a']);
  });

  it('omits allowed_provider_ids when no model_restriction', () => {
    const result = buildProviderSelectionRequest(makeInput());
    expect(result.policy.allowed_provider_ids).toBeUndefined();
  });
});

// ===== gatewayResultToModelTurn =====

describe('harness-support: gatewayResultToModelTurn', () => {
  it('converts basic response', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'hello' },
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(result.content).toBe('hello');
    expect(result.decision_summary).toBe('hello');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it('preserves reasoning_content', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'answer', reasoning_content: 'thinking' },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(result.reasoning_content).toBe('thinking');
  });

  it('omits reasoning_content when undefined', () => {
    const result = gatewayResultToModelTurn({
      response: { content: 'answer' },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(result.reasoning_content).toBeUndefined();
  });

  it('preserves tool_calls', () => {
    const result = gatewayResultToModelTurn({
      response: {
        content: '',
        tool_calls: [{ id: '1', name: 'test', arguments: { x: 1 } }],
      },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(result.tool_calls!).toHaveLength(1);
    expect(result.tool_calls![0]!.name).toBe('test');
    expect(result.tool_calls![0]!.arguments).toEqual({ x: 1 });
  });

  it('omits tool_calls when undefined', () => {
    const result = gatewayResultToModelTurn({
      response: { content: '' },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(result.tool_calls).toBeUndefined();
  });

  it('preserves stop_reason', () => {
    const result = gatewayResultToModelTurn({
      response: { content: '', stop_reason: 'stop' },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(result.stop_reason).toBe('stop');
  });

  it('omits stop_reason when undefined', () => {
    const result = gatewayResultToModelTurn({
      response: { content: '' },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(result.stop_reason).toBeUndefined();
  });

  it('truncates decision_summary to 200 chars', () => {
    const longContent = 'a'.repeat(300);
    const result = gatewayResultToModelTurn({
      response: { content: longContent },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(result.decision_summary).toHaveLength(200);
  });

  it('omits usage when undefined', () => {
    const result = gatewayResultToModelTurn({
      response: { content: '' },
    } as any);
    expect(result.usage).toBeUndefined();
  });
});

// ===== restoreVerificationReport =====

describe('harness-support: restoreVerificationReport', () => {
  it('returns null when no run_finalized event', () => {
    const session = new DurableSession('run-1');
    expect(restoreVerificationReport(session)).toBeNull();
  });

  it('returns report from run_finalized event', () => {
    const session = new DurableSession('run-1');
    const report = { records: [], summary: 'pass' };
    session.acquireWriter();
    session.append('system', { event: 'run_finalized', verification_report: report });
    const result = restoreVerificationReport(session);
    expect(result!).toEqual(report);
  });

  it('returns null when run_finalized has null report', () => {
    const session = new DurableSession('run-1');
    session.acquireWriter();
    session.append('system', { event: 'run_finalized', verification_report: null });
    expect(restoreVerificationReport(session)).toBeNull();
  });
});

// ===== restoreWorkspaceChanges =====

describe('harness-support: restoreWorkspaceChanges', () => {
  it('returns empty array when no run_finalized event', () => {
    const session = new DurableSession('run-1');
    expect(restoreWorkspaceChanges(session)).toEqual([]);
  });

  it('returns changes from run_finalized event', () => {
    const session = new DurableSession('run-1');
    const changes = [{ path: '/workspace/file.ts', action: 'write' }];
    session.acquireWriter();
    session.append('system', { event: 'run_finalized', workspace_changes: changes });
    const result = restoreWorkspaceChanges(session);
    expect(result!).toEqual(changes);
  });

  it('returns empty array when workspace_changes is undefined', () => {
    const session = new DurableSession('run-1');
    session.acquireWriter();
    session.append('system', { event: 'run_finalized' });
    expect(restoreWorkspaceChanges(session)).toEqual([]);
  });

  it('returns frozen result', () => {
    const session = new DurableSession('run-1');
    const result = restoreWorkspaceChanges(session);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ===== restoreLoopResult =====

describe('harness-support: restoreLoopResult', () => {
  it('builds LoopResult with default strategy when no runPlan', () => {
    const session = new DurableSession('run-1');
    const result = restoreLoopResult(session, undefined, 'completed', 5);
    expect(result.strategy).toBe('direct');
    expect(result.iterations).toBe(5);
    expect(result.termination_reason).toBe('completed');
  });

  it('builds LoopResult with strategy from runPlan', () => {
    const session = new DurableSession('run-1');
    const result = restoreLoopResult(session, { reasoning_strategy: 'react' } as any, 'completed', 3);
    expect(result.strategy).toBe('react');
  });

  it('sets context_reset_emitted when termination is context_reset', () => {
    const session = new DurableSession('run-1');
    const result = restoreLoopResult(session, undefined, 'context_reset', 2);
    expect(result.context_reset_emitted).toBe(true);
  });

  it('sets context_reset_emitted false for other terminations', () => {
    const session = new DurableSession('run-1');
    const result = restoreLoopResult(session, undefined, 'completed', 1);
    expect(result.context_reset_emitted).toBe(false);
  });

  it('collects step states from system events', () => {
    const session = new DurableSession('run-1');
    session.acquireWriter();
    session.append('system', { event: 'step_state', step: 's1', status: 'completed' });
    session.append('system', { event: 'step_state', step: 's2', status: 'running' });
    const result = restoreLoopResult(session, undefined, 'completed', 2);
    expect(result.step_states).toEqual({ s1: 'completed', s2: 'running' });
  });

  it('collects usage from run_terminated event', () => {
    const session = new DurableSession('run-1');
    const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
    session.acquireWriter();
    session.append('system', { event: 'run_terminated', usage });
    const result = restoreLoopResult(session, undefined, 'completed', 1);
    expect(result.usage).toEqual(usage);
  });

  it('collects decision_summaries from assistant events', () => {
    const session = new DurableSession('run-1');
    session.acquireWriter();
    session.append('assistant', { decision_summary: 'summary-1' });
    session.acquireWriter();
    session.append('assistant', { decision_summary: 'summary-2' });
    const result = restoreLoopResult(session, undefined, 'completed', 2);
    expect(result.decision_summaries).toEqual(['summary-1', 'summary-2']);
  });

  it('uses empty string for missing decision_summary', () => {
    const session = new DurableSession('run-1');
    session.acquireWriter();
    session.append('assistant', { other: 'data' });
    const result = restoreLoopResult(session, undefined, 'completed', 1);
    expect(result.decision_summaries).toEqual(['']);
  });
});

// ===== extractToolReceipts =====

describe('harness-support: extractToolReceipts', () => {
  it('returns empty for no tool_result events', () => {
    expect(extractToolReceipts([])).toEqual([]);
  });

  it('extracts receipts from tool_result events', () => {
    const events = [
      { type: 'tool_result', data: { receipt: { id: 'r1' } } },
      { type: 'tool_result', data: { receipt: { id: 'r2' } } },
    ] as any;
    const result = extractToolReceipts(events);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'r1' });
  });

  it('skips tool_result events without receipt', () => {
    const events = [
      { type: 'tool_result', data: {} },
      { type: 'tool_result', data: { receipt: { id: 'r1' } } },
    ] as any;
    const result = extractToolReceipts(events);
    expect(result).toHaveLength(1);
  });

  it('returns frozen result', () => {
    const result = extractToolReceipts([]);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ===== buildEvidence =====

describe('harness-support: buildEvidence', () => {
  it('builds evidence with correct fields', () => {
    const session = new DurableSession('run-1');
    session.acquireWriter();
    session.append('assistant', { decision_summary: 'test' });
    session.releaseWriter();
    const loopResult = {
      strategy: 'direct',
      iterations: 3,
      termination_reason: 'completed',
      turns: [],
      decision_summaries: ['test'],
      context_reset_emitted: false,
      usage: { input_tokens: 10, output_tokens: 20 },
      step_states: {},
    } as any;
    const result = buildEvidence({
      session,
      runPlan: { run_plan_hash: 'hash-1', revision: 1, reasoning_strategy: 'direct', registry_snapshot_refs: { a: 'ref-1' } } as any,
      loopResult,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: 'abc123',
    });
    expect(result.run_id).toBe('run-1');
    expect(result.commit_sha).toBe('abc123');
    expect(result.plan_hash).toBe('hash-1');
    expect(result.plan_revision).toBe(1);
    expect(result.reasoning_strategy).toBe('direct');
    expect(result.iterations).toBe(3);
    expect(result.termination_reason).toBe('completed');
    expect(result.turns).toBe(0);
  });

  it('uses unknown when buildCommitSha is undefined', () => {
    const session = new DurableSession('run-1');
    const result = buildEvidence({
      session,
      runPlan: undefined,
      loopResult: { turns: [], decision_summaries: [], usage: { input_tokens: 0, output_tokens: 0 }, step_states: {}, iterations: 0, termination_reason: 'completed', strategy: 'direct', context_reset_emitted: false } as any,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: undefined,
    });
    expect(result.commit_sha).toBe('unknown');
  });

  it('uses null for plan fields when runPlan is undefined', () => {
    const session = new DurableSession('run-1');
    const result = buildEvidence({
      session,
      runPlan: undefined,
      loopResult: { turns: [], decision_summaries: [], usage: { input_tokens: 0, output_tokens: 0 }, step_states: {}, iterations: 0, termination_reason: 'completed', strategy: 'direct', context_reset_emitted: false } as any,
      verificationReport: null,
      workspaceChanges: [],
      auditEntries: [],
      buildCommitSha: undefined,
    });
    expect(result.plan_hash).toBeNull();
    expect(result.plan_revision).toBeNull();
    expect(result.reasoning_strategy).toBeNull();
  });
});

// ===== validateExecutionContext + assertTimestamp =====

describe('harness-support: validateExecutionContext', () => {
  it('throws for invalid context', () => {
    expect(() => validateExecutionContext({
      tenant_id: '', user_id: 'u1', session_id: 's1', run_id: 'r1',
    } as any)).toThrow();
  });
});

describe('harness-support: assertTimestamp', () => {
  it('passes for valid ISO string', () => {
    expect(assertTimestamp('2026-01-01T00:00:00Z', 'test')).toBe('2026-01-01T00:00:00Z');
  });

  it('throws for invalid timestamp', () => {
    expect(() => assertTimestamp('invalid', 'test')).toThrow();
  });
});

describe('harness-support: createDefaultExecutionContext', () => {
  it('creates context with default tenant and user', () => {
    const ctx = createDefaultExecutionContext('run-1');
    expect(ctx.tenant_id).toBe('default-tenant');
    expect(ctx.user_id).toBe('default-user');
    expect(ctx.session_id).toBe('run-1');
    expect(ctx.run_id).toBe('run-1');
    expect(ctx.plan_id).toBe('plan-run-1');
    expect(ctx.step_id).toBe('step-001');
    expect(ctx.attempt_id).toBe('attempt-001');
    expect(ctx.operation_id).toBe('op-run-1');
    expect(ctx.idempotency_key).toBe('idem-run-1');
  });

  it('uses provided clock when given', () => {
    const fixedTime = '2026-01-01T00:00:00Z';
    const ctx = createDefaultExecutionContext('run-1', () => fixedTime);
    expect(ctx.clock()).toBe(fixedTime);
  });
});
