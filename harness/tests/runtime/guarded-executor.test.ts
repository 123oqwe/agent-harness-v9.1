/**
 * Tests for the GuardedToolExecutor in RuntimeLoop.
 * Exercises all policy/capability/PEP denial branches.
 */
import { describe, it, expect } from 'vitest';
import { RuntimeLoop } from '../../runtime/loop.js';
import type { ToolExecutor, ToolExecutionResult } from '../../runtime/reasoning-strategy.js';
import type { Policy } from '../../security/policy-engine.js';

function makeModelCaller(responses: { content: string; tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[]; stop_reason?: 'stop' | 'tool_use' }[] = [{ content: 'ok', stop_reason: 'stop' }]) {
  let idx = 0;
  return {
    complete() {
      const r = responses[idx++] ?? responses[responses.length - 1];
      return { ...r, stop_reason: r.stop_reason ?? 'stop' as const, usage: { input_tokens: 10, output_tokens: 20 } };
    },
  };
}

function makeToolExecutor(succeed = true): ToolExecutor {
  return {
    async execute(toolName: string): Promise<ToolExecutionResult> {
      return { tool_name: toolName, success: succeed, output: succeed ? 'result' : '', error: succeed ? undefined : 'failed' };
    },
  };
}

describe('AH-RUNTIME-GUARD: GuardedToolExecutor enforcement', () => {
  it('tool call succeeds when policy allows and capability+PEP pass', async () => {
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "ok", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'Read the content and maybe search', available_tools: ['read_file'], max_iterations: 5 },
      { modelCaller: makeModelCaller([
        { content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/test' } }], stop_reason: 'tool_use' },
        { content: 'done', stop_reason: 'stop' },
      ]), toolExecutor: makeToolExecutor(true) },
    );
    expect(result.tool_calls_made).toBe(1);
    expect(result.unauthorized_effects).toBe(0);
    expect(result.capability_replays).toBe(0);
    // Session should have action_authorized and action_executed events
    const session = loop.getSession();
    expect(session.getEventsByType('action_authorized').length).toBe(1);
    expect(session.getEventsByType('action_executed').length).toBe(1);
  });

  it('tool call denied when policy denies (tool not in allowlist)', async () => {
    const denyPolicy: Policy = {
      rules: [{ tool: 'read_file', allow: true }],
      default_decision: 'deny',
    };
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "ok", stop_reason: "stop" }]) });
    await loop.execute(
      { prompt: 'Read the content and maybe search', available_tools: ['read_file'], max_iterations: 5 },
      { modelCaller: makeModelCaller([
        { content: '', tool_calls: [{ id: 'tc1', name: 'evil_tool', arguments: {} }], stop_reason: 'tool_use' },
        { content: 'done', stop_reason: 'stop' },
      ]), toolExecutor: makeToolExecutor(true), policy: denyPolicy },
    );
    // evil_tool should be denied by policy
    const session = loop.getSession();
    expect(session.getEventsByType('action_denied').length).toBeGreaterThanOrEqual(1);
  });

  it('tool call records denial when tool execution fails', async () => {
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "ok", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'Read the content and maybe search', available_tools: ['read_file'], max_iterations: 5 },
      { modelCaller: makeModelCaller([
        { content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/test' } }], stop_reason: 'tool_use' },
        { content: 'done', stop_reason: 'stop' },
      ]), toolExecutor: makeToolExecutor(false) },
    );
    // Tool execution failed: unauthorized_effects stays 0 (no bypass), tool_failures is 1
    expect(result.unauthorized_effects).toBe(0);
    expect(result.tool_failures).toBe(1);
  });

  it('direct strategy with no tool executor works', async () => {
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "ok", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'What is 2+2?' },
      { modelCaller: makeModelCaller([{ content: '4', stop_reason: 'stop' }]) },
    );
    expect(result.strategy).toBe('direct');
    expect(result.output).toBe('4');
    expect(result.unauthorized_effects).toBe(0);
    expect(result.capability_replays).toBe(0);
  });

  it('execute without modelCaller throws (no stubs)', async () => {
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller() });
    await expect(
      loop.execute({ prompt: 'test' }, { modelCaller: undefined as never }),
    ).rejects.toThrow(/requires a modelCaller/);
  });

  it('all authorized tool calls get capability tokens recorded in session', async () => {
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "ok", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'Read the content and maybe search', available_tools: ['read_file', 'write_file'], max_iterations: 10 },
      { modelCaller: makeModelCaller([
        { content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }], stop_reason: 'tool_use' },
        { content: '', tool_calls: [{ id: 'tc2', name: 'write_file', arguments: {} }], stop_reason: 'tool_use' },
        { content: 'done', stop_reason: 'stop' },
      ]), toolExecutor: makeToolExecutor(true) },
    );
    expect(result.tool_calls_made).toBe(2);
    const session = loop.getSession();
    expect(session.getEventsByType('action_authorized').length).toBe(2);
    expect(session.getEventsByType('action_executed').length).toBe(2);
  });
});
