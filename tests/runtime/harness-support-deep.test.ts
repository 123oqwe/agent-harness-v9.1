import { describe, expect, it } from 'vitest';
import {
  buildProviderSelectionRequest,
  restoreVerificationReport,
  restoreWorkspaceChanges,
  restoreLoopResult,
  type ExecutionContext,
} from '../../runtime/harness-support.js';

describe('buildProviderSelectionRequest', () => {
  it('sets required_capabilities to ["text_reasoning"] for direct strategy', () => {
    const req = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: { reasoning_strategy: 'direct', run_id: 'r1', model_bindings: [{ provider: 'p1' }] } as any,
      messages: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 500 },
      registrySnapshotHash: 'abc',
      selectedTools: [],
    });
    expect(req.required_capabilities).toEqual(['text_reasoning']);
  });

  it('sets required_capabilities to ["text_reasoning", "tool_calling"] for non-direct strategy', () => {
    const req = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: { reasoning_strategy: 'react', run_id: 'r1', model_bindings: [{ provider: 'p1' }] } as any,
      messages: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 500 },
      registrySnapshotHash: 'abc',
      selectedTools: [],
    });
    expect(req.required_capabilities).toEqual(['text_reasoning', 'tool_calling']);
  });

  it('sets requires_structured_output to false when no constraints', () => {
    const req = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: { reasoning_strategy: 'direct', run_id: 'r1', model_bindings: [{ provider: 'p1' }] } as any,
      messages: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 500 },
      registrySnapshotHash: 'abc',
      selectedTools: [],
    });
    expect(req.requires_structured_output).toBe(false);
  });

  it('sets local_only in data_policy when privacy constraint has value local_only', () => {
    const req = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [{ type: 'privacy', value: 'local_only' }] } as any,
      runPlan: { reasoning_strategy: 'direct', run_id: 'r1', model_bindings: [{ provider: 'p1' }] } as any,
      messages: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 500 },
      registrySnapshotHash: 'abc',
      selectedTools: [],
    });
    expect(req.data_policy.local_only).toBe(true);
  });

  it('sets local_only to false when privacy constraint has different value', () => {
    const req = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [{ type: 'privacy', value: 'high' }] } as any,
      runPlan: { reasoning_strategy: 'direct', run_id: 'r1', model_bindings: [{ provider: 'p1' }] } as any,
      messages: [],
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 500 },
      registrySnapshotHash: 'abc',
      selectedTools: [],
    });
    expect(req.data_policy.local_only).toBe(false);
  });

  it('sets estimated_input_tokens based on messages length', () => {
    const req = buildProviderSelectionRequest({
      task: { goal: 'test', success_criteria: [], constraints: [] } as any,
      runPlan: { reasoning_strategy: 'direct', run_id: 'r1', model_bindings: [{ provider: 'p1' }] } as any,
      messages: [{ role: 'user', content: 'hello world' }] as any,
      modelBudget: { remaining_tokens: 1000, max_output_tokens: 500 },
      registrySnapshotHash: 'abc',
      selectedTools: [],
    });
    expect(req.estimated_input_tokens).toBeGreaterThan(0);
    expect(typeof req.estimated_input_tokens).toBe('number');
  });
});

describe('restoreVerificationReport', () => {
  it('returns null when no run_finalized event', () => {
    const session = { getEvents: () => [{ type: 'system', data: { event: 'run_terminated' } }] } as any;
    expect(restoreVerificationReport(session)).toBeNull();
  });

  it('returns verification_report from run_finalized event', () => {
    const session = { getEvents: () => [
      { type: 'system', data: { event: 'run_finalized', verification_report: { status: 'pass' } } },
    ] } as any;
    expect(restoreVerificationReport(session)).toEqual({ status: 'pass' });
  });

  it('returns null when verification_report is null in run_finalized', () => {
    const session = { getEvents: () => [
      { type: 'system', data: { event: 'run_finalized', verification_report: null } },
    ] } as any;
    expect(restoreVerificationReport(session)).toBeNull();
  });

  it('returns null when verification_report is missing in run_finalized', () => {
    const session = { getEvents: () => [
      { type: 'system', data: { event: 'run_finalized' } },
    ] } as any;
    expect(restoreVerificationReport(session)).toBeNull();
  });

  it('finds the latest run_finalized event (searches in reverse)', () => {
    const session = { getEvents: () => [
      { type: 'system', data: { event: 'run_finalized', verification_report: { status: 'old' } } },
      { type: 'system', data: { event: 'run_finalized', verification_report: { status: 'new' } } },
    ] } as any;
    expect(restoreVerificationReport(session)).toEqual({ status: 'new' });
  });

  it('skips non-system events', () => {
    const session = { getEvents: () => [
      { type: 'assistant', data: { event: 'run_finalized', verification_report: { status: 'pass' } } },
    ] } as any;
    expect(restoreVerificationReport(session)).toBeNull();
  });
});

describe('restoreWorkspaceChanges', () => {
  it('returns empty array when no run_finalized event', () => {
    const session = { getEvents: () => [{ type: 'system', data: { event: 'run_terminated' } }] } as any;
    expect(restoreWorkspaceChanges(session)).toEqual([]);
  });

  it('returns workspace_changes from run_finalized event', () => {
    const changes = [{ path: '/test.txt', operation: 'write' }];
    const session = { getEvents: () => [
      { type: 'system', data: { event: 'run_finalized', workspace_changes: changes } },
    ] } as any;
    expect(restoreWorkspaceChanges(session)).toEqual(changes);
  });

  it('returns empty array when workspace_changes is missing', () => {
    const session = { getEvents: () => [
      { type: 'system', data: { event: 'run_finalized', workspace_changes: [] } },
    ] } as any;
    expect(restoreWorkspaceChanges(session)).toEqual([]);
  });

  it('finds the latest run_finalized event', () => {
    const session = { getEvents: () => [
      { type: 'system', data: { event: 'run_finalized', workspace_changes: [{ path: '/old' }] } },
      { type: 'system', data: { event: 'run_finalized', workspace_changes: [{ path: '/new' }] } },
    ] } as any;
    expect(restoreWorkspaceChanges(session)).toEqual([{ path: '/new' }]);
  });
});

