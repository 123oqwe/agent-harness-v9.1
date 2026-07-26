import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RunPlan } from '../../contracts/index.js';
import {
  LoopEngine,
  LoopError,
  type LoopConfig,
  type LoopDeps,
  type ModelTurn,
} from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';

type Node = RunPlan['workflow_graph']['nodes'][number];
type Edge = RunPlan['workflow_graph']['edges'][number];

let sequence = 0;
const NOW = '2026-07-26T00:00:00.000Z';

function node(
  step_id: string,
  step_type: Node['step_type'],
  extra: Partial<Node> = {},
): Node {
  return { step_id, step_type, status: 'pending', ...extra } as Node;
}

function plan(
  nodes: Node[],
  edges: Edge[],
  tools: string[],
  goal: string,
): RunPlan {
  return {
    task: {
      goal,
      success_criteria: [
        { criterion: 'complete', verification_method: 'deterministic' },
      ],
      constraints: [],
    },
    workflow_graph: { nodes, edges },
    tool_grants: tools.map((tool) => ({ tool, granted: true })),
  } as unknown as RunPlan;
}

function config(
  strategy: LoopConfig['strategy'],
  runPlan: RunPlan,
  changes: Partial<LoopConfig> = {},
): LoopConfig {
  return {
    strategy,
    run_id: `golden-${strategy}`,
    goal: runPlan.task?.goal ?? 'complete',
    run_plan: runPlan,
    max_iterations: 10,
    clock: () => NOW,
    nowMs: () => 0,
    ...changes,
  };
}

function scriptedDeps(
  turns: ModelTurn[],
  changes: Partial<LoopDeps> = {},
): LoopDeps {
  sequence += 1;
  let index = 0;
  return {
    session: new DurableSession(`strategy-golden-${sequence}`, {
      clock: () => NOW,
    }),
    modelCall: vi.fn(async () => {
      const turn = turns[index++];
      if (!turn) throw new Error(`missing scripted turn ${index}`);
      return turn;
    }),
    ...changes,
  };
}

function stable(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function sha(value: unknown): string {
  return createHash('sha256')
    .update(stable(value))
    .digest('hex');
}

function eventData(session: DurableSession, type: string): unknown[] {
  return session
    .getEvents()
    .filter((event) => event.type === type)
    .map((event) => event.data);
}

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
): NonNullable<ModelTurn['tool_calls']>[number] {
  return { id, name, arguments: args };
}

describe('Plan+Execute golden behavior', () => {
  const readPlan = plan(
    [
      node('propose-read', 'model_call'),
      node('read-source', 'tool_call', { tool_name: 'read_file' }),
      node('summarize', 'decision'),
    ],
    [
      { from_step: 'propose-read', to_step: 'read-source' },
      { from_step: 'read-source', to_step: 'summarize' },
    ],
    ['read_file'],
    'Read /workspace/source.js and report what it contains.',
  );

  it('preserves the exact action, observation, synthesis, and state trace', async () => {
    const requests: unknown[][] = [];
    const directives: unknown[] = [];
    const readCall = call('read-1', 'read_file', { path: 'source.js' });
    const toolResult = { path: '/workspace/source.js', content: 'export const value = 1;\n' };
    const turns: ModelTurn[] = [
      {
        content: 'I will inspect the frozen source.',
        reasoning_content: 'private planning',
        decision_summary: 'inspect source',
        tool_calls: [readCall],
        stop_reason: 'tool_use',
        usage: { input_tokens: 7, output_tokens: 3 },
      },
      {
        content: 'The file exports value as 1.',
        decision_summary: 'report verified content',
        stop_reason: 'stop',
        usage: { input_tokens: 11, output_tokens: 5 },
      },
    ];
    const runtimeDeps = scriptedDeps(turns, {
      modelCall: vi.fn(async (messages, attempt, budget, directive) => {
        requests.push(structuredClone(messages));
        directives.push(structuredClone({ attempt, budget, directive }));
        return turns[attempt - 1]!;
      }),
      toolExecute: vi.fn(async () => toolResult),
    });

    const result = await new LoopEngine(
      config('plan_execute', readPlan, {
        budget_tokens: 100,
        max_output_tokens_per_call: 20,
      }),
      runtimeDeps,
    ).run();

    expect(directives).toEqual([
      {
        attempt: 1,
        budget: { remaining_tokens: 100, max_output_tokens: 20 },
        directive: {
          system_instruction:
            'Plan+Execute action step: call read_file exactly once with schema-valid arguments that advance the user task. The read path must be "source.js". Do not call any other tool and do not return a final completion claim yet.',
          allowed_tools: ['read_file'],
          required_tool: 'read_file',
        },
      },
      {
        attempt: 2,
        budget: { remaining_tokens: 90, max_output_tokens: 20 },
        directive: {
          system_instruction:
            'Plan+Execute synthesis step: use the completed tool observations to return the concise final result. Do not call another tool and never claim an unverified effect.',
          allowed_tools: [],
        },
      },
    ]);
    expect(requests).toEqual([
      [{ role: 'user', content: readPlan.task!.goal }],
      [
        { role: 'user', content: readPlan.task!.goal },
        {
          role: 'assistant',
          content: 'I will inspect the frozen source.',
          reasoning_content: 'private planning',
          decision_summary: 'inspect source',
          tool_calls: [readCall],
        },
        {
          role: 'tool',
          tool_call_id: 'read-1',
          content: JSON.stringify({
            tool_call_id: 'read-1',
            name: 'read_file',
            arguments: { path: 'source.js' },
            status: 'ok',
            result: {
              content: toolResult.content,
              path: toolResult.path,
            },
            bytes: Buffer.byteLength(stable(toolResult)),
            truncated: false,
            sha256: sha(toolResult),
          }),
        },
      ],
    ]);
    expect(runtimeDeps.toolExecute).toHaveBeenCalledWith(
      'read_file',
      { path: 'source.js' },
      {
        tool_call_id: 'read-1',
        step_id: 'read-source',
        attempt_index: 1,
      },
    );
    expect(result).toMatchObject({
      strategy: 'plan_execute',
      iterations: 2,
      termination_reason: 'completed',
      decision_summaries: [
        'inspect source',
        'report verified content',
      ],
      usage: {
        input_tokens: 18,
        output_tokens: 8,
        total_tokens: 26,
      },
      step_states: {
        'propose-read': 'done',
        'read-source': 'done',
        summarize: 'done',
      },
    });
    expect(eventData(runtimeDeps.session, 'tool_call')).toEqual([
      {
        step: 'read-source',
        tool_call_id: 'read-1',
        tool: 'read_file',
        arguments: { path: 'source.js' },
      },
    ]);
    expect(
      eventData(runtimeDeps.session, 'system').filter(
        (data) => (data as { event?: string }).event === 'step_state',
      ),
    ).toEqual([
      {
        event: 'step_state',
        step: 'propose-read',
        status: 'executing',
        proposal_attempt: 1,
      },
      {
        event: 'step_state',
        step: 'propose-read',
        status: 'done',
      },
      {
        event: 'step_state',
        step: 'read-source',
        status: 'executing',
      },
      {
        event: 'step_state',
        step: 'read-source',
        status: 'done',
      },
      {
        event: 'step_state',
        step: 'summarize',
        status: 'executing',
        proposal_attempt: 1,
      },
      {
        event: 'step_state',
        step: 'summarize',
        status: 'done',
      },
    ]);
  });

  it('feeds one exact rejection and correction into the second proposal', async () => {
    const requests: unknown[][] = [];
    const wrong = call('wrong', 'read_file', { path: './other.js' });
    const right = call('right', 'read_file', { path: '/workspace/source.js' });
    const turns: ModelTurn[] = [
      {
        content: 'wrong path',
        reasoning_content: 'first private reason',
        decision_summary: 'try read',
        tool_calls: [wrong],
      },
      {
        content: 'corrected path',
        decision_summary: 'read source',
        tool_calls: [right],
      },
      {
        content: 'done',
        decision_summary: 'summarize',
      },
    ];
    const runtimeDeps = scriptedDeps(turns, {
      modelCall: vi.fn(async (messages, attempt) => {
        requests.push(structuredClone(messages));
        return turns[attempt - 1]!;
      }),
      toolExecute: vi.fn(async () => ({ content: 'source' })),
    });

    const result = await new LoopEngine(
      config('plan_execute', readPlan),
      runtimeDeps,
    ).run();

    const rejection = result.turns[0]!.tool_observations[0]!;
    expect(rejection).toEqual({
      tool_call_id: 'wrong',
      name: 'read_file',
      arguments: { path: './other.js' },
      status: 'rejected',
      error: 'read_file path must match frozen task path "source.js"',
      bytes: Buffer.byteLength(stable(
        'read_file path must match frozen task path "source.js"',
      )),
      truncated: false,
      sha256: sha('read_file path must match frozen task path "source.js"'),
    });
    expect(requests[1]).toEqual([
      { role: 'user', content: readPlan.task!.goal },
      {
        role: 'assistant',
        content: 'wrong path',
        reasoning_content: 'first private reason',
        decision_summary: 'try read',
        tool_calls: [wrong],
      },
      {
        role: 'tool',
        tool_call_id: 'wrong',
        content: JSON.stringify(rejection),
      },
      {
        role: 'system',
        content:
          'Correction: read_file path must match frozen task path "source.js". Call read_file exactly once with corrected arguments. The read path must be "source.js".',
      },
    ]);
    expect(runtimeDeps.toolExecute).toHaveBeenCalledTimes(1);
    expect(runtimeDeps.toolExecute).toHaveBeenCalledWith(
      'read_file',
      { path: '/workspace/source.js' },
      {
        tool_call_id: 'right',
        step_id: 'read-source',
        attempt_index: 1,
      },
    );
    expect(result.termination_reason).toBe('completed');
    expect(result.iterations).toBe(3);
  });

  it.each([
    ['argv is absent', { cwd: '/workspace' }],
    ['argv is not an array', { argv: 'node test.mjs', cwd: '/workspace' }],
    ['argv contains a non-string', { argv: ['node', 1], cwd: '/workspace' }],
    ['argv is substituted', { argv: ['node', '--version'], cwd: '/workspace' }],
    ['cwd is absent', { argv: ['node', 'test.mjs'] }],
    ['cwd is substituted', { argv: ['node', 'test.mjs'], cwd: '/tmp' }],
  ])('rejects execute_command when %s', async (_name, args) => {
    const commandPlan = plan(
      [
        node('propose-command', 'model_call'),
        node('run-command', 'tool_call', {
          tool_name: 'execute_command',
        }),
      ],
      [{ from_step: 'propose-command', to_step: 'run-command' }],
      ['execute_command'],
      'Run node test.mjs.',
    );
    const invalid: ModelTurn = {
      content: 'run',
      decision_summary: 'run check',
      tool_calls: [call('invalid-command', 'execute_command', args)],
    };
    const runtimeDeps = scriptedDeps([invalid, invalid], {
      toolExecute: vi.fn(async () => ({ exit_code: 0 })),
    });

    const result = await new LoopEngine(
      config('plan_execute', commandPlan),
      runtimeDeps,
    ).run();

    const reason =
      'execute_command must match frozen task argv ["node","test.mjs"] with cwd "/workspace"';
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.iterations).toBe(2);
    expect(result.step_states).toEqual({
      'propose-command': 'failed',
    });
    expect(runtimeDeps.toolExecute).not.toHaveBeenCalled();
    expect(
      result.turns.map((turn) => turn.tool_observations[0]?.error),
    ).toEqual([reason, reason]);
    expect(
      eventData(runtimeDeps.session, 'system').filter(
        (data) =>
          (data as { event?: string; status?: string }).event ===
            'step_state' &&
          (data as { status?: string }).status === 'failed',
      ),
    ).toEqual([
      {
        event: 'step_state',
        step: 'propose-command',
        status: 'failed',
        reason,
      },
    ]);
  });

  it.each([
    ['missing find', { path: 'app.js', replace: 'new' }],
    ['non-string find', { path: 'app.js', find: 1, replace: 'new' }],
    ['missing replace', { path: 'app.js', find: 'old' }],
    ['non-string replace', { path: 'app.js', find: 'old', replace: 1 }],
    ['no-op replacement', { path: 'app.js', find: 'old', replace: 'old' }],
  ])('rejects edit_file when %s', async (_name, editArgs) => {
    const editPlan = plan(
      [
        node('propose-read', 'model_call'),
        node('read-source', 'tool_call', { tool_name: 'read_file' }),
        node('propose-edit', 'model_call'),
        node('edit-source', 'tool_call', { tool_name: 'edit_file' }),
      ],
      [
        { from_step: 'propose-read', to_step: 'read-source' },
        { from_step: 'read-source', to_step: 'propose-edit' },
        { from_step: 'propose-edit', to_step: 'edit-source' },
      ],
      ['read_file', 'edit_file'],
      'Read app.js and change old to new.',
    );
    const readTurn: ModelTurn = {
      content: 'read',
      decision_summary: 'read source',
      tool_calls: [call('read', 'read_file', { path: 'app.js' })],
    };
    const editTurn: ModelTurn = {
      content: 'edit',
      decision_summary: 'edit source',
      tool_calls: [call('edit', 'edit_file', editArgs)],
    };
    const runtimeDeps = scriptedDeps([readTurn, editTurn, editTurn], {
      toolExecute: vi.fn(async (name) =>
        name === 'read_file'
          ? { path: 'app.js', content: 'old' }
          : { replacements: 1 },
      ),
    });

    const result = await new LoopEngine(
      config('plan_execute', editPlan),
      runtimeDeps,
    ).run();

    const reason =
      'edit_file requires distinct string find and replace arguments';
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.step_states).toEqual({
      'propose-read': 'done',
      'read-source': 'done',
      'propose-edit': 'failed',
    });
    expect(
      (runtimeDeps.toolExecute as ReturnType<typeof vi.fn>).mock.calls.map(
        (entry) => entry[0],
      ),
    ).toEqual(['read_file']);
    expect(
      result.turns.slice(1).map(
        (turn) => turn.tool_observations[0]?.error,
      ),
    ).toEqual([reason, reason]);
  });

  it('does not authorize an edit from a read receipt for a different result path', async () => {
    const editPlan = plan(
      [
        node('propose-read', 'model_call'),
        node('read-source', 'tool_call', { tool_name: 'read_file' }),
        node('propose-edit', 'model_call'),
        node('edit-source', 'tool_call', { tool_name: 'edit_file' }),
      ],
      [
        { from_step: 'propose-read', to_step: 'read-source' },
        { from_step: 'read-source', to_step: 'propose-edit' },
        { from_step: 'propose-edit', to_step: 'edit-source' },
      ],
      ['read_file', 'edit_file'],
      'Read app.js and change old to new.',
    );
    const readTurn: ModelTurn = {
      content: 'read',
      decision_summary: 'read source',
      tool_calls: [call('read', 'read_file', { path: 'app.js' })],
    };
    const editTurn: ModelTurn = {
      content: 'edit',
      decision_summary: 'edit source',
      tool_calls: [
        call('edit', 'edit_file', {
          path: 'app.js',
          find: 'old',
          replace: 'new',
        }),
      ],
    };
    const runtimeDeps = scriptedDeps([readTurn, editTurn, editTurn], {
      toolExecute: vi.fn(async () => ({
        path: '/workspace/other.js',
        content: 'old',
      })),
    });

    const result = await new LoopEngine(
      config('plan_execute', editPlan),
      runtimeDeps,
    ).run();

    const reason =
      'edit_file requires a successful prior read observation for "app.js"';
    expect(result.termination_reason).toBe('malformed_response');
    expect(runtimeDeps.toolExecute).toHaveBeenCalledTimes(1);
    expect(
      result.turns.slice(1).map(
        (turn) => turn.tool_observations[0]?.error,
      ),
    ).toEqual([reason, reason]);
  });

  it.each([
    ['non-string content', 42],
    ['malformed JSON', '{"tasks":'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['missing tasks', '{}'],
    [
      'wrong dependencies',
      JSON.stringify({
        tasks: [
          { id: 'build', depends_on: [] },
          { id: 'test', depends_on: [] },
        ],
      }),
    ],
  ])('rejects planning JSON with %s', async (_name, content) => {
    const planningPlan = plan(
      [
        node('propose-write', 'model_call'),
        node('write-plan', 'tool_call', { tool_name: 'write_file' }),
      ],
      [{ from_step: 'propose-write', to_step: 'write-plan' }],
      ['write_file'],
      'Create plan.json for build and test so every task has an id and depends_on array, with test after build.',
    );
    const writeTurn: ModelTurn = {
      content: 'write',
      decision_summary: 'write plan',
      tool_calls: [
        call('write', 'write_file', {
          path: 'plan.json',
          content,
        }),
      ],
    };
    const runtimeDeps = scriptedDeps([writeTurn, writeTurn], {
      toolExecute: vi.fn(async () => ({ bytes: 1 })),
    });

    const result = await new LoopEngine(
      config('plan_execute', planningPlan),
      runtimeDeps,
    ).run();

    const reason =
      'write_file content must preserve the frozen dependency structure {"tasks":[{"id":"build","depends_on":[]},{"id":"test","depends_on":["build"]}]}';
    expect(result.termination_reason).toBe('malformed_response');
    expect(runtimeDeps.toolExecute).not.toHaveBeenCalled();
    expect(
      result.turns.map((turn) => turn.tool_observations[0]?.error),
    ).toEqual([reason, reason]);
  });

  it('preserves an exact tool-free decision message for its successor', async () => {
    const decisionPlan = plan(
      [
        node('analyze', 'decision'),
        node('answer', 'decision'),
      ],
      [{ from_step: 'analyze', to_step: 'answer' }],
      [],
      'Explain the verified result.',
    );
    const requests: unknown[][] = [];
    const turns: ModelTurn[] = [
      {
        content: 'Analysis based on the available evidence.',
        reasoning_content: 'private synthesis',
        decision_summary: 'analyze evidence',
      },
      {
        content: 'Verified result.',
        decision_summary: 'answer',
      },
    ];
    const runtimeDeps = scriptedDeps(turns, {
      modelCall: vi.fn(async (messages, attempt, _budget, directive) => {
        requests.push(structuredClone(messages));
        expect(directive).toEqual({
          system_instruction:
            'Plan+Execute synthesis step: use the completed tool observations to return the concise final result. Do not call another tool and never claim an unverified effect.',
          allowed_tools: [],
        });
        return turns[attempt - 1]!;
      }),
    });

    const result = await new LoopEngine(
      config('plan_execute', decisionPlan),
      runtimeDeps,
    ).run();

    expect(requests[1]).toEqual([
      { role: 'user', content: decisionPlan.task!.goal },
      {
        role: 'assistant',
        content: 'Analysis based on the available evidence.',
        reasoning_content: 'private synthesis',
        decision_summary: 'analyze evidence',
      },
    ]);
    expect(result.termination_reason).toBe('completed');
    expect(result.step_states).toEqual({
      analyze: 'done',
      answer: 'done',
    });
  });

  it('moves a verification-only plan to the exact pending-verification terminal state', async () => {
    const verificationPlan = plan(
      [node('verify', 'verification')],
      [],
      [],
      'Verify the supplied evidence.',
    );
    const runtimeDeps = scriptedDeps([]);

    const result = await new LoopEngine(
      config('plan_execute', verificationPlan),
      runtimeDeps,
    ).run();

    expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      iterations: 0,
      termination_reason: 'completed',
      step_states: { verify: 'awaiting_verification' },
    });
    expect(eventData(runtimeDeps.session, 'system')).toEqual([
      {
        event: 'step_state',
        step: 'verify',
        status: 'awaiting_verification',
      },
      {
        event: 'run_terminated',
        termination_reason: 'completed',
        iterations: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      },
    ]);
  });

  it('records the exact failed proposal state at a zero iteration limit', async () => {
    const limitedPlan = plan(
      [node('model', 'model_call')],
      [],
      [],
      'Return a result.',
    );
    const runtimeDeps = scriptedDeps([]);

    const result = await new LoopEngine(
      config('plan_execute', limitedPlan, { max_iterations: 0 }),
      runtimeDeps,
    ).run();

    expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
    expect(result.termination_reason).toBe('iteration_limit');
    expect(result.step_states).toEqual({ model: 'failed' });
    expect(eventData(runtimeDeps.session, 'system')).toEqual([
      {
        event: 'step_state',
        step: 'model',
        status: 'failed',
        reason: 'model proposal retry budget exhausted',
      },
      {
        event: 'run_terminated',
        termination_reason: 'iteration_limit',
        iterations: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      },
    ]);
  });

  it('terminates before any step transition when preflight is cancelled', async () => {
    const cancelledPlan = plan(
      [node('model', 'model_call')],
      [],
      [],
      'Return a result.',
    );
    const runtimeDeps = scriptedDeps([], {
      signal: AbortSignal.abort(),
    });

    const result = await new LoopEngine(
      config('plan_execute', cancelledPlan),
      runtimeDeps,
    ).run();

    expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
    expect(result.termination_reason).toBe('user_cancel');
    expect(result.step_states).toEqual({});
    expect(eventData(runtimeDeps.session, 'system')).toEqual([
      {
        event: 'run_terminated',
        termination_reason: 'user_cancel',
        iterations: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      },
    ]);
  });

  it.each(['failed', 'blocked'] as const)(
    'restores a %s dependency and blocks its uneffected descendant',
    async (restoredStatus) => {
      const recoveryPlan = plan(
        [
          node('proposal', 'model_call'),
          node('effect', 'tool_call', { tool_name: 'read_file' }),
        ],
        [{ from_step: 'proposal', to_step: 'effect' }],
        ['read_file'],
        'Read source.js.',
      );
      const runtimeDeps = scriptedDeps([], {
        toolExecute: vi.fn(async () => ({ content: 'never' })),
      });
      runtimeDeps.session.acquireWriter();
      runtimeDeps.session.append('system', {
        event: 'step_state',
        step: 'proposal',
        status: restoredStatus,
      });
      runtimeDeps.session.releaseWriter();

      const result = await new LoopEngine(
        config('plan_execute', recoveryPlan),
        runtimeDeps,
      ).run();

      expect(runtimeDeps.modelCall).not.toHaveBeenCalled();
      expect(runtimeDeps.toolExecute).not.toHaveBeenCalled();
      expect(result.termination_reason).toBe('tool_failure');
      expect(result.step_states).toEqual({ effect: 'blocked' });
      expect(eventData(runtimeDeps.session, 'system').at(-2)).toEqual({
        event: 'step_state',
        step: 'effect',
        status: 'blocked',
        reason: 'dependency failed',
      });
    },
  );

  it.each([
    {
      name: 'ordinary tool error',
      error: new Error('disk unavailable'),
      termination: 'tool_failure',
      reason: 'disk unavailable',
    },
    {
      name: 'runtime contract error',
      error: new LoopError('receipt mismatch'),
      termination: 'malformed_response',
      reason: 'receipt mismatch',
    },
    {
      name: 'non-Error rejection',
      error: 'unknown failure',
      termination: 'tool_failure',
      reason: 'tool execution failed',
    },
  ])('records exact failure state for $name', async (testCase) => {
    const failurePlan = plan(
      [
        node('proposal', 'model_call'),
        node('effect', 'tool_call', { tool_name: 'read_file' }),
      ],
      [{ from_step: 'proposal', to_step: 'effect' }],
      ['read_file'],
      'Read source.js.',
    );
    const readTurn: ModelTurn = {
      content: 'read',
      decision_summary: 'read source',
      tool_calls: [
        call('read-failure', 'read_file', { path: 'source.js' }),
      ],
    };
    const runtimeDeps = scriptedDeps([readTurn], {
      toolExecute: vi.fn(async () => {
        throw testCase.error;
      }),
    });

    const result = await new LoopEngine(
      config('plan_execute', failurePlan),
      runtimeDeps,
    ).run();

    expect(result.termination_reason).toBe(testCase.termination);
    expect(result.step_states).toEqual({
      proposal: 'done',
      effect: 'failed',
    });
    expect(result.turns[0]!.tool_observations[0]).toMatchObject({
      tool_call_id: 'read-failure',
      name: 'read_file',
      status: 'error',
      error: testCase.reason,
    });
    expect(eventData(runtimeDeps.session, 'system').at(-2)).toEqual({
      event: 'step_state',
      step: 'effect',
      status: 'failed',
      reason: testCase.reason,
    });
  });
});

describe('ReAct golden behavior', () => {
  const reactPlan = plan([], [], ['read_file'], 'Read fact.txt and answer.');

  it('preserves one assistant action, one observation, and one final answer', async () => {
    const requests: unknown[][] = [];
    const directives: unknown[] = [];
    const readCall = call('react-read', 'read_file', {
      path: 'fact.txt',
    });
    const toolResult = { content: 'forty two' };
    const turns: ModelTurn[] = [
      {
        content: 'I will read it.',
        reasoning_content: 'private react trace',
        decision_summary: 'read fact',
        tool_calls: [readCall],
        stop_reason: 'tool_use',
        usage: { input_tokens: 4, output_tokens: 2 },
      },
      {
        content: 'The fact is forty two.',
        decision_summary: 'answer from observation',
        stop_reason: 'stop',
        usage: { input_tokens: 8, output_tokens: 4 },
      },
    ];
    const runtimeDeps = scriptedDeps(turns, {
      modelCall: vi.fn(async (messages, attempt, budget, directive) => {
        requests.push(structuredClone(messages));
        directives.push(structuredClone({ attempt, budget, directive }));
        return turns[attempt - 1]!;
      }),
      toolExecute: vi.fn(async () => toolResult),
    });

    const result = await new LoopEngine(
      config('react', reactPlan, {
        budget_tokens: 50,
        max_output_tokens_per_call: 10,
      }),
      runtimeDeps,
    ).run();

    const observation = {
      tool_call_id: 'react-read',
      name: 'read_file',
      arguments: { path: 'fact.txt' },
      status: 'ok',
      result: toolResult,
      bytes: Buffer.byteLength(stable(toolResult)),
      truncated: false,
      sha256: sha(toolResult),
    };
    expect(requests).toEqual([
      [{ role: 'user', content: reactPlan.task!.goal }],
      [
        { role: 'user', content: reactPlan.task!.goal },
        {
          role: 'assistant',
          content: 'I will read it.',
          reasoning_content: 'private react trace',
          decision_summary: 'read fact',
          tool_calls: [readCall],
        },
        {
          role: 'tool',
          tool_call_id: 'react-read',
          content: JSON.stringify(observation),
        },
      ],
    ]);
    expect(directives).toEqual([
      {
        attempt: 1,
        budget: { remaining_tokens: 50, max_output_tokens: 10 },
        directive: {
          system_instruction:
            'ReAct mode: use workspace tools only when needed. Base each next action on prior tool observations. When complete, return the concise final answer without a tool call. Never expose private reasoning.',
          allowed_tools: ['read_file'],
        },
      },
      {
        attempt: 2,
        budget: { remaining_tokens: 44, max_output_tokens: 10 },
        directive: {
          system_instruction:
            'ReAct mode: use workspace tools only when needed. Base each next action on prior tool observations. When complete, return the concise final answer without a tool call. Never expose private reasoning.',
          allowed_tools: ['read_file'],
        },
      },
    ]);
    expect(runtimeDeps.toolExecute).toHaveBeenCalledWith(
      'read_file',
      { path: 'fact.txt' },
      {
        tool_call_id: 'react-read',
        step_id: 'react-1',
        attempt_index: 1,
      },
    );
    expect(result).toMatchObject({
      strategy: 'react',
      iterations: 2,
      termination_reason: 'completed',
      decision_summaries: [
        'read fact',
        'answer from observation',
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        total_tokens: 18,
      },
    });
    expect(result.turns[0]!.tool_observations).toEqual([observation]);
  });

  it('records every duplicate occurrence as rejected without an effect', async () => {
    const duplicate = call('same', 'read_file', { path: 'fact.txt' });
    const runtimeDeps = scriptedDeps([
      {
        content: 'duplicate',
        reasoning_content: 'private',
        decision_summary: 'bad duplicate',
        tool_calls: [duplicate, duplicate],
      },
    ], {
      toolExecute: vi.fn(async () => ({ content: 'never' })),
    });

    const result = await new LoopEngine(
      config('react', reactPlan),
      runtimeDeps,
    ).run();

    expect(result.termination_reason).toBe('malformed_response');
    expect(runtimeDeps.toolExecute).not.toHaveBeenCalled();
    expect(result.turns[0]!.tool_observations).toHaveLength(1);
    expect(result.turns[0]!.tool_observations[0]).toMatchObject({
      tool_call_id: 'same',
      name: 'read_file',
      arguments: { path: 'fact.txt' },
      status: 'rejected',
      error: 'duplicate tool_call id in one model turn',
    });
    expect(eventData(runtimeDeps.session, 'tool_call')).toEqual([
      {
        step: 'react-1',
        tool_call_id: 'same',
        tool: 'read_file',
        arguments: { path: 'fact.txt' },
      },
    ]);
  });
});
