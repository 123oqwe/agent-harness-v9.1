import { describe, it, expect, vi } from 'vitest';
import { runDirect } from '../../runtime/direct.js';
import type { StrategyContext } from '../../runtime/reasoning-strategy.js';
import type {
  LoopConfig, LoopDeps, LoopTurn, ModelTurn, ModelCallBudget,
  ModelCallDirective, TerminationReason,
} from '../../runtime/loop.js';
import type { DurableSession } from '../../session/durable-session.js';

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', ...overrides } as LoopConfig;
}
function makeBudget(o: Partial<ModelCallBudget> = {}): ModelCallBudget {
  return { remaining_tokens: 1000, max_output_tokens: 500, ...o };
}
function makeTurn(o: Partial<ModelTurn> = {}): ModelTurn {
  return { content: 'answer', decision_summary: 's', stop_reason: 'stop', ...o };
}
function makeMockSession(): DurableSession {
  return { session_id: 's', append: vi.fn(), appendEvent: vi.fn() } as unknown as DurableSession;
}

interface MockOpts {
  config?: Partial<LoopConfig>;
  budget?: Partial<ModelCallBudget>;
  modelTurn?: ModelTurn;
  budgetExceeded?: boolean;
  preflight?: TerminationReason | null;
}

function makeMockContext(opts: MockOpts = {}) {
  const config = makeConfig(opts.config);
  const budget = makeBudget(opts.budget);
  const turn = opts.modelTurn ?? makeTurn();
  const modelCalls: { messages: unknown[]; attempt: number; budget: ModelCallBudget; directive?: ModelCallDirective }[] = [];
  const terminates: TerminationReason[] = [];
  const sessionAppends: { type: string; data: unknown }[] = [];
  let _terminated = false;
  const session = makeMockSession();
  (session.append as ReturnType<typeof vi.fn>).mockImplementation((type: string, data: unknown) => {
    sessionAppends.push({ type, data });
  });
  const deps = {
    session,
    modelCall: vi.fn(async (messages: unknown[], attempt: number, b: ModelCallBudget, directive?: ModelCallDirective) => {
      modelCalls.push({ messages, attempt, budget: b, directive: directive! });
      return turn;
    }),
  } as unknown as LoopDeps;
  const context: StrategyContext = {
    config, deps, turns: [] as LoopTurn[], iterations: 0,
    get terminated() { return _terminated; },
    decisionSummaries: [], startTime: Date.now(),
    preflight: () => opts.preflight ?? null,
    nextModelBudget: () => budget,
    budgetExceeded: () => opts.budgetExceeded ?? false,
    recordTurn: (t: ModelTurn) => {
      const lt: LoopTurn = { iteration: 1, model: t, tool_observations: [], timestamp: new Date().toISOString() };
      (context.turns as LoopTurn[]).push(lt);
      return lt;
    },
    recordToolCall: vi.fn(),
    recordObservation: vi.fn(),
    terminate: (reason: TerminationReason) => { terminates.push(reason); _terminated = true; },
    setStepState: vi.fn(),
  };
  return { context, modelCalls, terminates, sessionAppends };
}

describe('runDirect', () => {
  it('completes with the model response when no tool calls', async () => {
    const { context, terminates, modelCalls } = makeMockContext({
      modelTurn: makeTurn({ content: 'hello', stop_reason: 'stop' }),
    });
    await runDirect(context, []);
    expect(terminates).toEqual(['completed']);
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]!.directive?.allowed_tools).toEqual([]);
  });

  it('terminates on preflight reason', async () => {
    const { context, terminates } = makeMockContext({ preflight: 'deadline' as TerminationReason });
    await runDirect(context, []);
    expect(terminates).toEqual(['deadline']);
    expect(context.iterations).toBe(0);
  });

  it('sets iterations to 1 before model call', async () => {
    const { context } = makeMockContext();
    await runDirect(context, []);
    expect(context.iterations).toBe(1);
  });

  it('terminates malformed_response on stop_reason=length with empty content', async () => {
    const { context, terminates } = makeMockContext({
      modelTurn: makeTurn({ content: '   ', stop_reason: 'length' }),
    });
    await runDirect(context, []);
    expect(terminates).toEqual(['malformed_response']);
  });

  it('terminates malformed_response on stop_reason=length with tool_calls', async () => {
    const { context, terminates } = makeMockContext({
      modelTurn: makeTurn({ content: 'p', stop_reason: 'length', tool_calls: [{ id: 'tc1', name: 'x', arguments: {} }] }),
    });
    await runDirect(context, []);
    expect(terminates).toEqual(['malformed_response']);
  });

  it('does NOT terminate malformed on stop_reason=length with content and no tool_calls', async () => {
    const { context, terminates } = makeMockContext({
      modelTurn: makeTurn({ content: 'some content', stop_reason: 'length' }),
    });
    await runDirect(context, []);
    expect(terminates).toEqual(['completed']);
  });

  it('terminates model_refusal on stop_reason=content_filter', async () => {
    const { context, terminates } = makeMockContext({
      modelTurn: makeTurn({ content: 'x', stop_reason: 'content_filter' }),
    });
    await runDirect(context, []);
    expect(terminates).toEqual(['model_refusal']);
  });

  it('terminates budget_exhausted when budgetExceeded after model call', async () => {
    const { context, terminates } = makeMockContext({ budgetExceeded: true });
    await runDirect(context, []);
    expect(terminates).toEqual(['budget_exhausted']);
  });

  it('rejects tool calls and terminates malformed_response', async () => {
    const { context, terminates, sessionAppends } = makeMockContext({
      modelTurn: makeTurn({
        content: '', stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }],
      }),
    });
    await runDirect(context, []);
    expect(terminates).toEqual(['malformed_response']);
    expect(context.recordToolCall).toHaveBeenCalledTimes(1);
    expect(context.recordObservation).toHaveBeenCalledTimes(1);
    expect(sessionAppends.some(s => s.type === 'system' && JSON.stringify(s.data).includes('strategy_violation'))).toBe(true);
  });

  it('rejects multiple tool calls in one turn', async () => {
    const { context, terminates } = makeMockContext({
      modelTurn: makeTurn({
        content: '', stop_reason: 'tool_use',
        tool_calls: [
          { id: 'tc1', name: 'read_file', arguments: {} },
          { id: 'tc2', name: 'write_file', arguments: {} },
        ],
      }),
    });
    await runDirect(context, []);
    expect(terminates).toEqual(['malformed_response']);
    expect(context.recordToolCall).toHaveBeenCalledTimes(2);
    expect(context.recordObservation).toHaveBeenCalledTimes(2);
  });

  it('passes system instruction mentioning Direct mode and no tools', async () => {
    const { context, modelCalls } = makeMockContext();
    await runDirect(context, []);
    const si = modelCalls[0]!.directive?.system_instruction ?? '';
    expect(si).toContain('Direct mode');
    expect(si).toContain('Do not call tools');
    expect(si).toContain('never expose private reasoning');
  });

  it('records the turn before checking tool calls', async () => {
    const { context } = makeMockContext({
      modelTurn: makeTurn({ content: 'answer', stop_reason: 'stop' }),
    });
    await runDirect(context, []);
    expect(context.turns).toHaveLength(1);
    expect(context.turns[0]!.model.content).toBe('answer');
  });
});
