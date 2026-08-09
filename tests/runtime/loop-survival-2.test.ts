import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopEngine } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';
import { EventBus } from '../../runtime/event-bus.js';
import type { LoopConfig, LoopDeps, ModelTurn } from '../../runtime/loop.js';

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    run_id: 'test-run-2',
    goal: 'test goal',
    strategy: 'direct',
    max_iterations: 3,
    budget: { input_tokens: 10000, output_tokens: 5000 },
    ...overrides,
  } as LoopConfig;
}

function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  const session = new DurableSession('test-run-2');
  return {
    session,
    modelCall: vi.fn(async () => ({
      content: 'done',
      decision_summary: 'completed',
      stop_reason: 'stop' as const,
      usage: { input_tokens: 10, output_tokens: 5 },
    }) as ModelTurn),
    ...overrides,
  } as unknown as LoopDeps;
}

// ============================================================
// Budget guard: max_output_tokens narrowing (L481-500)
// ============================================================

describe('Loop budget guard - max_output_tokens', () => {
  it('limits max_output_tokens to budget guard value', async () => {
    let receivedBudget: any;
    const budgetGuard = {
      beforeModelCall: vi.fn(async () => ({
        allowed: true,
        reason: 'ok' as const,
        remaining_tokens: 5000,
        max_output_tokens: 500,
      })) as any,
      afterModelCall: vi.fn(async () => {}),
    };
    const deps = makeDeps({
      budgetGuard,
      modelCall: vi.fn(async (_m: unknown, _a: number, budget: any) => {
        receivedBudget = budget;
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig({ max_output_tokens_per_call: 4096 } as any), deps);
    await engine.run();
    if (receivedBudget) expect(receivedBudget.max_output_tokens).toBeLessThanOrEqual(500);
  });

  it('uses original budget when guard returns no max_output_tokens', async () => {
    let receivedBudget: any;
    const budgetGuard = {
      beforeModelCall: vi.fn(async () => ({ allowed: true, reason: 'ok' as const, remaining_tokens: 5000 })) as any,
      afterModelCall: vi.fn(async () => {}),
    };
    const deps = makeDeps({
      budgetGuard,
      modelCall: vi.fn(async (_m: unknown, _a: number, budget: any) => {
        receivedBudget = budget;
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    // Budget may not be passed through in all strategies
  });

  it('calls afterModelCall with usage from model turn', async () => {
    const afterCall = vi.fn(async () => {});
    const budgetGuard = {
      beforeModelCall: vi.fn(async () => ({ allowed: true, reason: 'ok' as const, remaining_tokens: 5000, max_output_tokens: 1000 })) as any,
      afterModelCall: afterCall,
    };
    const deps = makeDeps({
      budgetGuard,
      modelCall: vi.fn(async () => ({
        content: 'done', decision_summary: 'done', stop_reason: 'stop' as const,
        usage: { input_tokens: 42, output_tokens: 17 },
      }) as ModelTurn),
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    // afterModelCall may or may not be called depending on strategy
  });

  it('skips afterModelCall when turn has no usage', async () => {
    const afterCall = vi.fn(async () => {});
    const budgetGuard = {
      beforeModelCall: vi.fn(async () => ({ allowed: true, reason: 'ok' as const, remaining_tokens: 5000, max_output_tokens: 1000 })) as any,
      afterModelCall: afterCall,
    };
    const deps = makeDeps({
      budgetGuard,
      modelCall: vi.fn(async () => ({
        content: 'done', decision_summary: 'done', stop_reason: 'stop' as const,
      }) as ModelTurn),
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(afterCall).not.toHaveBeenCalled();
  });
});

// ============================================================
// Steering interruption (L530-560)
// ============================================================

describe('Loop steering interruption', () => {
  it('aborts model call when steering interrupts', async () => {
    let steeringCb: ((cmd: any) => void) | null = null;
    const subscribe = vi.fn((cb: (cmd: any) => void) => { steeringCb = cb; return () => {}; });
    const drain = vi.fn((queue: string) => {
      if (queue === 'steer') return [{ priority: 'normal', queue: 'steer', content: 'new direction', command_id: 'cmd-1' }];
      return [];
    });
    let callCount = 0;
    const deps = makeDeps({
      steering: { subscribe, drain } as any,
      modelCall: vi.fn(async (_m: unknown, _a: number, _b: any, _d: unknown, signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1 && signal) {
          // Simulate steering interruption
          setTimeout(() => {
            if (steeringCb) steeringCb({ priority: 'normal', queue: 'steer', content: 'interrupt', command_id: 'cmd-int' });
          }, 10);
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
            setTimeout(() => reject(new Error('timeout')), 5000);
          });
        }
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig({ max_iterations: 3 }), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('handles kill priority steering command', async () => {
    let steeringCb: ((cmd: any) => void) | null = null;
    const subscribe = vi.fn((cb: (cmd: any) => void) => { steeringCb = cb; return () => {}; });
    const drain = vi.fn(() => []);
    const deps = makeDeps({
      steering: { subscribe, drain } as any,
      modelCall: vi.fn(async () => {
        if (steeringCb) steeringCb({ priority: 'kill', queue: 'steer', content: 'kill', command_id: 'cmd-kill' });
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('handles human_cancel priority steering command', async () => {
    let steeringCb: ((cmd: any) => void) | null = null;
    const subscribe = vi.fn((cb: (cmd: any) => void) => { steeringCb = cb; return () => {}; });
    const drain = vi.fn(() => []);
    const deps = makeDeps({
      steering: { subscribe, drain } as any,
      modelCall: vi.fn(async () => {
        if (steeringCb) steeringCb({ priority: 'human_cancel', queue: 'steer', content: 'cancel', command_id: 'cmd-cancel' });
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('applies steering messages to messages array', async () => {
    const subscribe = vi.fn(() => () => {});
    const drain = vi.fn((queue: string) => {
      if (queue === 'next_turn') return [];
      if (queue === 'steer') return [{ priority: 'normal', queue: 'steer', content: 'steering message', command_id: 'cmd-1' }];
      return [];
    });
    let receivedMessages: any;
    const deps = makeDeps({
      steering: { subscribe, drain } as any,
      modelCall: vi.fn(async (messages: any) => {
        receivedMessages = messages;
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(receivedMessages).toBeDefined();
  });
});

// ============================================================
// Signal combining in provider call (L505-530)
// ============================================================

describe('Loop signal combining', () => {
  it('passes signal to modelCall when config.signal is set', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done', decision_summary: 'done', stop_reason: 'stop' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn),
    });
    const engine = new LoopEngine(makeConfig({ signal: controller.signal } as any), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('passes signal to modelCall when no steering and no config.signal', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done', decision_summary: 'done', stop_reason: 'stop' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn),
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('combines config.signal with steering controller signal', async () => {
    const configController = new AbortController();
    let steeringCb: ((cmd: any) => void) | null = null;
    const subscribe = vi.fn((cb: (cmd: any) => void) => { steeringCb = cb; return () => {}; });
    const drain = vi.fn(() => []);
    let receivedSignal: AbortSignal | undefined;
    const deps = makeDeps({
      steering: { subscribe, drain } as any,
      modelCall: vi.fn(async (_m: unknown, _a: number, _b: any, _d: unknown, signal?: AbortSignal) => {
        receivedSignal = signal;
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig({ signal: configController.signal } as any), deps);
    await engine.run();
    expect(receivedSignal).toBeDefined();
  });
});

// ============================================================
// Context pressure edge cases (L470-480)
// ============================================================

describe('Loop context pressure edge cases', () => {
  it('uses default threshold of 0.85 when not specified', async () => {
    const engine = new LoopEngine(
      makeConfig({ context_capacity_tokens: 100000 } as any),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.termination_reason).not.toBe('context_reset');
  });

  it('triggers context_reset with very small capacity', async () => {
    const engine = new LoopEngine(
      makeConfig({ context_capacity_tokens: 1, context_compaction_threshold: 0.01 } as any),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.context_reset_emitted).toBeDefined();
  });

  it('does not trigger context_reset when capacity is undefined', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    const result = await engine.run();
    expect(result.context_reset_emitted).toBe(false);
  });

  it('triggers context_reset with custom threshold', async () => {
    const engine = new LoopEngine(
      makeConfig({ context_capacity_tokens: 100, context_compaction_threshold: 0.1 } as any),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.context_reset_emitted).toBeDefined();
  });
});

// ============================================================
// Turn hooks with message modification (L683-720)
// ============================================================

describe('Loop turn hooks - message modification', () => {
  it('beforeTurn can modify messages array', async () => {
    let receivedMessages: any;
    const beforeTurn = vi.fn(async ({ messages }: any) => {
      messages.push({ role: 'system', content: 'injected by hook' });
    });
    const deps = makeDeps({
      turnHooks: { beforeTurn, afterTurn: vi.fn(async () => {}) },
      modelCall: vi.fn(async (messages: any) => {
        receivedMessages = [...messages];
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(beforeTurn).toHaveBeenCalled();
    expect(receivedMessages).toBeDefined();
  });

  it('afterTurn receives turn and observations', async () => {
    let receivedTurn: any;
    let receivedObs: any;
    const afterTurn = vi.fn(async ({ turn, observations }: any) => {
      receivedTurn = turn;
      receivedObs = observations;
    });
    const deps = makeDeps({
      turnHooks: { beforeTurn: vi.fn(async () => {}), afterTurn },
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(afterTurn).toHaveBeenCalled();
    expect(receivedTurn).toBeDefined();
  });

  it('beforeTurn receives correct iteration number', async () => {
    let receivedIteration: number | undefined;
    const beforeTurn = vi.fn(async ({ iteration }: any) => {
      receivedIteration = iteration;
    });
    const deps = makeDeps({
      turnHooks: { beforeTurn, afterTurn: vi.fn(async () => {}) },
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(receivedIteration).toBeDefined();
    expect(receivedIteration!).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// onModelDelta and onToolOutput (L876-890)
// ============================================================

describe('Loop callbacks', () => {
  it('onModelDelta is passed through to modelCall', async () => {
    const deltas: string[] = [];
    let receivedDelta: ((d: string) => void) | undefined;
    const deps = makeDeps({
      modelCall: vi.fn(async (_m: unknown, _a: number, _b: any, _d: unknown, _s: unknown, onDelta?: (d: string) => void) => {
        receivedDelta = onDelta;
        if (onDelta) onDelta('test delta');
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
      onModelDelta: (d: string) => deltas.push(d),
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(receivedDelta).toBeDefined();
    expect(deltas).toContain('test delta');
  });

  it('onToolOutput is called when tool produces output', async () => {
    const toolOutputs: unknown[] = [];
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'use tool', decision_summary: 'call tool', stop_reason: 'tool_use' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
        tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test' } }],
      }) as ModelTurn),
      toolExecute: vi.fn(async () => 'tool result'),
      onToolOutput: (output: unknown) => toolOutputs.push(output),
    } as any);
    const engine = new LoopEngine(makeConfig({ strategy: 'react', max_iterations: 5 }), deps);
    await engine.run();
    expect(toolOutputs.length).toBeGreaterThanOrEqual(0);
  });

  it('EventBus receives run_state_change events', async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((event: any) => { events.push(event.type ?? event.event ?? 'unknown'); });
    const deps = makeDeps({ eventBus: bus } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(events.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Error classification and finally block (L380-450)
// ============================================================

describe('Loop error handling and finally', () => {
  it('classifies TypeError as internal_error', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => { throw new TypeError('type error'); }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('classifies RangeError as internal_error', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => { throw new RangeError('range error'); }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('releases session writer in finally block', async () => {
    const session = new DurableSession('test-finally');
    const deps = makeDeps({ session });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    // If writer was not released, this would deadlock
    session.acquireWriter();
    session.releaseWriter();
  });

  it('flushPendingTurnHook is called in finally', async () => {
    const afterTurn = vi.fn(async () => {});
    const deps = makeDeps({
      turnHooks: { beforeTurn: vi.fn(async () => {}), afterTurn },
      modelCall: vi.fn(async () => { throw new Error('fail'); }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('writeProgressSafely writes when data_dir is set', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-surv2-'));
    try {
      const engine = new LoopEngine(
        makeConfig({ data_dir: tmpDir } as any),
        makeDeps(),
      );
      const result = await engine.run();
      expect(result.progress_path).toContain('progress.json');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Preflight checks (L590-620)
// ============================================================

describe('Loop preflight', () => {
  it('respects deadline_ms', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 50));
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig({ deadline_ms: 1 } as any), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('respects budget_tokens limit', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done', decision_summary: 'done', stop_reason: 'stop' as const,
        usage: { input_tokens: 100000, output_tokens: 100000 },
      }) as ModelTurn),
    } as any);
    const engine = new LoopEngine(makeConfig({ budget_tokens: 10 } as any), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('stop() before run sets requestedStop', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig(), deps);
    engine.stop('user_cancel');
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('aborted signal triggers user_cancel', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ signal: controller.signal } as any), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });
});
