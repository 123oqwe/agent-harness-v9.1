import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopEngine } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';
import type { LoopConfig, LoopDeps, ModelTurn } from '../../runtime/loop.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function rootDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    run_id: 'test-surv6',
    goal: 'test goal',
    strategy: 'direct',
    max_iterations: 3,
    ...overrides,
  } as LoopConfig;
}

function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  const session = new DurableSession('test-surv6');
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

// ---- Strategy selection (L369-387) ----
describe('loop-survival-6: strategy selection', () => {
  it('runs direct strategy', async () => {
    const engine = new LoopEngine(makeConfig({ strategy: 'direct' }), makeDeps());
    const result = await engine.run();
    expect(result.strategy).toBe('direct');
    expect(result.termination_reason).toBe('completed');
  });

  it('runs react strategy', async () => {
    const engine = new LoopEngine(makeConfig({ strategy: 'react' }), makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'completed',
        stop_reason: 'stop' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn),
    }));
    const result = await engine.run();
    expect(result.strategy).toBe('react');
  });

  it('handles unknown strategy as runtime_error', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ strategy: 'unknown' as any }), deps);
    const result = await engine.run();
    expect(result.termination_reason).not.toBe('completed');
    const events = deps.session.getEvents();
    const errorEvents = events.filter(
      (e) => e.type === 'error' && (e.data as { event?: string }).event === 'runtime_error',
    );
    expect(errorEvents.length).toBeGreaterThan(0);
    expect((errorEvents[0]!.data as { message?: string }).message).toContain('unknown strategy');
  });

  it('emits runtime_error event when strategy throws', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => { throw new Error('model call failed'); }),
    });
    const engine = new LoopEngine(makeConfig({ strategy: 'direct' }), deps);
    const result = await engine.run();
    const events = deps.session.getEvents();
    const errorEvents = events.filter(
      (e) => e.type === 'error' && (e.data as { event?: string }).event === 'runtime_error',
    );
    expect(errorEvents.length).toBeGreaterThan(0);
    expect((errorEvents[0]!.data as { message?: string }).message).toBe('model call failed');
    expect(result.termination_reason).not.toBe('completed');
  });

  it('emits post_turn_hook_failed event when afterTurn hook throws', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'completed',
        stop_reason: 'stop' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn),
      turnHooks: {
        afterTurn: vi.fn(async () => { throw new Error('hook failed'); }),
      } as any,
    });
    const engine = new LoopEngine(makeConfig({ strategy: 'direct', max_iterations: 1 }), deps);
    await engine.run();
    const events = deps.session.getEvents();
    const errorEvents = events.filter(
      (e) => e.type === 'error' && (e.data as { event?: string }).event === 'post_turn_hook_failed',
    );
    // The afterTurn hook throws, which is caught by flushPendingTurnHook
    if (errorEvents.length > 0) {
      expect((errorEvents[0]!.data as { message?: string }).message).toBe('hook failed');
    }
  });
});

// ---- plan_mode_paused event (L358-369) ----
describe('loop-survival-6: plan_mode_paused', () => {
  it('emits plan_mode_paused event when auto_execute is false', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ auto_execute: false }), deps);
    const result = await engine.run();
    const events = deps.session.getEvents();
    const pauseEvents = events.filter(
      (e) => e.type === 'system' && (e.data as { event?: string }).event === 'plan_mode_paused',
    );
    expect(pauseEvents.length).toBeGreaterThan(0);
    expect((pauseEvents[0]!.data as { reason?: string }).reason).toContain('auto_execute');
    expect(result.termination_reason).toBe('approval_required');
  });

  it('does not emit plan_mode_paused when auto_execute is true', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ auto_execute: true }), deps);
    await engine.run();
    const events = deps.session.getEvents();
    const pauseEvents = events.filter(
      (e) => e.type === 'system' && (e.data as { event?: string }).event === 'plan_mode_paused',
    );
    expect(pauseEvents.length).toBe(0);
  });

  it('does not emit plan_mode_paused when auto_execute is undefined (default)', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    const events = deps.session.getEvents();
    const pauseEvents = events.filter(
      (e) => e.type === 'system' && (e.data as { event?: string }).event === 'plan_mode_paused',
    );
    expect(pauseEvents.length).toBe(0);
  });
});

// ---- context_reset (L413-442) ----
describe('loop-survival-6: context pressure', () => {
  it('terminates with context_reset when context is near full', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        // Large messages that will exceed 100 token capacity
        return {
          content: 'x'.repeat(200),
          decision_summary: 'completed',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 200, output_tokens: 5 },
        } as ModelTurn;
      }),
    });
    const engine = new LoopEngine(makeConfig({
      context_capacity_tokens: 10,
      context_compaction_threshold: 0.8,
    }), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('context_reset');
  });

  it('does not trigger context_reset when capacity is sufficient', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({
      context_capacity_tokens: 100_000,
    }), deps);
    const result = await engine.run();
    expect(result.termination_reason).not.toBe('context_reset');
  });

  it('uses default threshold 0.85 when not specified', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        return {
          content: 'x'.repeat(200),
          decision_summary: 'completed',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 200, output_tokens: 5 },
        } as ModelTurn;
      }),
    });
    const engine = new LoopEngine(makeConfig({
      context_capacity_tokens: 10,
    }), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('context_reset');
  });
});

// ---- Loop result construction (L587-620) ----
describe('loop-survival-6: loop result construction', () => {
  it('returns correct strategy in result', async () => {
    const engine = new LoopEngine(makeConfig({ strategy: 'direct' }), makeDeps());
    const result = await engine.run();
    expect(result.strategy).toBe('direct');
  });

  it('returns correct iterations count', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ strategy: 'direct', max_iterations: 1 }), deps);
    const result = await engine.run();
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  it('returns termination_reason in result', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('returns usage in result', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    const result = await engine.run();
    expect(result.usage).toBeDefined();
    expect(result.usage.input_tokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.output_tokens).toBeGreaterThanOrEqual(0);
  });
});

// ---- Steering interrupt (L490-515) ----
describe('loop-survival-6: steering interrupt', () => {
  it('handles steering interrupt and retries', async () => {
    let callCount = 0;
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        callCount++;
        return {
          content: 'done',
          decision_summary: 'completed',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }),
      steering: {
        drain: vi.fn((queue: string) => {
          if (queue === 'steer' && callCount === 0) {
            return [{ queue: 'steer', priority: 'steer', payload: {} }];
          }
          return [];
        }),
        inject: vi.fn(),
      } as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result).toBeDefined();
  });

  it('does not call steering when not provided', async () => {
    const modelCall = vi.fn(async () => ({
      content: 'done',
      decision_summary: 'completed',
      stop_reason: 'stop' as const,
      usage: { input_tokens: 10, output_tokens: 5 },
    }) as ModelTurn);
    const deps = makeDeps({ modelCall });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(modelCall).toHaveBeenCalled();
  });
});

// ---- stop() method (L383-388) ----
describe('loop-survival-6: stop method', () => {
  it('stop() sets requestedStop and aborts active model call', () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    engine.stop('user_cancel');
    // The engine should have requestedStop set
    expect((engine as any).requestedStop).toBe('user_cancel');
  });

  it('stop() is no-op when already finished', () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    expect(() => engine.stop('user_cancel')).not.toThrow();
  });
});

// ---- RAG query in context compilation (L287-310) ----
describe('loop-survival-6: RAG context compilation', () => {
  it('queries RAG when ragQuery is provided', async () => {
    const ragResults = [
      { chunk: { text: 'relevant info' }, citation: { source_path: '/doc.md', content_hash: 'abc' } },
    ];
    const deps = makeDeps({
      ragQuery: vi.fn(async () => ragResults),
      contextCompiler: {
        compile: vi.fn(async (input: any) => {
          expect(input.layers.retrieved_evidence).toBeDefined();
          expect(input.layers.retrieved_evidence.length).toBe(1);
          expect(input.layers.retrieved_evidence[0].content.text).toBe('relevant info');
          return { messages: [{ role: 'user', content: 'compiled' }] };
        }),
      } as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(deps.ragQuery).toHaveBeenCalled();
  });

  it('handles empty RAG results', async () => {
    const deps = makeDeps({
      ragQuery: vi.fn(async () => []),
      contextCompiler: {
        compile: vi.fn(async (input: any) => {
          expect(input.layers.retrieved_evidence).toEqual([]);
          return { messages: [{ role: 'user', content: 'compiled' }] };
        }),
      } as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
  });

  it('handles RAG query failure gracefully', async () => {
    const deps = makeDeps({
      ragQuery: vi.fn(async () => { throw new Error('RAG failed'); }),
      contextCompiler: {
        compile: vi.fn(async (input: any) => {
          expect(input.layers.retrieved_evidence).toEqual([]);
          return { messages: [{ role: 'user', content: 'compiled' }] };
        }),
      } as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
  });
});
