import { describe, it, expect, vi } from 'vitest';
import { LoopEngine, LoopError, type LoopConfig, type LoopDeps, type ModelTurn, type TerminationReason } from '../../runtime/loop.js';
import type { DurableSession } from '../../session/durable-session.js';
import { HookRestrictionError } from '../../runtime/hook-port.js';
import { EventBus } from '../../runtime/event-bus.js';
import type { RuntimeBudgetPort } from '../../runtime/budget-port.js';
import type { RuntimeSteeringPort, RuntimeSteeringCommand } from '../../runtime/steering-port.js';

function makeSession(id = 'loop-deep'): DurableSession {
  return { session_id: id, append: vi.fn(), appendEvent: vi.fn(), getEvents: vi.fn(() => []), eventCount: vi.fn(() => 0), acquireWriter: vi.fn(), releaseWriter: vi.fn(), snapshot_: vi.fn() } as unknown as DurableSession;
}

function baseConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    strategy: 'direct',
    max_iterations: 1,
    run_id: 'loop-deep-run',
    goal: 'answer the question',
    clock: () => '2026-07-25T00:00:00.000Z',
    nowMs: () => 1000,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  return {
    session: makeSession(),
    modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 'answered' } as ModelTurn)),
    ...overrides,
  } as LoopDeps;
}

describe('LoopEngine config validation deep', () => {
  it('rejects empty run_id', () => {
    expect(() => new LoopEngine(baseConfig({ run_id: '   ' }), baseDeps())).toThrow(LoopError);
  });

  it('rejects empty goal', () => {
    expect(() => new LoopEngine(baseConfig({ goal: '' }), baseDeps())).toThrow(LoopError);
  });

  it('rejects negative max_iterations', () => {
    expect(() => new LoopEngine(baseConfig({ max_iterations: -1 }), baseDeps())).toThrow(LoopError);
  });

  it('rejects non-integer max_iterations', () => {
    expect(() => new LoopEngine(baseConfig({ max_iterations: 1.5 }), baseDeps())).toThrow(LoopError);
  });

  it('rejects negative budget_tokens', () => {
    expect(() => new LoopEngine(baseConfig({ budget_tokens: -1 }), baseDeps())).toThrow(LoopError);
  });

  it('rejects non-integer budget_tokens', () => {
    expect(() => new LoopEngine(baseConfig({ budget_tokens: 1.5 }), baseDeps())).toThrow(LoopError);
  });

  it('rejects negative deadline_ms', () => {
    expect(() => new LoopEngine(baseConfig({ deadline_ms: -1 }), baseDeps())).toThrow(LoopError);
  });

  it('rejects non-integer deadline_ms', () => {
    expect(() => new LoopEngine(baseConfig({ deadline_ms: 1.5 }), baseDeps())).toThrow(LoopError);
  });

  it('rejects negative max_output_tokens_per_call', () => {
    expect(() => new LoopEngine(baseConfig({ max_output_tokens_per_call: -1 }), baseDeps())).toThrow(LoopError);
  });

  it('rejects negative max_observation_bytes', () => {
    expect(() => new LoopEngine(baseConfig({ max_observation_bytes: -1 }), baseDeps())).toThrow(LoopError);
  });

  it('accepts max_iterations of 0', async () => {
    const loop = new LoopEngine(baseConfig({ max_iterations: 0 }), baseDeps());
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
  });

  it('accepts undefined budget and deadline', async () => {
    const loop = new LoopEngine(baseConfig(), baseDeps());
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
  });
});

describe('LoopEngine budget tracking deep', () => {
  it('accumulates usage across turns and terminates on budget_exhausted', async () => {
    let callCount = 0;
    const deps = baseDeps({
      modelCall: vi.fn(async () => {
        callCount++;
        return {
          content: 'continue',
          decision_summary: 'go',
          usage: { input_tokens: 100, output_tokens: 50 },
        } as ModelTurn;
      }),
    });
    const loop = new LoopEngine(
      baseConfig({ strategy: 'react', max_iterations: 10, budget_tokens: 120 }),
      deps,
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('budget_exhausted');
    expect(result.usage.total_tokens).toBe(150);
  });

  it('caps max_output_tokens in budget from config', async () => {
    const observedBudgets: Array<{ remaining: number; max_output: number }> = [];
    const deps = baseDeps({
      modelCall: vi.fn(async (_msg, _att, budget) => {
        observedBudgets.push({ remaining: budget.remaining_tokens, max_output: budget.max_output_tokens });
        return { content: 'done', decision_summary: 's' } as ModelTurn;
      }),
    });
    const loop = new LoopEngine(
      baseConfig({ budget_tokens: 10000, max_output_tokens_per_call: 100 }),
      deps,
    );
    await loop.run();
    expect(observedBudgets[0]).toEqual({ remaining: 10000, max_output: 100 });
  });

  it('budgetGuard beforeModelCall can deny and terminate', async () => {
    const budgetGuard: RuntimeBudgetPort = {
      beforeModelCall: vi.fn(() => ({ allowed: false, reason: 'budget_exhausted' as const, max_output_tokens: 0 })),
      afterModelCall: vi.fn(),
    };
    const modelCall = vi.fn(async () => ({ content: 'x', decision_summary: 'x' } as ModelTurn));
    const loop = new LoopEngine(
      baseConfig(),
      baseDeps({ modelCall, budgetGuard }),
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('budget_exhausted');
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('budgetGuard beforeModelCall can cap max_output_tokens', async () => {
    const observedMax: number[] = [];
    const budgetGuard: RuntimeBudgetPort = {
      beforeModelCall: vi.fn(() => ({ allowed: true, reason: 'within_budget' as const, max_output_tokens: 50 })),
      afterModelCall: vi.fn(),
    };
    const deps = baseDeps({
      modelCall: vi.fn(async (_msg, _att, budget) => {
        observedMax.push(budget.max_output_tokens);
        return { content: 'done', decision_summary: 's' } as ModelTurn;
      }),
      budgetGuard,
    });
    const loop = new LoopEngine(baseConfig({ max_output_tokens_per_call: 500 }), deps);
    await loop.run();
    expect(observedMax[0]).toBe(50);
  });

  it('budgetGuard afterModelCall is called with usage', async () => {
    const afterCalls: unknown[] = [];
    const budgetGuard: RuntimeBudgetPort = {
      beforeModelCall: vi.fn(() => ({ allowed: true, reason: 'within_budget' as const, max_output_tokens: 4096 })),
      afterModelCall: vi.fn((input) => { afterCalls.push(input); }),
    };
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 's',
        usage: { input_tokens: 10, output_tokens: 5 },
      } as ModelTurn)),
      budgetGuard,
    });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0]).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
});

describe('LoopEngine classifyUnhandled deep', () => {
  it('classifies HookRestrictionError deny as denied', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => {
        throw new HookRestrictionError('pre_turn', 'deny', 'blocked');
      }),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('denied');
  });

  it('classifies HookRestrictionError force_prompt as approval_required', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => {
        throw new HookRestrictionError('pre_turn', 'force_prompt', 'needs approval');
      }),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('approval_required');
  });

  it('classifies HookRestrictionError skip as skipped', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => {
        throw new HookRestrictionError('pre_turn', 'skip', 'skip it');
      }),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('skipped');
  });

  it('classifies LoopError as malformed_response', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => {
        throw new LoopError('bad model');
      }),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('malformed_response');
  });

  it('classifies generic Error as provider_failure', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('provider_failure');
  });
});

describe('LoopEngine recordTurn usage validation', () => {
  it('rejects negative input_tokens', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 's',
        usage: { input_tokens: -1, output_tokens: 0 },
      } as ModelTurn)),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('malformed_response');
  });

  it('rejects negative output_tokens', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 's',
        usage: { input_tokens: 0, output_tokens: -5 },
      } as ModelTurn)),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('malformed_response');
  });

  it('accepts zero usage', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 's',
        usage: { input_tokens: 0, output_tokens: 0 },
      } as ModelTurn)),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
    expect(result.usage.total_tokens).toBe(0);
  });

  it('defaults to zero usage when usage is undefined', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 's',
      } as ModelTurn)),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });
});

describe('LoopEngine clock validation deep', () => {
  it('rejects invalid clock timestamp', async () => {
    const loop = new LoopEngine(
      baseConfig({ clock: () => 'not-a-date' }),
      baseDeps(),
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('malformed_response');
  });

  it('rejects invalid nowMs value', () => {
    expect(() => new LoopEngine(baseConfig({ nowMs: () => -1 }), baseDeps())).toThrow(LoopError);
    expect(() => new LoopEngine(baseConfig({ nowMs: () => NaN }), baseDeps())).toThrow(LoopError);
  });

  it('rejects non-integer nowMs', () => {
    expect(() => new LoopEngine(baseConfig({ nowMs: () => 1.5 }), baseDeps())).toThrow(LoopError);
  });
});

describe('LoopEngine context reset deep', () => {
  it('triggers context_reset when context pressure exceeds threshold', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn)),
    });
    const loop = new LoopEngine(
      baseConfig({
        context_capacity_tokens: 10,
        context_compaction_threshold: 0.5,
      }),
      deps,
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('context_reset');
    expect(result.context_reset_emitted).toBe(true);
  });

  it('does not trigger context_reset when under threshold', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn)),
    });
    const loop = new LoopEngine(
      baseConfig({
        context_capacity_tokens: 1000000,
        context_compaction_threshold: 0.85,
      }),
      deps,
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
    expect(result.context_reset_emitted).toBe(false);
  });

  it('uses default 0.85 threshold when not specified', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn)),
    });
    const loop = new LoopEngine(
      baseConfig({ context_capacity_tokens: 5 }),
      deps,
    );
    // goal "answer the question" is ~19 chars, estimated as ~5 tokens, which exceeds 5 * 0.85 = 4.25
    const result = await loop.run();
    expect(result.termination_reason).toBe('context_reset');
  });
});

describe('LoopEngine EventBus deep', () => {
  it('publishes model_called event with usage and tool_calls', async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe((event) => { events.push(event); });
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'decided',
        usage: { input_tokens: 3, output_tokens: 2 },
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      } as ModelTurn)),
      eventBus: bus,
    });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    const modelCalled = events.find((e: any) => e.type === 'model_called');
    expect(modelCalled).toBeTruthy();
    expect((modelCalled as any).data.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
    expect((modelCalled as any).data.tool_calls).toEqual(['read_file']);
  });

  it('publishes run_state_change on termination', async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe((event) => { events.push(event); });
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn)),
      eventBus: bus,
    });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    const stateChange = events.filter((e: any) => e.type === 'run_state_change');
    expect(stateChange.length).toBeGreaterThanOrEqual(1);
    const terminal = stateChange.find((e: any) => e.data.termination_reason === 'completed');
    expect(terminal).toBeTruthy();
  });

  it('publishes tool_call_start and tool_result events', async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe((event) => { events.push(event); });
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({
        content: '',
        decision_summary: 'call tool',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }],
      } as ModelTurn)),
      eventBus: bus,
    });
    const loop = new LoopEngine(baseConfig({ strategy: 'react', max_iterations: 5 }), deps);
    await loop.run();
    const toolStart = events.find((e: any) => e.type === 'tool_call_start');
    const toolResult = events.find((e: any) => e.type === 'tool_result');
    expect(toolStart).toBeTruthy();
    expect(toolResult).toBeTruthy();
  });

  it('publishes step_transition events in plan_execute', async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe((event) => { events.push(event); });
    const planExecutePlan = {
      tool_grants: [{ tool: 'read_file', granted: true }],
      workflow_graph: {
        nodes: [
          { step_id: 'model', step_type: 'model_call', status: 'pending' },
          { step_id: 'tool', step_type: 'tool_call', status: 'pending', tool_name: 'read_file' },
          { step_id: 'verify', step_type: 'verification', status: 'pending' },
        ],
        edges: [
          { from_step: 'model', to_step: 'tool' },
          { from_step: 'tool', to_step: 'verify' },
        ],
      },
    } as any;
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({
        content: '',
        decision_summary: 'read',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/x' } }],
      } as ModelTurn)),
      toolExecute: async () => 'content',
      eventBus: bus,
    });
    const loop = new LoopEngine(
      baseConfig({ strategy: 'plan_execute' as const, max_iterations: 5, run_plan: planExecutePlan }),
      deps,
    );
    await loop.run();
    const stepTransitions = events.filter((e: any) => e.type === 'step_transition');
    expect(stepTransitions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('LoopEngine plan mode (auto_execute=false) deep', () => {
  it('terminates with approval_required when auto_execute is false', async () => {
    const modelCall = vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn));
    const loop = new LoopEngine(
      baseConfig({ auto_execute: false }),
      baseDeps({ modelCall }),
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('approval_required');
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('proceeds normally when auto_execute is true (default)', async () => {
    const modelCall = vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn));
    const loop = new LoopEngine(
      baseConfig({ auto_execute: true }),
      baseDeps({ modelCall }),
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
    expect(modelCall).toHaveBeenCalled();
  });
});

describe('LoopEngine RAG injection deep', () => {
  it('injects RAG evidence as untrusted user message', async () => {
    const observedMessages: any[][] = [];
    const deps = baseDeps({
      modelCall: vi.fn(async (messages) => {
        observedMessages.push(messages);
        return { content: 'done', decision_summary: 's' } as ModelTurn;
      }),
      ragQuery: vi.fn(async () => [
        {
          chunk: { text: 'evidence content' },
          citation: { source_path: '/doc.md', content_hash: 'abc123' },
        },
      ]),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    // The RAG evidence should appear as a user message with UNTRUSTED marker
    const ragMessage = observedMessages[0]?.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('UNTRUSTED'),
    );
    expect(ragMessage).toBeTruthy();
    expect(ragMessage).toMatchObject({ role: 'user' });
  });

  it('does not inject RAG when query returns empty results', async () => {
    const observedMessages: any[][] = [];
    const deps = baseDeps({
      modelCall: vi.fn(async (messages) => {
        observedMessages.push(messages);
        return { content: 'done', decision_summary: 's' } as ModelTurn;
      }),
      ragQuery: vi.fn(async () => []),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    // Only the goal message should be present, no UNTRUSTED evidence
    const hasRagMessage = observedMessages[0]?.some(
      (m: any) => typeof m.content === 'string' && m.content.includes('UNTRUSTED'),
    );
    expect(hasRagMessage).toBe(false);
  });

  it('continues normally when RAG query throws', async () => {
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn)),
      ragQuery: vi.fn(async () => { throw new Error('rag unavailable'); }),
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
  });
});

describe('LoopEngine steering deep', () => {
  it('kill steering command terminates with user_cancel', async () => {
    const commands: RuntimeSteeringCommand[] = [
      { command_id: 'kill-1', priority: 'kill', queue: 'steer', content: 'stop now' },
    ];
    const steering: RuntimeSteeringPort = {
      subscribe: vi.fn((handler) => {
        for (const cmd of commands) handler(cmd);
        return () => {};
      }),
      drain: vi.fn((queue) => {
        if (queue === 'next_turn') return commands;
        return [];
      }),
    };
    const modelCall = vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn));
    const loop = new LoopEngine(baseConfig(), baseDeps({ modelCall, steering }));
    const result = await loop.run();
    expect(result.termination_reason).toBe('user_cancel');
  });

  it('human_cancel steering command terminates with user_cancel', async () => {
    const commands: RuntimeSteeringCommand[] = [
      { command_id: 'hc-1', priority: 'human_cancel', queue: 'steer', content: 'cancel' },
    ];
    const steering: RuntimeSteeringPort = {
      subscribe: vi.fn((handler) => {
        for (const cmd of commands) handler(cmd);
        return () => {};
      }),
      drain: vi.fn((queue) => {
        if (queue === 'next_turn') return commands;
        return [];
      }),
    };
    const modelCall = vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn));
    const loop = new LoopEngine(baseConfig(), baseDeps({ modelCall, steering }));
    const result = await loop.run();
    expect(result.termination_reason).toBe('user_cancel');
  });

  it('steer command injects content into messages', async () => {
    const steerCmd: RuntimeSteeringCommand = {
      command_id: 'steer-1',
      priority: 'user',
      queue: 'steer',
      content: 'focus on X',
    };
    const steering: RuntimeSteeringPort = {
      subscribe: vi.fn(() => () => {}),
      drain: vi.fn((queue) => {
        if (queue === 'next_turn') return [steerCmd];
        return [];
      }),
    };
    const observedMessages: any[][] = [];
    const deps = baseDeps({
      modelCall: vi.fn(async (messages) => {
        observedMessages.push(messages);
        return { content: 'done', decision_summary: 's' } as ModelTurn;
      }),
      steering,
    });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    const steerMessage = observedMessages[0]?.find(
      (m: any) => m.metadata?.source === 'steering',
    );
    expect(steerMessage).toBeTruthy();
    expect(steerMessage).toMatchObject({ role: 'user', content: 'focus on X' });
  });
});

describe('LoopEngine stop and lifecycle deep', () => {
  it('stop before run terminates immediately', async () => {
    const modelCall = vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn));
    const loop = new LoopEngine(baseConfig(), baseDeps({ modelCall }));
    loop.stop('user_cancel');
    const result = await loop.run();
    expect(result.termination_reason).toBe('user_cancel');
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('stop after finish is a no-op', async () => {
    const modelCall = vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn));
    const loop = new LoopEngine(baseConfig(), baseDeps({ modelCall }));
    await loop.run();
    loop.stop('user_cancel');
    // Should not throw, lifecycle is finished
  });

  it('double run throws', async () => {
    const loop = new LoopEngine(baseConfig(), baseDeps());
    await loop.run();
    await expect(loop.run()).rejects.toThrow('exactly once');
  });
});

describe('LoopEngine unknown strategy deep', () => {
  it('terminates with malformed_response on unknown strategy', async () => {
    const loop = new LoopEngine(
      baseConfig({ strategy: 'unknown' as any }),
      baseDeps(),
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('malformed_response');
  });
});

describe('LoopEngine signal abort deep', () => {
  it('terminates with user_cancel when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const modelCall = vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn));
    const loop = new LoopEngine(
      baseConfig(),
      baseDeps({ modelCall, signal: controller.signal }),
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('user_cancel');
    expect(modelCall).not.toHaveBeenCalled();
  });
});

describe('LoopEngine turn hooks deep', () => {
  it('calls beforeTurn and afterTurn hooks', async () => {
    const beforeCalls: number[] = [];
    const afterCalls: number[] = [];
    const deps = baseDeps({
      modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn)),
      turnHooks: {
        beforeTurn: vi.fn(async ({ iteration }) => { beforeCalls.push(iteration); }),
        afterTurn: vi.fn(async ({ iteration }) => { afterCalls.push(iteration); }),
      },
    });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    expect(beforeCalls).toEqual([1]);
    expect(afterCalls).toEqual([1]);
  });

  it('afterTurn hook failure is logged but does not override existing termination', async () => {
    // When model succeeds, terminate('completed') is called before finally.
    // The afterTurn failure in finally checks !terminatedValue (already true),
    // so termination stays 'completed' and the error is logged to session.
    const sess = makeSession('afterturn-fail');
    const deps = baseDeps({
      session: sess,
      modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 's' } as ModelTurn)),
      turnHooks: {
        beforeTurn: vi.fn(async () => {}),
        afterTurn: vi.fn(async () => { throw new Error('hook crash'); }),
      },
    });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
    expect(sess.append).toHaveBeenCalledWith('error', expect.objectContaining({ event: 'post_turn_hook_failed' }));
  });
});
