import { describe, it, expect } from 'vitest';
import { DirectStrategy } from '../../runtime/direct.js';
import { ReactStrategy } from '../../runtime/react.js';
import { PlanExecuteStrategy, type RunPlan } from '../../runtime/plan-execute.js';
import type { StrategyContext, ToolExecutor, ModelCaller } from '../../runtime/reasoning-strategy.js';
import type { ProviderRequest, ParsedResponse } from '../../gateway/provider.js';

function ctx(): StrategyContext {
  return {
    run_id: 'run-001',
    step_id: 'step-001',
    attempt_id: 'attempt-001',
    tenant_id: 'tenant-001',
    subject: 'agent-001',
    routing: {
      strategy: 'direct',
      reason: { code: 'TEST', message: 'test' },
      features: {
        needs_tools: false,
        tool_count: 0,
        dependency_count: 0,
        effect_risk: 'none',
        requires_interaction: false,
        requires_file_transaction: false,
        uncertainty: 0,
        steps_estimated: 1,
        domains: ['general'],
      },
      model_hint: 'scripted_test',
      frozen_snapshot: true,
    },
  };
}

function makeModelCaller(responses: ParsedResponse[]): ModelCaller {
  let idx = 0;
  return {
    complete(_req: ProviderRequest): ParsedResponse {
      return responses[idx++] ?? responses[responses.length - 1];
    },
  };
}

describe('AH-RUNTIME-001: Direct strategy', () => {
  it('makes exactly one model call', async () => {
    const model = makeModelCaller([{ content: 'hello', stop_reason: 'stop' }]);
    const strategy = new DirectStrategy();
    const result = await strategy.execute(
      [{ role: 'user', content: 'hi' }],
      ctx(),
      model,
    );
    expect(result.model_calls).toBe(1);
    expect(result.output).toBe('hello');
    expect(result.stop_reason).toBe('completed');
  });

  it('makes zero tool calls', async () => {
    const model = makeModelCaller([{ content: 'hello', stop_reason: 'stop' }]);
    const strategy = new DirectStrategy();
    const result = await strategy.execute(
      [{ role: 'user', content: 'hi' }],
      ctx(),
      model,
    );
    expect(result.tool_calls_made).toBe(0);
  });

  it('strategy violation when model requests tools', async () => {
    const model = makeModelCaller([{
      content: '',
      tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      stop_reason: 'tool_use',
    }]);
    const strategy = new DirectStrategy();
    const result = await strategy.execute(
      [{ role: 'user', content: 'hi' }],
      ctx(),
      model,
    );
    expect(result.stop_reason).toBe('error');
    expect(result.denied_actions[0]).toContain('strategy_violation');
  });

  it('does not switch to react or plan_execute', async () => {
    const model = makeModelCaller([{
      content: '',
      tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      stop_reason: 'tool_use',
    }]);
    const strategy = new DirectStrategy();
    const result = await strategy.execute(
      [{ role: 'user', content: 'hi' }],
      ctx(),
      model,
    );
    expect(result.strategy).toBe('direct');
  });
});

describe('AH-RUNTIME-001: ReAct strategy', () => {
  it('makes an observation that changes the next action', async () => {
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        return {
          tool_name: toolName,
          success: true,
          output: 'file content: hello world',
        };
      },
    };
    const model = makeModelCaller([
      { content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }], stop_reason: 'tool_use' },
      { content: 'The file contains hello world', stop_reason: 'stop' },
    ]);
    const strategy = new ReactStrategy();
    const result = await strategy.execute(
      [{ role: 'user', content: 'Read the file and tell me what it contains' }],
      ctx(),
      model,
      toolExecutor,
    );
    expect(result.stop_reason).toBe('completed');
    expect(result.tool_calls_made).toBe(1);
    expect(result.observations.length).toBe(1);
    expect(result.observations[0]).toContain('hello world');
    expect(result.output).toContain('hello world');
  });

  it('stops on max iterations', async () => {
    const model = makeModelCaller(
      Array(20).fill({ content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }], stop_reason: 'tool_use' }),
    );
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        return { tool_name: toolName, success: true, output: 'data' };
      },
    };
    const strategy = new ReactStrategy();
    const result = await strategy.execute(
      [{ role: 'user', content: 'keep reading' }],
      { ...ctx(), max_iterations: 3 },
      model,
      toolExecutor,
    );
    expect(result.stop_reason).toBe('max_iterations');
    expect(result.model_calls).toBe(3);
  });

  it('handles tool failure gracefully', async () => {
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        return { tool_name: toolName, success: false, output: '', error: 'file not found' };
      },
    };
    const model = makeModelCaller([
      { content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }], stop_reason: 'tool_use' },
      { content: 'The file was not found', stop_reason: 'stop' },
    ]);
    const strategy = new ReactStrategy();
    const result = await strategy.execute(
      [{ role: 'user', content: 'Read the file' }],
      ctx(),
      model,
      toolExecutor,
    );
    expect(result.stop_reason).toBe('completed');
    expect(result.observations[0]).toContain('ERROR');
  });

  it('does not persist private reasoning text', async () => {
    const model = makeModelCaller([{ content: 'response', stop_reason: 'stop' }]);
    const strategy = new ReactStrategy();
    const result = await strategy.execute(
      [{ role: 'user', content: 'hi' }],
      ctx(),
      model,
    );
    // Observations should only contain tool results, not internal reasoning
    expect(result.observations.length).toBe(0);
  });
});

describe('AH-RUNTIME-001: Plan+Execute strategy', () => {
  it('executes frozen DAG in topological order', async () => {
    const plan: RunPlan = {
      revision: 1,
      frozen: true,
      steps: [
        { id: 'c', tool_name: 'write_file', arguments: {}, dependencies: ['a', 'b'] },
        { id: 'a', tool_name: 'read_file', arguments: {}, dependencies: [] },
        { id: 'b', tool_name: 'search_files', arguments: {}, dependencies: ['a'] },
      ],
    };
    const executionOrder: string[] = [];
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        executionOrder.push(toolName);
        return { tool_name: toolName, success: true, output: 'ok' };
      },
    };
    const model = makeModelCaller([{ content: 'Summary', stop_reason: 'stop' }]);
    const strategy = new PlanExecuteStrategy({ plan });
    const result = await strategy.execute(
      [{ role: 'user', content: 'Do the task' }],
      ctx(),
      model,
      toolExecutor,
    );
    expect(result.stop_reason).toBe('completed');
    // a must execute before b, b before c
    expect(executionOrder.indexOf('read_file')).toBeLessThan(executionOrder.indexOf('search_files'));
    expect(executionOrder.indexOf('search_files')).toBeLessThan(executionOrder.indexOf('write_file'));
  });

  it('failed dependency blocks dependents', async () => {
    const plan: RunPlan = {
      revision: 1,
      frozen: true,
      steps: [
        { id: 'a', tool_name: 'read_file', arguments: {}, dependencies: [] },
        { id: 'b', tool_name: 'write_file', arguments: {}, dependencies: ['a'] },
      ],
    };
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        if (toolName === 'read_file') {
          return { tool_name: toolName, success: false, output: '', error: 'not found' };
        }
        return { tool_name: toolName, success: true, output: 'ok' };
      },
    };
    const model = makeModelCaller([{ content: 'Summary', stop_reason: 'stop' }]);
    const strategy = new PlanExecuteStrategy({ plan });
    const result = await strategy.execute(
      [{ role: 'user', content: 'Do the task' }],
      ctx(),
      model,
      toolExecutor,
    );
    expect(result.stop_reason).toBe('error');
    expect(result.denied_actions.some((a) => a.includes('dependency_failed'))).toBe(true);
  });

  it('detects cyclic dependencies', async () => {
    const plan: RunPlan = {
      revision: 1,
      frozen: true,
      steps: [
        { id: 'a', tool_name: 'read_file', arguments: {}, dependencies: ['b'] },
        { id: 'b', tool_name: 'write_file', arguments: {}, dependencies: ['a'] },
      ],
    };
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        return { tool_name: toolName, success: true, output: 'ok' };
      },
    };
    const model = makeModelCaller([{ content: 'Summary', stop_reason: 'stop' }]);
    const strategy = new PlanExecuteStrategy({ plan });
    const result = await strategy.execute(
      [{ role: 'user', content: 'Do the task' }],
      ctx(),
      model,
      toolExecutor,
    );
    expect(result.stop_reason).toBe('error');
    expect(result.denied_actions.some((a) => a.includes('cycle_detected'))).toBe(true);
  });

  it('replanning creates new revision', async () => {
    const plan1: RunPlan = {
      revision: 1,
      frozen: true,
      steps: [{ id: 'a', tool_name: 'read_file', arguments: {}, dependencies: [] }],
    };
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        return { tool_name: toolName, success: true, output: 'ok' };
      },
    };
    const model = makeModelCaller([{ content: 'Summary', stop_reason: 'stop' }]);
    const strategy1 = new PlanExecuteStrategy({ plan: plan1 });
    const result1 = await strategy1.execute(
      [{ role: 'user', content: 'Do the task' }],
      ctx(),
      model,
      toolExecutor,
    );
    expect(result1.stop_reason).toBe('completed');

    // New plan with revision 2
    const plan2: RunPlan = {
      revision: 2,
      frozen: true,
      steps: [
        { id: 'a', tool_name: 'read_file', arguments: {}, dependencies: [] },
        { id: 'b', tool_name: 'write_file', arguments: {}, dependencies: ['a'] },
      ],
    };
    const strategy2 = new PlanExecuteStrategy({ plan: plan2 });
    const result2 = await strategy2.execute(
      [{ role: 'user', content: 'Do the task' }],
      ctx(),
      model,
      toolExecutor,
    );
    expect(result2.stop_reason).toBe('completed');
    expect(result2.tool_calls_made).toBe(2);
  });
});
