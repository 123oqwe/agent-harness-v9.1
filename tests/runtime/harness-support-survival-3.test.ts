import { describe, it, expect } from 'vitest';
import { DurableSession } from '../../session/durable-session.js';
import {
  normalizeWorkspaceToolInput,
  restoreVerificationReport,
  restoreWorkspaceChanges,
  restoreLoopResult,
  extractToolReceipts,
  assertValidHookPayload,
  assertValidPreTurnMessages,
  assertNoToolSetExpansion,
  buildProviderSelectionRequest,
} from '../../runtime/harness-support.js';

// ---- normalizeWorkspaceToolInput (L175-198) ----
describe('harness-support-survival-3: normalizeWorkspaceToolInput', () => {
  it('canonicalizes relative path with forward slashes', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'foo/bar.txt' });
    expect(result.path).toBe('/workspace/foo/bar.txt');
  });

  it('canonicalizes relative path with backslashes', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'foo\\bar.txt' });
    expect(result.path).toBe('/workspace/foo/bar.txt');
  });

  it('does not modify absolute Unix path', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: '/workspace/foo.txt' });
    expect(result.path).toBe('/workspace/foo.txt');
  });

  it('does not modify absolute Windows path', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'C:\\Users\\test\\file.txt' });
    expect(result.path).toBe('C:\\Users\\test\\file.txt');
  });

  it('does not modify Windows path with forward slashes', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'C:/Users/test/file.txt' });
    expect(result.path).toBe('C:/Users/test/file.txt');
  });

  it('throws when path contains ..', () => {
    expect(() => normalizeWorkspaceToolInput('read_file', { path: '../etc/passwd' })).toThrow('..');
  });

  it('throws when path contains .. in middle', () => {
    expect(() => normalizeWorkspaceToolInput('read_file', { path: 'foo/../bar' })).toThrow('..');
  });

  it('canonicalizes empty segments (foo//bar)', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'foo//bar' });
    expect(result.path).toBe('/workspace/foo/bar');
  });

  it('canonicalizes . segments (foo/./bar)', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 'foo/./bar' });
    expect(result.path).toBe('/workspace/foo/bar');
  });

  it('returns /workspace for empty path after normalization', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: '.' });
    expect(result.path).toBe('/workspace');
  });

  it('returns input unchanged for unknown tool', () => {
    const result = normalizeWorkspaceToolInput('unknown_tool', { path: 'foo' });
    expect(result).toEqual({ path: 'foo' });
  });

  it('returns input unchanged when path field is not a string', () => {
    const result = normalizeWorkspaceToolInput('read_file', { path: 42 });
    expect(result).toEqual({ path: 42 });
  });

  it('handles execute_command with cwd field', () => {
    const result = normalizeWorkspaceToolInput('execute_command', { cwd: 'project' });
    expect(result.cwd).toBe('/workspace/project');
  });

  it('handles search_files with root field', () => {
    const result = normalizeWorkspaceToolInput('search_files', { root: 'src' });
    expect(result.root).toBe('/workspace/src');
  });
});

// ---- restoreVerificationReport (L400-416) ----
describe('harness-support-survival-3: restoreVerificationReport', () => {
  it('returns null when no run_finalized event exists', () => {
    const session = new DurableSession('test1');
    expect(restoreVerificationReport(session)).toBeNull();
  });

  it('returns verification_report from run_finalized event', () => {
    const session = new DurableSession('test2');
    session.acquireWriter();
    session.append('system', {
      event: 'run_finalized',
      termination_reason: 'goal_satisfied',
      verification_report: { all_passed: true, results: [] },
      workspace_changes: [],
    });
    session.releaseWriter();
    const result = restoreVerificationReport(session);
    expect(result).toEqual({ all_passed: true, results: [] });
  });

  it('returns null when verification_report is null in run_finalized', () => {
    const session = new DurableSession('test3');
    session.acquireWriter();
    session.append('system', {
      event: 'run_finalized',
      termination_reason: 'verification_failed',
      verification_report: null,
      workspace_changes: [],
    });
    session.releaseWriter();
    expect(restoreVerificationReport(session)).toBeNull();
  });

  it('uses the last run_finalized event', () => {
    const session = new DurableSession('test4');
    session.acquireWriter();
    session.append('system', {
      event: 'run_finalized',
      termination_reason: 'goal_satisfied',
      verification_report: { all_passed: true, results: [] },
      workspace_changes: [],
    });
    session.releaseWriter();
    session.acquireWriter();
    session.append('system', {
      event: 'run_finalized',
      termination_reason: 'goal_satisfied',
      verification_report: { all_passed: false, results: [] },
      workspace_changes: [],
    });
    session.releaseWriter();
    const result = restoreVerificationReport(session);
    expect(result).toEqual({ all_passed: false, results: [] });
  });
});

// ---- restoreWorkspaceChanges (L417-433) ----
describe('harness-support-survival-3: restoreWorkspaceChanges', () => {
  it('returns empty array when no run_finalized event', () => {
    const session = new DurableSession('test5');
    const result = restoreWorkspaceChanges(session);
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns workspace_changes from run_finalized event', () => {
    const session = new DurableSession('test6');
    const changes = [{ path: '/workspace/test.txt', action: 'write' }];
    session.acquireWriter();
    session.append('system', {
      event: 'run_finalized',
      termination_reason: 'goal_satisfied',
      verification_report: null,
      workspace_changes: changes,
    });
    session.releaseWriter();
    const result = restoreWorkspaceChanges(session);
    expect(result).toEqual(changes);
  });

  it('returns empty array when workspace_changes is undefined', () => {
    const session = new DurableSession('test7');
    session.acquireWriter();
    session.append('system', {
      event: 'run_finalized',
      termination_reason: 'goal_satisfied',
      verification_report: null,
    });
    session.releaseWriter();
    const result = restoreWorkspaceChanges(session);
    expect(result).toEqual([]);
  });
});

// ---- restoreLoopResult (L434-479) ----
describe('harness-support-survival-3: restoreLoopResult', () => {
  it('restores with correct strategy from runPlan', () => {
    const session = new DurableSession('test8');
    const result = restoreLoopResult(session, { reasoning_strategy: 'react' } as any, 'goal_satisfied', 3);
    expect(result.strategy).toBe('react');
  });

  it('defaults to direct strategy when runPlan is undefined', () => {
    const session = new DurableSession('test9');
    const result = restoreLoopResult(session, undefined, 'goal_satisfied', 1);
    expect(result.strategy).toBe('direct');
  });

  it('sets context_reset_emitted when termination is context_reset', () => {
    const session = new DurableSession('test10');
    const result = restoreLoopResult(session, undefined, 'context_reset', 2);
    expect(result.context_reset_emitted).toBe(true);
  });

  it('sets context_reset_emitted=false for other terminations', () => {
    const session = new DurableSession('test11');
    const result = restoreLoopResult(session, undefined, 'goal_satisfied', 1);
    expect(result.context_reset_emitted).toBe(false);
  });

  it('extracts usage from run_terminated event', () => {
    const session = new DurableSession('test12');
    session.acquireWriter();
    session.append('system', { event: 'run_terminated', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } });
    session.releaseWriter();
    const result = restoreLoopResult(session, undefined, 'goal_satisfied', 1);
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  });

  it('defaults usage to zeros when no run_terminated event', () => {
    const session = new DurableSession('test13');
    const result = restoreLoopResult(session, undefined, 'goal_satisfied', 1);
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });

  it('extracts step_states from step_state events', () => {
    const session = new DurableSession('test14');
    session.acquireWriter();
    session.append('system', { event: 'step_state', step: 'step1', status: 'completed' });
    session.releaseWriter();
    session.acquireWriter();
    session.append('system', { event: 'step_state', step: 'step2', status: 'pending' });
    session.releaseWriter();
    const result = restoreLoopResult(session, undefined, 'goal_satisfied', 2);
    expect(result.step_states).toEqual({ step1: 'completed', step2: 'pending' });
  });

  it('extracts decision_summaries from assistant events', () => {
    const session = new DurableSession('test15');
    session.acquireWriter();
    session.append('assistant', { decision_summary: 'first decision' });
    session.releaseWriter();
    session.acquireWriter();
    session.append('assistant', { decision_summary: 'second decision' });
    session.releaseWriter();
    const result = restoreLoopResult(session, undefined, 'goal_satisfied', 2);
    expect(result.decision_summaries).toEqual(['first decision', 'second decision']);
  });

  it('uses empty string for missing decision_summary in assistant event', () => {
    const session = new DurableSession('test16');
    session.acquireWriter();
    session.append('assistant', { /* no decision_summary */ });
    session.releaseWriter();
    const result = restoreLoopResult(session, undefined, 'goal_satisfied', 1);
    expect(result.decision_summaries).toEqual(['']);
  });
});

// ---- extractToolReceipts (L479-490) ----
describe('harness-support-survival-3: extractToolReceipts', () => {
  it('extracts receipts from tool_result events', () => {
    const events = [
      { type: 'tool_result', data: { receipt: { tool_name: 'read_file', success: true } } },
      { type: 'tool_result', data: { receipt: { tool_name: 'write_file', success: false } } },
    ] as any;
    const result = extractToolReceipts(events);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ tool_name: 'read_file', success: true });
  });

  it('skips tool_result events without receipt', () => {
    const events = [
      { type: 'tool_result', data: { /* no receipt */ } },
      { type: 'tool_result', data: { receipt: { tool_name: 'read_file' } } },
    ] as any;
    const result = extractToolReceipts(events);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for non-tool_result events', () => {
    const events = [
      { type: 'system', data: { event: 'test' } },
      { type: 'assistant', data: { content: 'hi' } },
    ] as any;
    const result = extractToolReceipts(events);
    expect(result).toEqual([]);
  });

  it('returns frozen array', () => {
    const events = [] as any;
    const result = extractToolReceipts(events);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ---- assertValidHookPayload (L559) ----
describe('harness-support-survival-3: assertValidHookPayload', () => {
  it('passes for a plain object', () => {
    expect(() => assertValidHookPayload({ key: 'value' }, 'test')).not.toThrow();
  });

  it('throws for null', () => {
    expect(() => assertValidHookPayload(null, 'test')).toThrow();
  });

  it('throws for array', () => {
    expect(() => assertValidHookPayload([1, 2], 'test')).toThrow();
  });

  it('throws for string', () => {
    expect(() => assertValidHookPayload('not-object', 'test')).toThrow();
  });

  it('throws for number', () => {
    expect(() => assertValidHookPayload(42, 'test')).toThrow();
  });

  it('throws for undefined', () => {
    expect(() => assertValidHookPayload(undefined, 'test')).toThrow();
  });
});

// ---- assertValidPreTurnMessages (L565) ----
describe('harness-support-survival-3: assertValidPreTurnMessages', () => {
  it('passes for object with messages array', () => {
    expect(() => assertValidPreTurnMessages({ messages: [] })).not.toThrow();
  });

  it('passes for object with non-empty messages array', () => {
    expect(() => assertValidPreTurnMessages({ messages: [{ role: 'user', content: 'hi' }] })).not.toThrow();
  });

  it('throws when messages is not an array', () => {
    expect(() => assertValidPreTurnMessages({ messages: 'not-array' })).toThrow();
  });

  it('throws when messages is missing', () => {
    expect(() => assertValidPreTurnMessages({ /* no messages */ })).toThrow();
  });

  it('throws for null payload', () => {
    expect(() => assertValidPreTurnMessages(null)).toThrow();
  });
});

// ---- assertNoToolSetExpansion (L581) ----
describe('harness-support-survival-3: assertNoToolSetExpansion', () => {
  it('passes when tools are the same', () => {
    const tools = [{ name: 'read_file' }, { name: 'write_file' }];
    expect(() => assertNoToolSetExpansion(tools, tools)).not.toThrow();
  });

  it('passes when effective tools are a subset of original', () => {
    const original = [{ name: 'read_file' }, { name: 'write_file' }];
    const effective = [{ name: 'read_file' }];
    expect(() => assertNoToolSetExpansion(original, effective)).not.toThrow();
  });

  it('passes when effective tools are empty', () => {
    const original = [{ name: 'read_file' }];
    expect(() => assertNoToolSetExpansion(original, [])).not.toThrow();
  });

  it('throws when effective tools have extra tool', () => {
    const original = [{ name: 'read_file' }];
    const effective = [{ name: 'read_file' }, { name: 'write_file' }];
    expect(() => assertNoToolSetExpansion(original, effective)).toThrow();
  });

  it('throws when effective tools have completely different tool', () => {
    const original = [{ name: 'read_file' }];
    const effective = [{ name: 'write_file' }];
    expect(() => assertNoToolSetExpansion(original, effective)).toThrow();
  });
});
