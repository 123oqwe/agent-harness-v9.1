import { describe, expect, it, vi } from 'vitest';
import type { RunPlan } from '../../contracts/index.js';
import { DurableSession } from '../../session/durable-session.js';
import {
  LoopEngine,
  type ModelCallBudget,
  type ModelTurn,
} from '../../runtime/loop.js';

function session(): DurableSession {
  return new DurableSession(`session-${Math.random().toString(36).slice(2)}`);
}

function plan(
  nodes: RunPlan['workflow_graph']['nodes'],
  edges: RunPlan['workflow_graph']['edges'],
  tools: string[] = [],
): RunPlan {
  return {
    workflow_graph: { nodes, edges },
    tool_grants: tools.map((tool) => ({ tool, granted: false })),
  } as unknown as RunPlan;
}

describe('Phase 1 truthful LoopEngine', () => {
  it('normalizes model exceptions and always emits one terminal event', async () => {
    const sess = session();
    const loop = new LoopEngine(
      {
        strategy: 'direct',
        max_iterations: 1,
        run_id: 'run-exception',
        goal: 'fail',
      },
      {
        session: sess,
        modelCall: async () => {
          throw new Error('provider exploded');
        },
      },
    );

    const result = await loop.run();

    expect(result.termination_reason).toBe('provider_failure');
    expect(
      sess
        .getEvents()
        .filter(
          (event) =>
            event.type === 'system' &&
            (event.data as { event?: string }).event === 'run_terminated',
        ),
    ).toHaveLength(1);
  });

  it.each([
    ['length', 'malformed_response'],
    ['content_filter', 'model_refusal'],
  ] as const)(
    'direct maps %s to %s without tool execution',
    async (stopReason, expected) => {
      const toolExecute = vi.fn(async () => 'must-not-run');
      const loop = new LoopEngine(
        {
          strategy: 'direct',
          max_iterations: 1,
          run_id: 'run-direct-stop',
          goal: 'stop',
        },
        {
          session: session(),
          modelCall: async () => ({
            content: '',
            decision_summary: 'stopped',
            stop_reason: stopReason,
            tool_calls: [
              { id: 'tool-1', name: 'read_file', arguments: {} },
            ],
          }),
          toolExecute,
        },
      );

      const result = await loop.run();
      expect(result.termination_reason).toBe(expected);
      expect(toolExecute).not.toHaveBeenCalled();
    },
  );

  it('passes the remaining real token budget into every model call', async () => {
    const budgets: ModelCallBudget[] = [];
    const turns: ModelTurn[] = [
      {
        content: '',
        decision_summary: 'inspect',
        usage: { input_tokens: 4, output_tokens: 3 },
        tool_calls: [
          { id: 'tool-1', name: 'read_file', arguments: { path: '/x' } },
        ],
      },
      {
        content: 'done',
        decision_summary: 'done',
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    ];
    let index = 0;
    const loop = new LoopEngine(
      {
        strategy: 'react',
        max_iterations: 3,
        budget_tokens: 10,
        max_output_tokens_per_call: 4,
        run_id: 'run-budget',
        goal: 'inspect',
        run_plan: plan([], [], ['read_file']),
      },
      {
        session: session(),
        modelCall: async (_messages, _attempt, budget) => {
          budgets.push(budget);
          return turns[index++]!;
        },
        toolExecute: async () => 'ok',
      },
    );

    const result = await loop.run();

    expect(result.termination_reason).toBe('completed');
    expect(budgets).toEqual([
      { remaining_tokens: 10, max_output_tokens: 4 },
      { remaining_tokens: 3, max_output_tokens: 3 },
    ]);
    expect(result.usage.total_tokens).toBe(10);
  });

  it('records one bounded observation for every tool call', async () => {
    let modelCalls = 0;
    const loop = new LoopEngine(
      {
        strategy: 'react',
        max_iterations: 2,
        max_observation_bytes: 64,
        run_id: 'run-observations',
        goal: 'inspect two files',
        run_plan: plan([], [], ['read_file']),
      },
      {
        session: session(),
        modelCall: async () => {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                content: '',
                decision_summary: 'two reads',
                tool_calls: [
                  { id: 'a', name: 'read_file', arguments: { path: '/a' } },
                  { id: 'b', name: 'read_file', arguments: { path: '/b' } },
                ],
              }
            : { content: 'done', decision_summary: 'done' };
        },
        toolExecute: async (_name, args) => ({
          path: args.path,
          content: 'x'.repeat(1_000),
        }),
      },
    );

    const result = await loop.run();

    expect(result.turns[0]!.tool_observations).toHaveLength(2);
    expect(
      result.turns[0]!.tool_observations.every(
        (observation) => observation.truncated,
      ),
    ).toBe(true);
    expect(
      result.turns[0]!.tool_observations.map(
        (observation) => observation.tool_call_id,
      ),
    ).toEqual(['a', 'b']);
  });

  it('emits a rejected observation for the oscillating call', async () => {
    const sess = session();
    let toolEffects = 0;
    const loop = new LoopEngine(
      {
        strategy: 'react',
        max_iterations: 5,
        run_id: 'run-oscillation',
        goal: 'repeat',
        run_plan: plan([], [], ['read_file']),
      },
      {
        session: sess,
        modelCall: async (_messages, attempt) => ({
          content: '',
          decision_summary: 'repeat',
          tool_calls: [
            {
              id: `call-${attempt}`,
              name: 'read_file',
              arguments: { path: '/same' },
            },
          ],
        }),
        toolExecute: async () => {
          toolEffects += 1;
          return 'ok';
        },
      },
    );

    const result = await loop.run();

    expect(result.termination_reason).toBe('tool_oscillation');
    expect(toolEffects).toBe(2);
    const rejected = sess.getEvents().find(
      (event) =>
        event.type === 'tool_result' &&
        (event.data as { status?: string }).status === 'rejected',
    );
    expect(rejected).toBeDefined();
  });

  it('validates a frozen DAG without mutating it and consumes a tool call once', async () => {
    const runPlan = plan(
      [
        { step_id: 'propose', step_type: 'model_call', status: 'pending' },
        {
          step_id: 'execute',
          step_type: 'tool_call',
          status: 'pending',
          tool_name: 'read_file',
        },
        {
          step_id: 'verify',
          step_type: 'verification',
          status: 'pending',
        },
      ],
      [
        { from_step: 'propose', to_step: 'execute' },
        { from_step: 'execute', to_step: 'verify' },
      ],
      ['read_file'],
    );
    const before = JSON.stringify(runPlan);
    let toolEffects = 0;
    const loop = new LoopEngine(
      {
        strategy: 'plan_execute',
        max_iterations: 3,
        run_id: 'run-plan',
        goal: 'read',
        run_plan: runPlan,
      },
      {
        session: session(),
        modelCall: async () => ({
          content: '',
          decision_summary: 'read it',
          tool_calls: [
            { id: 'call-1', name: 'read_file', arguments: { path: '/x' } },
          ],
        }),
        toolExecute: async () => {
          toolEffects += 1;
          return 'content';
        },
      },
    );

    const result = await loop.run();

    expect(result.termination_reason).toBe('completed');
    expect(toolEffects).toBe(1);
    expect(JSON.stringify(runPlan)).toBe(before);
    expect(result.step_states).toMatchObject({
      propose: 'done',
      execute: 'done',
      verify: 'awaiting_verification',
    });
  });

  it.each([
    {
      name: 'duplicate IDs',
      nodes: [
        { step_id: 'x', step_type: 'model_call', status: 'pending' },
        { step_id: 'x', step_type: 'verification', status: 'pending' },
      ],
      edges: [],
    },
    {
      name: 'missing edge endpoint',
      nodes: [
        { step_id: 'x', step_type: 'model_call', status: 'pending' },
      ],
      edges: [{ from_step: 'x', to_step: 'missing' }],
    },
    {
      name: 'cycle',
      nodes: [
        { step_id: 'a', step_type: 'model_call', status: 'pending' },
        { step_id: 'b', step_type: 'model_call', status: 'pending' },
      ],
      edges: [
        { from_step: 'a', to_step: 'b' },
        { from_step: 'b', to_step: 'a' },
      ],
    },
  ])('rejects invalid plan: $name', async ({ nodes, edges }) => {
    const loop = new LoopEngine(
      {
        strategy: 'plan_execute',
        max_iterations: 4,
        run_id: 'run-invalid-plan',
        goal: 'invalid',
        run_plan: plan(
          nodes as RunPlan['workflow_graph']['nodes'],
          edges as RunPlan['workflow_graph']['edges'],
        ),
      },
      {
        session: session(),
        modelCall: async () => ({
          content: 'must-not-run',
          decision_summary: 'must-not-run',
        }),
      },
    );

    const result = await loop.run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.iterations).toBe(0);
  });
});
