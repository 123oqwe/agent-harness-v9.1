import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunPlan } from '../../contracts/index.js';
import {
  LoopEngine,
  type LoopConfig,
  type LoopDeps,
  type ModelTurn,
} from '../../runtime/loop.js';
import { planActionInstruction } from '../../runtime/plan-execute.js';
import { DurableSession } from '../../session/durable-session.js';

type Node = RunPlan['workflow_graph']['nodes'][number];
type Edge = RunPlan['workflow_graph']['edges'][number];

let sequence = 0;
function makeSession(): DurableSession {
  sequence += 1;
  return new DurableSession(`strategy-boundary-${sequence}`);
}

function node(
  step_id: string,
  step_type: Node['step_type'],
  extra: Partial<Node> = {},
): Node {
  return { step_id, step_type, status: 'pending', ...extra } as Node;
}

function runPlan(
  nodes: Node[],
  edges: Edge[] = [],
  tools: string[] = [],
): RunPlan {
  return {
    workflow_graph: { nodes, edges },
    tool_grants: tools.map((tool) => ({ tool, granted: true })),
  } as unknown as RunPlan;
}

function config(
  strategy: LoopConfig['strategy'],
  changes: Partial<LoopConfig> = {},
): LoopConfig {
  return {
    strategy,
    max_iterations: 5,
    run_id: `run-${strategy}`,
    goal: 'complete the task',
    ...changes,
  };
}

function deps(
  turns: ModelTurn[] | ((attempt: number) => ModelTurn),
  changes: Partial<LoopDeps> = {},
): LoopDeps {
  let index = 0;
  return {
    session: makeSession(),
    modelCall: vi.fn(async (_messages, attempt) => {
      if (typeof turns === 'function') return turns(attempt);
      const turn = turns[index];
      index += 1;
      if (!turn) throw new Error(`missing scripted turn ${index}`);
      return turn;
    }),
    ...changes,
  };
}

const answer: ModelTurn = {
  content: 'done',
  decision_summary: 'finished',
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe('Direct strategy boundaries', () => {
  it.each([
    {
      name: 'cancellation',
      config: {},
      deps: { signal: AbortSignal.abort() },
      reason: 'user_cancel',
    },
    {
      name: 'deadline',
      config: { deadline_ms: 10, nowMs: vi.fn().mockReturnValueOnce(0).mockReturnValue(10) },
      deps: {},
      reason: 'deadline',
    },
    {
      name: 'zero budget',
      config: { budget_tokens: 0 },
      deps: {},
      reason: 'budget_exhausted',
    },
  ])('terminates before a model call on $name', async (testCase) => {
    const runtimeDeps = deps([answer], testCase.deps);
    const result = await new LoopEngine(
      config('direct', testCase.config),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe(testCase.reason);
    expect(result.iterations).toBe(0);
    expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
  });

  it('completes exactly one tool-free turn with actual usage', async () => {
    const runtimeDeps = deps([answer]);
    const result = await new LoopEngine(config('direct'), runtimeDeps).run();
    expect(result).toMatchObject({
      strategy: 'direct',
      iterations: 1,
      termination_reason: 'completed',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      decision_summaries: ['finished'],
    });
    expect(runtimeDeps.modelCall).toHaveBeenCalledTimes(1);
    expect(runtimeDeps.modelCall).toHaveBeenCalledWith(
      expect.any(Array),
      1,
      expect.any(Object),
      expect.objectContaining({
        allowed_tools: [],
        system_instruction: expect.stringContaining(
          'preserve the original language, key factual terms, and meaning',
        ),
      }),
    );
  });

  it('rejects every tool call and records one strategy violation', async () => {
    const runtimeDeps = deps([
      {
        content: '',
        decision_summary: 'bad',
        tool_calls: [
          { id: 'a', name: 'read_file', arguments: { path: '/a' } },
          { id: 'b', name: 'write_file', arguments: { path: '/b' } },
        ],
      },
    ]);
    const result = await new LoopEngine(config('direct'), runtimeDeps).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.turns[0]!.tool_observations).toHaveLength(2);
    expect(
      result.turns[0]!.tool_observations.map((item) => ({
        id: item.tool_call_id,
        status: item.status,
        error: item.error,
      })),
    ).toEqual([
      { id: 'a', status: 'rejected', error: 'direct strategy forbids tool calls' },
      { id: 'b', status: 'rejected', error: 'direct strategy forbids tool calls' },
    ]);
    const violations = runtimeDeps.session.getEvents().filter(
      (event) =>
        event.type === 'system' &&
        (event.data as { reason?: string }).reason === 'strategy_violation',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.data).toMatchObject({
      detail: 'direct strategy received tool_call',
    });
    expect(
      runtimeDeps.session
        .getEvents()
        .filter((event) => event.type === 'tool_call')
        .map((event) => (event.data as { step: string }).step),
    ).toEqual(['direct', 'direct']);
    expect(
      runtimeDeps.session
        .getEvents()
        .filter((event) => event.type === 'tool_result')
        .map((event) => (event.data as { step: string }).step),
    ).toEqual(['direct', 'direct']);
  });

  it('uses actual usage to reject an over-budget answer', async () => {
    const result = await new LoopEngine(
      config('direct', { budget_tokens: 2 }),
      deps([
        {
          ...answer,
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      ]),
    ).run();
    expect(result.termination_reason).toBe('budget_exhausted');
    expect(result.usage.total_tokens).toBe(3);
  });

  it.each([
    ['length', 'malformed_response'],
    ['content_filter', 'model_refusal'],
  ] as const)('maps the exact stop reason %s', async (stopReason, reason) => {
    const result = await new LoopEngine(
      config('direct'),
      deps([
        {
          ...answer,
          content: stopReason === 'length' ? '' : answer.content,
          stop_reason: stopReason,
        },
      ]),
    ).run();
    expect(result.termination_reason).toBe(reason);
    expect(result.iterations).toBe(1);
  });

  it('lets verification judge a non-empty length-stopped direct answer', async () => {
    const result = await new LoopEngine(
      config('direct'),
      deps([{ ...answer, stop_reason: 'length' }]),
    ).run();
    expect(result.termination_reason).toBe('completed');
  });

  it('treats an explicitly empty tool-call array as tool-free', async () => {
    const result = await new LoopEngine(
      config('direct'),
      deps([{ ...answer, tool_calls: [] }]),
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(result.turns[0]!.tool_observations).toEqual([]);
  });

  it('does not record tool effects after progress persistence terminates the run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'direct-progress-failure-'));
    const blockedDataDirectory = join(directory, 'not-a-directory');
    writeFileSync(blockedDataDirectory, 'blocked');
    try {
      const runtimeDeps = deps([
        {
          ...answer,
          tool_calls: [
            { id: 'forbidden', name: 'write_file', arguments: { path: '/later' } },
          ],
        },
      ]);
      const result = await new LoopEngine(
        config('direct', { data_dir: blockedDataDirectory }),
        runtimeDeps,
      ).run();

      expect(result.termination_reason).toBe('internal_error');
      expect(result.turns).toHaveLength(1);
      expect(
        runtimeDeps.session
          .getEvents()
          .filter((event) =>
            ['tool_call', 'tool_result'].includes(event.type),
          ),
      ).toEqual([]);
      expect(
        runtimeDeps.session
          .getEvents()
          .filter(
            (event) =>
              event.type === 'system' &&
              (event.data as { reason?: string }).reason ===
                'strategy_violation',
          ),
      ).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Plan+Execute workflow validation', () => {
  async function invalid(plan: unknown) {
    const runtimeDeps = deps([answer]);
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: plan as RunPlan }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.iterations).toBe(0);
    expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
    return runtimeDeps.session.getEvents().find(
      (event) => event.type === 'error',
    )?.data as { message?: string };
  }

  it.each([
    ['missing graph', { tool_grants: [] }, 'non-empty WorkflowGraph'],
    ['empty nodes', runPlan([]), 'non-empty WorkflowGraph'],
    ['non-array nodes', { workflow_graph: { nodes: {}, edges: [] }, tool_grants: [] }, 'non-empty WorkflowGraph'],
    ['non-array edges', { workflow_graph: { nodes: [node('a', 'model_call')], edges: {} }, tool_grants: [] }, 'edges must be an array'],
    ['non-array grants', { workflow_graph: { nodes: [node('a', 'model_call')], edges: [] }, tool_grants: {} }, 'tool_grants must be an array'],
    ['empty id', runPlan([node(' ', 'model_call')]), 'duplicate or empty step_id'],
    ['duplicate id', runPlan([node('a', 'model_call'), node('a', 'decision')]), 'duplicate or empty step_id'],
    ['invalid status', runPlan([node('a', 'model_call', { status: 'unknown' as Node['status'] })]), 'invalid step status'],
    ['unsupported type', runPlan([node('a', 'subworkflow' as Node['step_type'])]), 'no Phase 1 implementation'],
    ['missing endpoint', runPlan([node('a', 'model_call')], [{ from_step: 'a', to_step: 'missing' }]), 'missing step'],
    ['self edge', runPlan([node('a', 'model_call')], [{ from_step: 'a', to_step: 'a' }]), 'self-referential'],
    ['duplicate edge', runPlan([node('a', 'model_call'), node('b', 'decision')], [{ from_step: 'a', to_step: 'b' }, { from_step: 'a', to_step: 'b' }]), 'duplicate'],
    ['missing tool name', runPlan([node('m', 'model_call'), node('t', 'tool_call')], [{ from_step: 'm', to_step: 't' }], ['read_file']), 'missing or unauthorized'],
    ['unauthorized tool', runPlan([node('m', 'model_call'), node('t', 'tool_call', { tool_name: 'write_file' })], [{ from_step: 'm', to_step: 't' }], ['read_file']), 'missing or unauthorized'],
    ['tool without predecessor', runPlan([node('t', 'tool_call', { tool_name: 'read_file' })], [], ['read_file']), 'requires one model proposal'],
    ['tool with wrong predecessor', runPlan([node('d', 'decision'), node('t', 'tool_call', { tool_name: 'read_file' })], [{ from_step: 'd', to_step: 't' }], ['read_file']), 'requires one model proposal'],
    ['tool with two predecessors', runPlan([node('a', 'model_call'), node('b', 'model_call'), node('t', 'tool_call', { tool_name: 'read_file' })], [{ from_step: 'a', to_step: 't' }, { from_step: 'b', to_step: 't' }], ['read_file']), 'requires one model proposal'],
    ['nonterminal verification', runPlan([node('v', 'verification'), node('d', 'decision')], [{ from_step: 'v', to_step: 'd' }]), 'verification steps must be terminal'],
    ['one proposal to two tools', runPlan([node('m', 'model_call'), node('a', 'tool_call', { tool_name: 'read_file' }), node('b', 'tool_call', { tool_name: 'write_file' })], [{ from_step: 'm', to_step: 'a' }, { from_step: 'm', to_step: 'b' }], ['read_file', 'write_file']), 'cannot bind multiple'],
    ['cycle', runPlan([node('a', 'model_call'), node('b', 'decision')], [{ from_step: 'a', to_step: 'b' }, { from_step: 'b', to_step: 'a' }]), 'contains a cycle'],
  ])('rejects $name', async (_name, plan, message) => {
    expect(await invalid(plan)).toMatchObject({ message: expect.stringContaining(message) });
  });
});

describe('Plan+Execute execution and recovery', () => {
  const proposal = node('propose', 'model_call');
  const execute = node('execute', 'tool_call', { tool_name: 'read_file' });
  const verify = node('verify', 'verification');
  const graph = runPlan(
    [proposal, execute, verify],
    [
      { from_step: 'propose', to_step: 'execute' },
      { from_step: 'execute', to_step: 'verify' },
    ],
    ['read_file'],
  );

  it('narrows frozen edit and command nodes to task-derived targets', () => {
    const plan = {
      ...runPlan(
        [
          node('propose-edit', 'model_call'),
          node('edit', 'tool_call', { tool_name: 'edit_file' }),
          node('propose-command', 'model_call'),
          node('command', 'tool_call', { tool_name: 'execute_command' }),
        ],
        [
          { from_step: 'propose-edit', to_step: 'edit' },
          { from_step: 'edit', to_step: 'propose-command' },
          { from_step: 'propose-command', to_step: 'command' },
        ],
        ['edit_file', 'execute_command'],
      ),
      task: {
        goal: "Change app.js to return 'new', run node failing-test.mjs, and do not edit failing-test.mjs.",
      },
    } as RunPlan;
    expect(planActionInstruction(plan, 'edit_file', 'edit')).toContain(
      'Edit only "app.js"',
    );
    expect(
      planActionInstruction(plan, 'execute_command', 'command'),
    ).toContain('["node","failing-test.mjs"]');
  });

  function proposedTurn(changes: Partial<ModelTurn> = {}): ModelTurn {
    return {
      content: 'proposal',
      decision_summary: 'read',
      tool_calls: [
        { id: 'call-1', name: 'read_file', arguments: { path: '/x' } },
      ],
      ...changes,
    };
  }

  it('requires an explicitly frozen RunPlan', async () => {
    const result = await new LoopEngine(
      config('plan_execute'),
      deps([answer]),
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.iterations).toBe(0);
  });

  it.each([
    'pending',
    'dispatched',
    'executing',
    'verifying',
    'done',
    'failed',
    'blocked',
    'skipped',
  ] as const)('accepts the contract status %s during DAG validation', async (status) => {
    const result = await new LoopEngine(
      config('plan_execute', {
        run_plan: runPlan([
          node('decision', 'decision', { status }),
        ]),
      }),
      deps([answer]),
    ).run();
    expect(result.termination_reason).toBe('completed');
  });

  it('executes ready steps in stable topological order', async () => {
    const executing: string[] = [];
    const runtimeDeps = deps((_attempt) => answer);
    const originalAppend = runtimeDeps.session.append.bind(runtimeDeps.session);
    runtimeDeps.session.append = ((type, data) => {
      if (
        type === 'system' &&
        (data as { event?: string; status?: string }).event === 'step_state' &&
        (data as { status?: string }).status === 'executing'
      ) {
        executing.push((data as { step: string }).step);
      }
      return originalAppend(type, data);
    }) as typeof runtimeDeps.session.append;
    const result = await new LoopEngine(
      config('plan_execute', {
        run_plan: runPlan(
          [
            node('zeta', 'decision'),
            node('middle', 'decision'),
            node('alpha', 'decision'),
          ],
          [{ from_step: 'alpha', to_step: 'middle' }],
        ),
      }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(executing).toEqual(['alpha', 'middle', 'zeta']);
    expect(result.iterations).toBe(3);
  });

  it('passes exact assistant and tool receipts to a downstream decision', async () => {
    const requests: unknown[][] = [];
    const runtimeDeps = deps([
      proposedTurn(),
      answer,
    ], {
      modelCall: vi.fn(async (messages, attempt) => {
        requests.push(structuredClone(messages));
        return attempt === 1 ? proposedTurn() : answer;
      }),
      toolExecute: vi.fn(async () => ({ content: 'observed' })),
    });
    const downstream = node('summarize', 'decision');
    const plan = runPlan(
      [proposal, execute, downstream],
      [
        { from_step: 'propose', to_step: 'execute' },
        { from_step: 'execute', to_step: 'summarize' },
      ],
      ['read_file'],
    );
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: plan }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests[1]![1]).toEqual({
      role: 'assistant',
      content: 'proposal',
      decision_summary: 'read',
      tool_calls: [
        { id: 'call-1', name: 'read_file', arguments: { path: '/x' } },
      ],
    });
    expect(requests[1]![2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
    });
    expect(JSON.parse((requests[1]![2] as { content: string }).content)).toMatchObject({
      status: 'ok',
      result: { content: 'observed' },
    });
  });

  it('executes one bound call and emits exact immutable step states', async () => {
    const toolExecute = vi.fn(async () => ({ content: 'x' }));
    const runtimeDeps = deps([proposedTurn()], { toolExecute });
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(runtimeDeps.modelCall).toHaveBeenCalledWith(
      expect.any(Array),
      1,
      expect.any(Object),
      expect.objectContaining({
        allowed_tools: ['read_file'],
        required_tool: 'read_file',
      }),
    );
    expect(result.step_states).toEqual({
      propose: 'done',
      execute: 'done',
      verify: 'awaiting_verification',
    });
    expect(Object.isFrozen(result.step_states)).toBe(true);
    expect(toolExecute).toHaveBeenCalledWith(
      'read_file',
      { path: '/x' },
      { tool_call_id: 'call-1', step_id: 'execute', attempt_index: 1 },
    );
    expect(result.turns[0]!.tool_observations[0]).toMatchObject({
      tool_call_id: 'call-1',
      name: 'read_file',
      status: 'ok',
      result: { content: 'x' },
    });
  });

  it.each([
    ['no call', { tool_calls: undefined }, 'expected exactly one read_file tool call'],
    ['two calls', { tool_calls: [
      { id: 'a', name: 'read_file', arguments: {} },
      { id: 'b', name: 'read_file', arguments: {} },
    ] }, 'expected exactly one read_file tool call'],
    ['wrong tool', { tool_calls: [{ id: 'a', name: 'write_file', arguments: {} }] }, 'expected exactly one read_file tool call'],
  ])('rejects a proposal with $name', async (_name, changes, reason) => {
    const invalidTurn = proposedTurn(changes as Partial<ModelTurn>);
    const runtimeDeps = deps([invalidTurn, invalidTurn], {
      toolExecute: vi.fn(async () => 'never'),
    });
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.step_states.propose).toBe('failed');
    expect(runtimeDeps.toolExecute).not.toHaveBeenCalled();
    expect(
      runtimeDeps.session.getEvents().some(
        (event) =>
          event.type === 'system' &&
          (event.data as { reason?: string }).reason === reason,
      ),
    ).toBe(true);
  });

  it('rejects a multi-call proposal without effects, then retries the same frozen step once', async () => {
    const multiple = proposedTurn({
      tool_calls: [
        { id: 'extra-a', name: 'read_file', arguments: { path: '/a' } },
        { id: 'extra-b', name: 'read_file', arguments: { path: '/b' } },
      ],
    });
    const toolExecute = vi.fn(async () => ({ content: 'ok' }));
    const runtimeDeps = deps([multiple, proposedTurn()], { toolExecute });
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(toolExecute).toHaveBeenCalledWith(
      'read_file',
      { path: '/x' },
      expect.any(Object),
    );
    expect(result.turns[0]!.tool_observations).toHaveLength(2);
    expect(
      result.turns[0]!.tool_observations.every(
        (observation) => observation.status === 'rejected',
      ),
    ).toBe(true);
  });

  it('rejects unbound tool calls from a model-only node', async () => {
    const plan = runPlan([node('model', 'model_call')]);
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: plan }),
      deps([proposedTurn(), proposedTurn()]),
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.step_states.model).toBe('failed');
    expect(result.turns[0]!.tool_observations[0]).toMatchObject({
      status: 'rejected',
      error: 'model step has no bound tool node',
    });
  });

  it.each([
    ['length', 'malformed_response', 'truncated model turn'],
    ['content_filter', 'model_refusal', 'model refusal'],
  ] as const)('fails model stop reason %s', async (stopReason, termination, reason) => {
    const plan = runPlan([node('model', 'model_call')]);
    const runtimeDeps = deps([
      {
        ...answer,
        content: stopReason === 'length' ? '' : answer.content,
        stop_reason: stopReason,
      },
    ]);
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: plan }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe(termination);
    expect(result.step_states.model).toBe('failed');
    expect(
      runtimeDeps.session.getEvents().some(
        (event) =>
          event.type === 'system' &&
          (event.data as { reason?: string }).reason === reason,
      ),
    ).toBe(true);
  });

  it('lets independent verification judge a non-empty length-stopped final answer', async () => {
    const plan = runPlan([node('model', 'model_call')]);
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: plan }),
      deps([{ ...answer, stop_reason: 'length' }]),
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(result.step_states.model).toBe('done');
  });

  it('fails before execution when the actual model usage exceeds budget', async () => {
    const plan = runPlan([node('model', 'model_call')]);
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: plan, budget_tokens: 1 }),
      deps([{ ...answer, usage: { input_tokens: 1, output_tokens: 1 } }]),
    ).run();
    expect(result.termination_reason).toBe('budget_exhausted');
    expect(result.step_states.model).toBe('failed');
  });

  it('honors model iteration limits before dispatch', async () => {
    const runtimeDeps = deps([answer]);
    const result = await new LoopEngine(
      config('plan_execute', {
        run_plan: runPlan([node('model', 'model_call')]),
        max_iterations: 0,
      }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('iteration_limit');
    expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
  });

  it('fails a bound tool step when the executor is unavailable', async () => {
    const runtimeDeps = deps([proposedTurn()]);
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.step_states.execute).toBe('failed');
    expect(
      runtimeDeps.session.getEvents().some(
        (event) =>
          event.type === 'system' &&
          (event.data as { reason?: string }).reason ===
            'tool executor unavailable',
      ),
    ).toBe(true);
  });

  it('fails a restored tool step when its pending call is absent', async () => {
    const runtimeDeps = deps([]);
    runtimeDeps.session.acquireWriter();
    runtimeDeps.session.append('system', {
      event: 'step_state',
      step: 'propose',
      status: 'done',
    });
    runtimeDeps.session.releaseWriter();
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.step_states.execute).toBe('failed');
    expect(
      runtimeDeps.session.getEvents().some(
        (event) =>
          event.type === 'system' &&
          (event.data as { reason?: string }).reason ===
            'matching pending tool call missing',
      ),
    ).toBe(true);
  });

  it.each([
    [new Error('tool exploded'), 'tool_failure', 'tool exploded'],
    ['non-error rejection', 'tool_failure', 'tool execution failed'],
  ])('records tool failure %p', async (failure, termination, message) => {
    const runtimeDeps = deps([proposedTurn()], {
      toolExecute: vi.fn(async () => {
        throw failure;
      }),
    });
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe(termination);
    expect(result.step_states.execute).toBe('failed');
    expect(result.turns[0]!.tool_observations[0]).toMatchObject({
      status: 'error',
      error: message,
    });
  });

  it('classifies an explicit LoopError from tool execution as malformed', async () => {
    const { LoopError } = await import('../../runtime/loop.js');
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      deps([proposedTurn()], {
        toolExecute: vi.fn(async () => {
          throw new LoopError('invalid receipt');
        }),
      }),
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.step_states.execute).toBe('failed');
  });

  it('restores a pending tool call and executes it once after a crash', async () => {
    const runtimeDeps = deps([], {
      toolExecute: vi.fn(async () => 'restored'),
    });
    runtimeDeps.session.acquireWriter();
    runtimeDeps.session.append('system', {
      event: 'step_state',
      step: 'propose',
      status: 'done',
    });
    runtimeDeps.session.append('tool_call', {
      step: 'execute',
      tool_call_id: 'restored-call',
      tool: 'read_file',
      arguments: { path: '/restored' },
    });
    runtimeDeps.session.releaseWriter();
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(runtimeDeps.toolExecute).toHaveBeenCalledTimes(1);
    expect(result.step_states.execute).toBe('failed');
  });

  it('does not repeat a tool call whose durable result already exists', async () => {
    const runtimeDeps = deps([], {
      toolExecute: vi.fn(async () => 'never'),
    });
    runtimeDeps.session.acquireWriter();
    for (const [step, status] of [
      ['propose', 'done'],
      ['execute', 'done'],
    ] as const) {
      runtimeDeps.session.append('system', {
        event: 'step_state',
        step,
        status,
      });
    }
    runtimeDeps.session.append('tool_call', {
      step: 'execute',
      tool_call_id: 'done-call',
      tool: 'read_file',
      arguments: { path: '/done' },
    });
    runtimeDeps.session.append('tool_result', { step: 'execute', status: 'ok' });
    runtimeDeps.session.releaseWriter();
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(runtimeDeps.toolExecute).not.toHaveBeenCalled();
    expect(result.step_states.verify).toBe('awaiting_verification');
  });

  it('blocks descendants of a restored failed dependency', async () => {
    const runtimeDeps = deps([]);
    runtimeDeps.session.acquireWriter();
    runtimeDeps.session.append('system', {
      event: 'step_state',
      step: 'propose',
      status: 'failed',
    });
    runtimeDeps.session.releaseWriter();
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('tool_failure');
    expect(result.step_states).toMatchObject({
      execute: 'blocked',
      verify: 'blocked',
    });
  });

  it('ignores unrelated and incomplete durable events during restoration', async () => {
    const runtimeDeps = deps([proposedTurn()], {
      toolExecute: vi.fn(async () => 'ok'),
    });
    runtimeDeps.session.acquireWriter();
    runtimeDeps.session.append('user', {
      event: 'step_state',
      step: 'propose',
      status: 'failed',
    });
    runtimeDeps.session.append('system', {
      event: 'other',
      step: 'propose',
      status: 'failed',
    });
    runtimeDeps.session.append('system', {
      event: 'step_state',
      step: '',
      status: 'failed',
    });
    runtimeDeps.session.append('tool_call', {
      step: 'execute',
      tool_call_id: '',
      tool: 'read_file',
      arguments: { path: '/ignored' },
    });
    runtimeDeps.session.append('tool_result', { status: 'ok' });
    runtimeDeps.session.releaseWriter();
    const result = await new LoopEngine(
      config('plan_execute', { run_plan: graph }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(runtimeDeps.modelCall).toHaveBeenCalledTimes(1);
    expect(runtimeDeps.toolExecute).toHaveBeenCalledTimes(1);
  });
});

describe('ReAct action/observation boundaries', () => {
  const plan = runPlan([], [], ['read_file']);
  const call = (id: string, args: Record<string, unknown> = { path: '/x' }) => ({
    id,
    name: 'read_file',
    arguments: args,
  });

  it.each([
    {
      name: 'cancellation',
      changes: {},
      depChanges: { signal: AbortSignal.abort() },
      reason: 'user_cancel',
    },
    {
      name: 'deadline',
      changes: { deadline_ms: 1, nowMs: vi.fn().mockReturnValueOnce(0).mockReturnValue(1) },
      depChanges: {},
      reason: 'deadline',
    },
  ])('preflights $name before dispatch', async (testCase) => {
    const runtimeDeps = deps([answer], testCase.depChanges);
    const result = await new LoopEngine(
      config('react', { run_plan: plan, ...testCase.changes }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe(testCase.reason);
    expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
  });

  it('rejects a tool outside the frozen RunPlan before execution', async () => {
    const toolExecute = vi.fn(async () => 'never');
    const result = await new LoopEngine(
      config('react', { run_plan: plan }),
      deps([
        {
          content: '',
          decision_summary: 'write',
          tool_calls: [{ id: 'x', name: 'write_file', arguments: {} }],
        },
      ], { toolExecute }),
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(toolExecute).not.toHaveBeenCalled();
    expect(result.turns[0]!.tool_observations[0]).toMatchObject({
      status: 'rejected',
      error: 'tool is not bound by the frozen RunPlan',
    });
  });

  it('rejects duplicate call IDs within one assistant turn', async () => {
    const toolExecute = vi.fn(async () => 'never');
    const result = await new LoopEngine(
      config('react', { run_plan: plan }),
      deps([
        {
          content: '',
          decision_summary: 'duplicate',
          tool_calls: [call('same', { path: '/a' }), call('same', { path: '/b' })],
        },
      ], { toolExecute }),
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(toolExecute).not.toHaveBeenCalled();
    expect(result.turns[0]!.tool_observations[0]!.error).toBe(
      'duplicate tool_call id in one model turn',
    );
  });

  it('detects oscillation for canonically equivalent arguments', async () => {
    const toolExecute = vi.fn(async () => 'ok');
    const result = await new LoopEngine(
      config('react', { run_plan: plan, max_iterations: 4 }),
      deps((attempt) => ({
        content: '',
        decision_summary: 'repeat',
        tool_calls: [
          call(`call-${attempt}`, attempt === 2
            ? { nested: { b: 2, a: 1 }, path: '/x' }
            : { path: '/x', nested: { a: 1, b: 2 } }),
        ],
      }), { toolExecute }),
    ).run();
    expect(result.termination_reason).toBe('tool_oscillation');
    expect(toolExecute).toHaveBeenCalledTimes(2);
    expect(result.turns[2]!.tool_observations[0]!.error).toBe(
      'repeated tool call oscillation',
    );
  });

  it('canonicalizes nested arrays when detecting oscillation', async () => {
    const toolExecute = vi.fn(async () => 'ok');
    const result = await new LoopEngine(
      config('react', { run_plan: plan, max_iterations: 3 }),
      deps((attempt) => ({
        content: '',
        decision_summary: 'repeat array',
        tool_calls: [
          call(`array-${attempt}`, {
            values: [{ b: 2, a: 1 }, ['x', 'y']],
          }),
        ],
      }), { toolExecute }),
    ).run();
    expect(result.termination_reason).toBe('tool_oscillation');
    expect(toolExecute).toHaveBeenCalledTimes(2);
  });

  it('rejects calls when no tool executor is installed', async () => {
    const result = await new LoopEngine(
      config('react', { run_plan: plan }),
      deps([{ content: '', decision_summary: 'read', tool_calls: [call('x')] }]),
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.turns[0]!.tool_observations[0]!.error).toBe(
      'tool executor unavailable',
    );
  });

  it('records tool errors and allows the model to recover on the next turn', async () => {
    const runtimeDeps = deps([
      { content: '', decision_summary: 'read', tool_calls: [call('x')] },
      answer,
    ], {
      toolExecute: vi.fn(async () => {
        throw new Error('read failed');
      }),
    });
    const result = await new LoopEngine(
      config('react', { run_plan: plan }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(result.turns[0]!.tool_observations[0]).toMatchObject({
      status: 'error',
      error: 'read failed',
    });
    expect(
      runtimeDeps.session.getEvents().some(
        (event) =>
          event.type === 'error' &&
          (event.data as { error_type?: string }).error_type === 'tool_execution',
      ),
    ).toBe(true);
    const errorEvent = runtimeDeps.session.getEvents().find(
      (event) =>
        event.type === 'error' &&
        (event.data as { error_type?: string }).error_type === 'tool_execution',
    )!;
    expect(errorEvent.data).toMatchObject({
      tool: 'read_file',
      tool_call_id: 'x',
      error: 'read failed',
      error_type: 'tool_execution',
    });
  });

  it('normalizes non-Error tool failures and continues', async () => {
    const result = await new LoopEngine(
      config('react', { run_plan: plan }),
      deps([
        { content: '', decision_summary: 'read', tool_calls: [call('x')] },
        answer,
      ], {
        toolExecute: vi.fn(async () => {
          throw 'failure';
        }),
      }),
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(result.turns[0]!.tool_observations[0]!.error).toBe(
      'tool execution failed',
    );
  });

  it('executes multiple unique calls and sends one observation for each', async () => {
    const requests: unknown[][] = [];
    const toolExecute = vi.fn(
      async (_name: string, args: Record<string, unknown>, _context: unknown) =>
        args,
    );
    const runtimeDeps = deps([], {
      modelCall: vi.fn(async (messages, attempt) => {
        requests.push(structuredClone(messages));
        return attempt === 1
          ? {
              content: '',
              decision_summary: 'two reads',
              tool_calls: [call('a', { path: '/a' }), call('b', { path: '/b' })],
            }
          : answer;
      }),
      toolExecute,
    });
    const result = await new LoopEngine(
      config('react', { run_plan: plan }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('completed');
    expect(toolExecute).toHaveBeenCalledTimes(2);
    expect(result.turns[0]!.tool_observations.map((item) => item.tool_call_id)).toEqual([
      'a',
      'b',
    ]);
    expect(toolExecute.mock.calls.map((entry) => entry[2])).toEqual([
      { tool_call_id: 'a', step_id: 'react-1', attempt_index: 1 },
      { tool_call_id: 'b', step_id: 'react-1', attempt_index: 1 },
    ]);
    expect(requests[1]![1]).toMatchObject({
      role: 'assistant',
      decision_summary: 'two reads',
    });
    expect(requests[1]!.slice(2).map((message) => (
      message as { tool_call_id: string }
    ).tool_call_id)).toEqual(['a', 'b']);
  });

  it.each([
    ['length', 'malformed_response'],
    ['content_filter', 'model_refusal'],
  ] as const)('maps stop reason %s', async (stopReason, termination) => {
    const result = await new LoopEngine(
      config('react', { run_plan: plan }),
      deps([
        {
          ...answer,
          content: stopReason === 'length' ? '' : answer.content,
          stop_reason: stopReason,
        },
      ]),
    ).run();
    expect(result.termination_reason).toBe(termination);
    expect(result.turns).toHaveLength(1);
  });

  it('lets verification judge a non-empty length-stopped ReAct answer', async () => {
    const result = await new LoopEngine(
      config('react', { run_plan: plan }),
      deps([{ ...answer, stop_reason: 'length' }]),
    ).run();
    expect(result.termination_reason).toBe('completed');
  });

  it('rejects all proposed effects when actual usage exceeds budget', async () => {
    const toolExecute = vi.fn(async () => 'never');
    const result = await new LoopEngine(
      config('react', { run_plan: plan, budget_tokens: 1 }),
      deps([
        {
          content: '',
          decision_summary: 'over budget',
          usage: { input_tokens: 1, output_tokens: 1 },
          tool_calls: [call('a'), call('b')],
        },
      ], { toolExecute }),
    ).run();
    expect(result.termination_reason).toBe('budget_exhausted');
    expect(toolExecute).not.toHaveBeenCalled();
    expect(result.turns[0]!.tool_observations).toHaveLength(2);
    expect(result.turns[0]!.tool_observations.every(
      (item) => item.error === 'model call exceeded run token budget',
    )).toBe(true);
  });

  it('exits over budget without inventing observations when no tools were proposed', async () => {
    const result = await new LoopEngine(
      config('react', { run_plan: plan, budget_tokens: 1 }),
      deps([{ ...answer, usage: { input_tokens: 1, output_tokens: 1 } }]),
    ).run();
    expect(result.termination_reason).toBe('budget_exhausted');
    expect(result.turns[0]!.tool_observations).toEqual([]);
  });

  it('fails closed when tool calls arrive without any frozen RunPlan', async () => {
    const toolExecute = vi.fn(async () => 'never');
    const result = await new LoopEngine(
      config('react'),
      deps([
        { content: '', decision_summary: 'read', tool_calls: [call('x')] },
      ], { toolExecute }),
    ).run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it('terminates at the exact iteration limit after successful effects', async () => {
    const toolExecute = vi.fn(async () => 'ok');
    const result = await new LoopEngine(
      config('react', { run_plan: plan, max_iterations: 1 }),
      deps([{ content: '', decision_summary: 'read', tool_calls: [call('a')] }], {
        toolExecute,
      }),
    ).run();
    expect(result.termination_reason).toBe('iteration_limit');
    expect(result.iterations).toBe(1);
    expect(toolExecute).toHaveBeenCalledTimes(1);
  });

  it('rejects a zero per-call output budget before dispatch', async () => {
    const runtimeDeps = deps([answer]);
    const result = await new LoopEngine(
      config('react', {
        run_plan: plan,
        budget_tokens: 10,
        max_output_tokens_per_call: 0,
      }),
      runtimeDeps,
    ).run();
    expect(result.termination_reason).toBe('budget_exhausted');
    expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
  });
});
