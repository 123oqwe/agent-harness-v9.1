import { describe, it, expect } from 'vitest';
import { DagExecutor, type DagDefinition } from '../../gateway/dag-executor.js';
import type { ManagedGateway } from '../../gateway/managed-gateway.js';

function mockGateway(): ManagedGateway {
  const calls: Array<{ prompt: string; stepId: string }> = [];
  const gw = {
    complete: async (prompt: string, opts: any) => {
      calls.push({ prompt, stepId: opts.stepId });
      return {
        response: `response-for-${opts.stepId}`,
        usage: { success: true, cost_usd: 0.01, prompt_tokens: 100, completion_tokens: 50, latency_ms: 200 },
        model_used: 'test-model',
        provider_used: 'test-provider',
        fallback_triggered: false,
      };
    },
  };
  return gw as unknown as ManagedGateway;
}

describe('DagExecutor', () => {
  it('builds a linear workflow DAG', () => {
    const dag = DagExecutor.buildWorkflow({
      name: 'test',
      steps: [
        { type: 'reasoning', tier: 'work', capabilities: ['code'], prompt: 'step 1' },
        { type: 'writing', tier: 'work', capabilities: ['code'], prompt: 'step 2' },
      ],
    });
    expect(dag.nodes).toHaveLength(2);
    expect(dag.edges).toHaveLength(1);
    expect(dag.edges[0]!.from).toBe('test-step-1');
    expect(dag.edges[0]!.to).toBe('test-step-2');
  });

  it('builds a DAG with custom dependencies', () => {
    const dag = DagExecutor.buildWorkflow({
      name: 'parallel',
      steps: [
        { type: 'reasoning', tier: 'work', capabilities: ['code'], prompt: 'a' },
        { type: 'reasoning', tier: 'work', capabilities: ['code'], prompt: 'b' },
        { type: 'writing', tier: 'work', capabilities: ['code'], prompt: 'c', depends_on: ['parallel-step-1', 'parallel-step-2'] },
      ],
    });
    expect(dag.edges.length).toBeGreaterThanOrEqual(2);
  });

  it('detects cycles in DAG', async () => {
    const gw = mockGateway();
    const executor = new DagExecutor(gw);
    const dag: DagDefinition = {
      nodes: [
        { step_id: 'a', node_type: 'reasoning', tier: 'work', required_capabilities: ['code'], prompt: 'a', depends_on: ['b'] },
        { step_id: 'b', node_type: 'reasoning', tier: 'work', required_capabilities: ['code'], prompt: 'b', depends_on: ['a'] },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    };
    await expect(executor.execute(dag, { userId: 'u1', taskId: 't1' })).rejects.toThrow('cycle');
  });

  it('executes a linear DAG in order', async () => {
    const gw = mockGateway();
    const executor = new DagExecutor(gw);
    const dag = DagExecutor.buildWorkflow({
      name: 'linear',
      steps: [
        { type: 'reasoning', tier: 'work', capabilities: ['code'], prompt: 'first' },
        { type: 'writing', tier: 'work', capabilities: ['code'], prompt: 'second' },
      ],
    });
    const result = await executor.execute(dag, { userId: 'u1', taskId: 't1' });
    expect(result.results).toHaveLength(2);
    expect(result.successful_nodes).toBe(2);
    expect(result.failed_nodes).toBe(0);
    expect(result.execution_order).toEqual(['linear-step-1', 'linear-step-2']);
  });

  it('executes independent nodes in parallel', async () => {
    const gw = mockGateway();
    const executor = new DagExecutor(gw);
    const dag: DagDefinition = {
      nodes: [
        { step_id: 'a', node_type: 'reasoning', tier: 'work', required_capabilities: ['code'], prompt: 'a', depends_on: [] },
        { step_id: 'b', node_type: 'reasoning', tier: 'work', required_capabilities: ['code'], prompt: 'b', depends_on: [] },
      ],
      edges: [],
    };
    const result = await executor.execute(dag, { userId: 'u1', taskId: 't1' });
    expect(result.parallel_batches[0]).toHaveLength(2);
    expect(result.parallel_batches).toHaveLength(1);
  });

  it('propagates dependency context to dependent nodes', async () => {
    const calls: string[] = [];
    const gw = {
      complete: async (prompt: string) => {
        calls.push(prompt);
        return {
          response: 'dep-response',
          usage: { success: true, cost_usd: 0.01, prompt_tokens: 100, completion_tokens: 50, latency_ms: 100 },
          model_used: 'm', provider_used: 'p', fallback_triggered: false,
        };
      },
    } as unknown as ManagedGateway;
    const executor = new DagExecutor(gw);
    const dag = DagExecutor.buildWorkflow({
      name: 'dep',
      steps: [
        { type: 'reasoning', tier: 'work', capabilities: ['code'], prompt: 'original prompt' },
        { type: 'writing', tier: 'work', capabilities: ['code'], prompt: 'dependent prompt' },
      ],
    });
    await executor.execute(dag, { userId: 'u1', taskId: 't1' });
    // Second call should contain context from first
    expect(calls[1]).toContain('Context from previous steps');
    expect(calls[1]).toContain('dep-response');
    expect(calls[1]).toContain('dependent prompt');
  });

  it('marks dependents as failed when a node fails', async () => {
    const gw = {
      complete: async (_prompt: string, opts: any) => {
        if (opts.stepId === 'fail-node') throw new Error('model error');
        return {
          response: 'ok',
          usage: { success: true, cost_usd: 0.01, prompt_tokens: 100, completion_tokens: 50, latency_ms: 100 },
          model_used: 'm', provider_used: 'p', fallback_triggered: false,
        };
      },
    } as unknown as ManagedGateway;
    const executor = new DagExecutor(gw);
    const dag: DagDefinition = {
      nodes: [
        { step_id: 'fail-node', node_type: 'reasoning', tier: 'work', required_capabilities: ['code'], prompt: 'will fail', depends_on: [] },
        { step_id: 'dep-node', node_type: 'writing', tier: 'work', required_capabilities: ['code'], prompt: 'depends on fail', depends_on: ['fail-node'] },
      ],
      edges: [{ from: 'fail-node', to: 'dep-node' }],
    };
    const result = await executor.execute(dag, { userId: 'u1', taskId: 't1' });
    expect(result.failed_nodes).toBeGreaterThanOrEqual(1);
    const depResult = result.results.find(r => r.step_id === 'dep-node');
    expect(depResult).toBeDefined();
    expect(depResult!.success).toBe(false);
    expect(depResult!.response).toContain('Skipped');
  });

  it('calculates total cost and tokens', async () => {
    const gw = mockGateway();
    const executor = new DagExecutor(gw);
    const dag = DagExecutor.buildWorkflow({
      name: 'cost',
      steps: [
        { type: 'reasoning', tier: 'work', capabilities: ['code'], prompt: 'a' },
        { type: 'reasoning', tier: 'work', capabilities: ['code'], prompt: 'b' },
      ],
    });
    const result = await executor.execute(dag, { userId: 'u1', taskId: 't1' });
    expect(result.total_cost_usd).toBeGreaterThan(0);
    expect(result.total_tokens).toBeGreaterThan(0);
  });
});

  it('passes empty context when all dependencies fail', async () => {
    const calls: string[] = [];
    const gw = {
      complete: async (prompt: string, opts: any) => {
        calls.push(prompt);
        if (opts.stepId === 'fail-a' || opts.stepId === 'fail-b') throw new Error('model error');
        return {
          response: 'ok-response',
          usage: { success: true, cost_usd: 0.01, prompt_tokens: 100, completion_tokens: 50, latency_ms: 100 },
          model_used: 'm', provider_used: 'p', fallback_triggered: false,
        };
      },
    } as unknown as ManagedGateway;
    const executor = new DagExecutor(gw);
    const dag: DagDefinition = {
      nodes: [
        { step_id: 'fail-a', node_type: 'reasoning', tier: 'work', required_capabilities: ['code'], prompt: 'fail a', depends_on: [] },
        { step_id: 'fail-b', node_type: 'reasoning', tier: 'work', required_capabilities: ['code'], prompt: 'fail b', depends_on: [] },
        { step_id: 'dep-node', node_type: 'writing', tier: 'work', required_capabilities: ['code'], prompt: 'dependent task', depends_on: ['fail-a', 'fail-b'] },
      ],
      edges: [
        { from: 'fail-a', to: 'dep-node' },
        { from: 'fail-b', to: 'dep-node' },
      ],
    };
    const result = await executor.execute(dag, { userId: 'u1', taskId: 't1' });
    // dep-node should be skipped because all dependencies failed
    const depResult = result.results.find(r => r.step_id === 'dep-node');
    expect(depResult).toBeDefined();
    expect(depResult!.success).toBe(false);
  });


