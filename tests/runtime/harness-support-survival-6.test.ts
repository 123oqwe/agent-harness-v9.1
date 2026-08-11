import { describe, it, expect } from 'vitest';
import {
  buildPlanModePausedEvent,
  buildRunStateChangePausedEvent,
  buildToolCallEvent,
  buildToolCallStartEvent,
  buildToolResultEvent,
  buildToolResultPublishEvent,
  buildRunTerminatedEvent,
  buildRunStateChangeTerminatedEvent,
  buildStepStateEvent,
  buildDefaultContextLayers,
  buildDefaultSelected,
} from '../../runtime/harness-support.js';

describe('harness-support-survival-6: event builders', () => {
  it('buildPlanModePausedEvent returns correct fields', () => {
    const e = buildPlanModePausedEvent();
    expect(e.event).toBe('plan_mode_paused');
    expect(e.reason).toContain('auto_execute');
    expect(Object.keys(e).sort()).toEqual(['event', 'reason']);
  });

  it('buildRunStateChangePausedEvent returns correct fields', () => {
    const e = buildRunStateChangePausedEvent();
    expect(e.state).toBe('paused');
    expect(e.reason).toContain('auto_execute');
    expect(Object.keys(e).sort()).toEqual(['reason', 'state']);
  });

  it('buildToolCallEvent returns correct fields', () => {
    const e = buildToolCallEvent('s1', 'c1', 'read_file', { path: '/test' });
    expect(e.step).toBe('s1');
    expect(e.tool_call_id).toBe('c1');
    expect(e.tool).toBe('read_file');
    expect(e.arguments).toEqual({ path: '/test' });
    expect(Object.keys(e).sort()).toEqual(['arguments', 'step', 'tool', 'tool_call_id']);
  });

  it('buildToolCallStartEvent returns correct fields', () => {
    const e = buildToolCallStartEvent('c1', 'write_file', { path: '/test' });
    expect(e.tool_call_id).toBe('c1');
    expect(e.tool).toBe('write_file');
    expect(e.arguments).toEqual({ path: '/test' });
    expect(Object.keys(e).sort()).toEqual(['arguments', 'tool', 'tool_call_id']);
  });

  it('buildToolResultEvent returns correct fields', () => {
    const e = buildToolResultEvent('s1', 'c1', 'read_file', 'success', 'content');
    expect(e.step).toBe('s1');
    expect(e.tool_call_id).toBe('c1');
    expect(e.tool).toBe('read_file');
    expect(e.status).toBe('success');
    expect(e.observation).toBe('content');
    expect(Object.keys(e).sort()).toEqual(['observation', 'status', 'step', 'tool', 'tool_call_id']);
  });

  it('buildToolResultPublishEvent returns correct fields', () => {
    const e = buildToolResultPublishEvent('c1', 'read_file', 'success', 100, false);
    expect(e.tool_call_id).toBe('c1');
    expect(e.tool).toBe('read_file');
    expect(e.status).toBe('success');
    expect(e.bytes).toBe(100);
    expect(e.truncated).toBe(false);
    expect(Object.keys(e).sort()).toEqual(['bytes', 'status', 'tool', 'tool_call_id', 'truncated']);
  });

  it('buildRunTerminatedEvent returns correct fields', () => {
    const e = buildRunTerminatedEvent('completed', 5, 100, 50, 150);
    expect(e.event).toBe('run_terminated');
    expect(e.termination_reason).toBe('completed');
    expect(e.iterations).toBe(5);
    expect(e.usage.input_tokens).toBe(100);
    expect(e.usage.output_tokens).toBe(50);
    expect(e.usage.total_tokens).toBe(150);
    expect(Object.keys(e).sort()).toEqual(['event', 'iterations', 'termination_reason', 'usage']);
  });

  it('buildRunStateChangeTerminatedEvent returns correct fields', () => {
    const e = buildRunStateChangeTerminatedEvent('user_cancel', 3, 200, 100, 300);
    expect(e.termination_reason).toBe('user_cancel');
    expect(e.iterations).toBe(3);
    expect(e.usage.input_tokens).toBe(200);
    expect(e.usage.output_tokens).toBe(100);
    expect(e.usage.total_tokens).toBe(300);
    expect(Object.keys(e).sort()).toEqual(['iterations', 'termination_reason', 'usage']);
  });

  it('buildStepStateEvent returns correct fields', () => {
    const e = buildStepStateEvent('s1', 'running', { progress: 50 });
    expect(e.event).toBe('step_state');
    expect(e.step).toBe('s1');
    expect(e.status).toBe('running');
    expect((e as Record<string, unknown>).progress).toBe(50);
  });

  it('buildDefaultContextLayers returns 8 layer arrays', () => {
    const layers = buildDefaultContextLayers('test goal', []);
    expect(Object.keys(layers).sort()).toEqual([
      'active_plan', 'memory', 'recent_conversation', 'retrieved_evidence',
      'system_policy', 'task', 'tool_definitions', 'tool_results',
    ]);
    expect(layers.system_policy).toEqual([]);
    expect(layers.task).toHaveLength(1);
    expect(layers.retrieved_evidence).toEqual([]);
  });

  it('buildDefaultContextLayers includes RAG results', () => {
    const rag = [
      { chunk: { text: 'result1' }, citation: { source_path: '/path1', content_hash: 'hash1' } },
      { chunk: { text: 'result2' }, citation: { source_path: '/path2', content_hash: 'hash2' } },
    ];
    const layers = buildDefaultContextLayers('goal', rag);
    expect(layers.retrieved_evidence).toHaveLength(2);
  });

  it('buildDefaultSelected returns correct fields', () => {
    const sel = buildDefaultSelected([1, 2, 3]);
    expect(sel.tool_ids).toEqual([]);
    expect(sel.skill_ids).toEqual([]);
    expect(sel.rag_source_ids).toEqual(['rag-0', 'rag-1', 'rag-2']);
    expect(sel.disclosures).toEqual([]);
    expect(Object.keys(sel).sort()).toEqual(['disclosures', 'rag_source_ids', 'skill_ids', 'tool_ids']);
  });
});
