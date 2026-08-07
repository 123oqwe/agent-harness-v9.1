import { describe, it, expect, vi } from 'vitest';
import { runReact } from '../../runtime/react.js';
import { explicitOutputLimitInstruction } from '../../runtime/react.js';
import { HookRestrictionError } from '../../runtime/hook-port.js';
import type { StrategyContext } from '../../runtime/reasoning-strategy.js';
import type {
  LoopConfig,
  LoopDeps,
  LoopTurn,
  ModelTurn,
  ModelCallBudget,
  ModelCallDirective,
  ToolObservation,
  TerminationReason,
  RuntimeStepState,
} from '../../runtime/loop.js';
import type { DurableSession } from '../../session/durable-session.js';

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    strategy: 'react',
    max_iterations: 5,
    run_id: 'test-run',
    goal: 'test goal',
    run_plan: {
      task: { goal: 'test goal', success_criteria: [], constraints: [] },
      tool_grants: [{ tool: 'read_file' }, { tool: 'write_file' }],
      workflow_graph: { nodes: [], edges: [] },
    } as any,
    ...overrides,
  };
}

function makeBudget(overrides: Partial<ModelCallBudget> = {}): ModelCallBudget {
  return { remaining_tokens: 1000, max_output_tokens: 500, ...overrides };
}

function makeTurn(overrides: Partial<ModelTurn> = {}): ModelTurn {
  return {
    content: 'ok',
    decision_summary: 'summary',
    stop_reason: 'stop',
    ...overrides,
  };
}

function makeMockSession(): DurableSession {
  return {
    session_id: 'test-session',
    append: vi.fn(),
    appendEvent: vi.fn(),
  } as unknown as DurableSession;
}

interface MockContextOptions {
  config?: Partial<LoopConfig>;
  budget?: Partial<ModelCallBudget>;
  modelTurns?: ModelTurn[];
  toolExecute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  budgetExceeded?: boolean;
  preflight?: TerminationReason | null;
}

function makeMockContext(opts: MockContextOptions = {}): {
  context: StrategyContext;
  modelCalls: { messages: unknown[]; attempt: number; budget: ModelCallBudget; directive?: ModelCallDirective }[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
  terminates: TerminationReason[];
  observations: { status: string; payload: unknown }[];
} {
  const config = makeConfig(opts.config);
  const budget = makeBudget(opts.budget);
  const turns: ModelTurn[] = opts.modelTurns ?? [makeTurn()];
  let turnIndex = 0;
  const modelCalls: { messages: unknown[]; attempt: number; budget: ModelCallBudget; directive?: ModelCallDirective }[] = [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const terminates: TerminationReason[] = [];
  const observations: { status: string; payload: unknown }[] = [];
  let _terminated = false;

  const session = makeMockSession();

  const deps: LoopDeps = {
    session,
    modelCall: vi.fn(async (messages: unknown[], attempt: number, b: ModelCallBudget, directive?: ModelCallDirective) => {
      modelCalls.push({ messages, attempt, budget: b, directive: directive! });
      return turns[turnIndex++] ?? makeTurn();
    }),
  } as LoopDeps;
  if (opts.toolExecute) {
    deps.toolExecute = vi.fn(async (name: string, args: Record<string, unknown>) => {
      toolCalls.push({ name, args });
      return opts.toolExecute!(name, args);
    });
  }

  const context: StrategyContext = {
    config,
    deps,
    turns: [] as LoopTurn[],
    iterations: 0,
    get terminated() { return _terminated; },
    decisionSummaries: [],
    startTime: Date.now(),
    preflight: () => opts.preflight ?? null,
    nextModelBudget: () => budget,
    budgetExceeded: () => opts.budgetExceeded ?? false,
    recordTurn: (turn: ModelTurn) => {
      const lt: LoopTurn = {
        iteration: context.iterations,
        model: turn,
        tool_observations: [],
        timestamp: new Date().toISOString(),
      };
      (context.turns as LoopTurn[]).push(lt);
      return lt;
    },
    recordToolCall: vi.fn(),
    recordObservation: vi.fn((_turn, _call, status, payload) => {
      const obs: ToolObservation = {
        tool_call_id: 'tc-1',
        name: 'test',
        arguments: {},
        status: status as ToolObservation['status'],
        result: payload,
        bytes: 0,
        truncated: false,
        sha256: 'abc',
      };
      observations.push({ status, payload });
      return obs;
    }),
    terminate: (reason: TerminationReason) => {
      terminates.push(reason);
      _terminated = true;
    },
    setStepState: vi.fn(),
  };

  return { context, modelCalls, toolCalls, terminates, observations };
}

describe('runReact loop', () => {
  it('terminates as completed when model returns no tool calls', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({ content: 'done', stop_reason: 'stop' })],
    });
    await runReact(context, []);
    expect(terminates).toEqual(['completed']);
  });

  it('terminates as budget_exhausted when remaining_tokens <= 0', async () => {
    const { context, terminates } = makeMockContext({
      budget: { remaining_tokens: 0, max_output_tokens: 500 },
    });
    await runReact(context, []);
    expect(terminates).toEqual(['budget_exhausted']);
  });

  it('terminates as budget_exhausted when max_output_tokens <= 0', async () => {
    const { context, terminates } = makeMockContext({
      budget: { remaining_tokens: 1000, max_output_tokens: 0 },
    });
    await runReact(context, []);
    expect(terminates).toEqual(['budget_exhausted']);
  });

  it('terminates as malformed_response on stop_reason=length with empty content', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({ content: '   ', stop_reason: 'length' })],
    });
    await runReact(context, []);
    expect(terminates).toEqual(['malformed_response']);
  });

  it('terminates as malformed_response on stop_reason=length with tool_calls', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({
        content: 'partial',
        stop_reason: 'length',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      })],
    });
    await runReact(context, []);
    expect(terminates).toEqual(['malformed_response']);
  });

  it('does NOT terminate malformed on stop_reason=length with content and no tool_calls', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({ content: 'some content', stop_reason: 'length' })],
    });
    await runReact(context, []);
    expect(terminates).toEqual(['completed']);
  });

  it('terminates as model_refusal on stop_reason=content_filter', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({ content: 'x', stop_reason: 'content_filter' })],
    });
    await runReact(context, []);
    expect(terminates).toEqual(['model_refusal']);
  });

  it('passes allowed_tools and output limit instruction to modelCall', async () => {
    const { context, modelCalls } = makeMockContext({
      config: makeConfig({
        goal: 'answer in at most 50 words',
        run_plan: {
          task: { goal: 'answer in at most 50 words', success_criteria: [], constraints: [] },
          tool_grants: [{ tool: 'read_file' }],
          workflow_graph: { nodes: [], edges: [] },
        } as any,
      }),
      modelTurns: [makeTurn()],
    });
    await runReact(context, []);
    expect(modelCalls).toHaveLength(1);
    const directive = modelCalls[0]!.directive;
    expect(directive?.allowed_tools).toEqual(['read_file']);
    expect(directive?.system_instruction).toContain('at most 50');
    expect(directive?.system_instruction).toContain('words');
  });

  it('passes empty allowed_tools when no run_plan', async () => {
    const { context, modelCalls } = makeMockContext({
      config: { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: undefined } as any,
      modelTurns: [makeTurn()],
    });
    await runReact(context, []);
    expect(modelCalls[0]!.directive?.allowed_tools).toEqual([]);
  });

  it('includes reasoning_content in message when present', async () => {
    const { context, modelCalls, terminates } = makeMockContext({
      modelTurns: [
        makeTurn({
          content: '',
          reasoning_content: 'thinking...',
          stop_reason: 'tool_use',
          tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }],
        }),
        makeTurn({ content: 'done', stop_reason: 'stop' }),
      ],
      toolExecute: async () => 'result',
    });
    await runReact(context, []);
    // Second call's messages should include reasoning_content from first turn
    const secondMessages = modelCalls[1]?.messages as any[];
    const assistantMsg = secondMessages?.find((m: any) => m.role === 'assistant');
    expect(assistantMsg?.reasoning_content).toBe('thinking...');
    expect(terminates).toContain('completed');
  });

  it('omits reasoning_content key when undefined', async () => {
    const { context, modelCalls } = makeMockContext({
      modelTurns: [
        makeTurn({
          content: '',
          stop_reason: 'tool_use',
          tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
        }),
        makeTurn({ content: 'done', stop_reason: 'stop' }),
      ],
      toolExecute: async () => 'result',
    });
    await runReact(context, []);
    const secondMessages = modelCalls[1]?.messages as any[];
    const assistantMsg = secondMessages?.find((m: any) => m.role === 'assistant');
    expect(assistantMsg?.reasoning_content).toBeUndefined();
  });

  it('rejects tool not in allowed set', async () => {
    const { context, terminates, observations } = makeMockContext({
      modelTurns: [makeTurn({
        content: '',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'unknown_tool', arguments: {} }],
      })],
    });
    await runReact(context, []);
    expect(terminates).toEqual(['malformed_response']);
    expect(observations.some(o => o.status === 'rejected' && typeof o.payload === 'string' && (o.payload as string).includes('not bound'))).toBe(true);
  });

  it('rejects duplicate tool call IDs', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({
        content: '',
        stop_reason: 'tool_use',
        tool_calls: [
          { id: 'dup', name: 'read_file', arguments: {} },
          { id: 'dup', name: 'write_file', arguments: {} },
        ],
      })],
    });
    await runReact(context, []);
    expect(terminates).toEqual(['malformed_response']);
  });

  it('terminates as tool_oscillation after 3 identical calls', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [
        makeTurn({ content: '', stop_reason: 'tool_use', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }] }),
        makeTurn({ content: '', stop_reason: 'tool_use', tool_calls: [{ id: 'tc2', name: 'read_file', arguments: { path: '/a' } }] }),
        makeTurn({ content: '', stop_reason: 'tool_use', tool_calls: [{ id: 'tc3', name: 'read_file', arguments: { path: '/a' } }] }),
        makeTurn({ content: 'done', stop_reason: 'stop' }),
      ],
      toolExecute: async () => 'result',
    });
    await runReact(context, []);
    expect(terminates).toContain('tool_oscillation');
  });

  it('terminates as malformed_response when toolExecute is undefined', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({
        content: '',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      })],
      // no toolExecute
    });
    await runReact(context, []);
    expect(terminates).toEqual(['malformed_response']);
  });

  it('records error observation and continues on tool execution failure', async () => {
    const { context, observations, terminates } = makeMockContext({
      modelTurns: [
        makeTurn({ content: '', stop_reason: 'tool_use', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }] }),
        makeTurn({ content: 'done', stop_reason: 'stop' }),
      ],
      toolExecute: async () => { throw new Error('tool broke'); },
    });
    await runReact(context, []);
    expect(observations.some(o => o.status === 'error')).toBe(true);
    expect(terminates).toContain('completed');
  });

  it('terminates as denied on HookRestrictionError with action=deny', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({
        content: '',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      })],
      toolExecute: async () => { throw new HookRestrictionError('pre_tool_use', 'deny', 'blocked'); },
    });
    await runReact(context, []);
    expect(terminates).toEqual(['denied']);
  });

  it('terminates as approval_required on HookRestrictionError with action=force_prompt', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({
        content: '',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      })],
      toolExecute: async () => { throw new HookRestrictionError('pre_tool_use', 'force_prompt', 'needs approval'); },
    });
    await runReact(context, []);
    expect(terminates).toEqual(['approval_required']);
  });

  it('terminates as skipped on HookRestrictionError with action=skip', async () => {
    const { context, terminates } = makeMockContext({
      modelTurns: [makeTurn({
        content: '',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      })],
      toolExecute: async () => { throw new HookRestrictionError('pre_tool_use', 'skip', 'skip it'); },
    });
    await runReact(context, []);
    expect(terminates).toEqual(['skipped']);
  });

  it('terminates as budget_exhausted when budgetExceeded after model call', async () => {
    const { context, terminates, observations } = makeMockContext({
      modelTurns: [makeTurn({
        content: '',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      })],
      budgetExceeded: true,
    });
    await runReact(context, []);
    expect(terminates).toEqual(['budget_exhausted']);
    expect(observations.some(o => o.status === 'rejected')).toBe(true);
  });

  it('terminates as iteration_limit when max_iterations reached', async () => {
    const { context, terminates } = makeMockContext({
      config: { strategy: 'react', max_iterations: 1, run_id: 'r', goal: 'g' },
      modelTurns: [makeTurn({
        content: '',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      })],
      toolExecute: async () => 'result',
    });
    await runReact(context, []);
    // After 1 iteration with tool call, loop exits at max_iterations
    expect(terminates).toContain('iteration_limit');
  });

  it('terminates on preflight reason', async () => {
    const { context, terminates } = makeMockContext({
      preflight: 'deadline' as TerminationReason,
    });
    await runReact(context, []);
    expect(terminates).toEqual(['deadline']);
  });

  it('executes multiple tool calls in a single turn', async () => {
    const { context, toolCalls, terminates } = makeMockContext({
      modelTurns: [
        makeTurn({
          content: '',
          stop_reason: 'tool_use',
          tool_calls: [
            { id: 'tc1', name: 'read_file', arguments: { path: '/a' } },
            { id: 'tc2', name: 'write_file', arguments: { path: '/b' } },
          ],
        }),
        makeTurn({ content: 'done', stop_reason: 'stop' }),
      ],
      toolExecute: async () => 'ok',
    });
    await runReact(context, []);
    expect(toolCalls).toHaveLength(2);
    expect(terminates).toContain('completed');
  });
});

describe('explicitOutputLimitInstruction edge cases', () => {
  it('handles word limit with extra whitespace between words', () => {
    // Two spaces after "most" - \s+ should match
    const result = explicitOutputLimitInstruction('at most  100 words');
    expect(result).toContain('100');
  });

  it('handles word limit with extra whitespace before "words"', () => {
    const result = explicitOutputLimitInstruction('at most 100  words');
    expect(result).toContain('100');
  });

  it('handles "maximum of" with capital M', () => {
    const result = explicitOutputLimitInstruction('Maximum Of 50 Words');
    expect(result).toContain('50');
  });

  it('handles word "word" singular (not just "words")', () => {
    const result = explicitOutputLimitInstruction('at most 100 word');
    expect(result).toContain('100');
  });

  it('parses "eleven" as 11', () => {
    const result = explicitOutputLimitInstruction('at most eleven words');
    expect(result).toContain('11');
  });

  it('returns empty for negative number', () => {
    // Regex \d+ won't match negative, so this returns empty
    const result = explicitOutputLimitInstruction('at most -5 words');
    expect(result).toBe('');
  });
});
