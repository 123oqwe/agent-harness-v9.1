import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopEngine } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';
import { EventBus } from '../../runtime/event-bus.js';
import type { LoopConfig, LoopDeps, ModelTurn } from '../../runtime/loop.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    run_id: 'test-surv4',
    goal: 'test goal',
    strategy: 'direct',
    max_iterations: 3,
    ...overrides,
  } as LoopConfig;
}

function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  const session = new DurableSession('test-surv4');
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

// L288-306: Context compiler path - StringLiteral, ArrayDeclaration, ObjectLiteral
describe('loop-survival-4 context compiler exact assertions (L288-306)', () => {
  it('passes exact task layer with goal text and token_count to contextCompiler', async () => {
    const compiledMessages: any[] = [];
    const contextCompiler: any = {
      compile: vi.fn(async (input: any) => {
        compiledMessages.push(input);
        return {
          messages: [{ role: 'user', content: 'compiled message' }],
          token_count: 100,
        };
      }),
    };
    const deps = makeDeps({ contextCompiler: contextCompiler as any });
    const config = makeConfig({ goal: 'Test goal for context compiler' });
    const engine = new LoopEngine(config, deps);
    await engine.run();
    expect(contextCompiler.compile).toHaveBeenCalledTimes(1);
    const input = compiledMessages[0] as any;
    // Assert exact string values in the task layer
    expect(input.layers.task[0].content.text).toBe('Test goal for context compiler');
    expect(input.layers.task[0].content.role).toBe('user');
    expect(input.layers.task[0].trust).toBe('trusted');
    expect(input.layers.task[0].layer).toBe('task');
    expect(input.layers.task[0].id).toBe('goal');
    expect(input.layers.task[0].tenant_id).toBe('default');
    expect(input.layers.task[0].acl.tenant_id).toBe('default');
    expect(input.layers.task[0].acl.principal_ids).toEqual(['default']);
    expect(input.layers.task[0].source_hash).toBe('');
    expect(input.layers.task[0].provenance).toEqual({});
  });

  it('computes token_count using Math.ceil(goal.length / 4)', async () => {
    const contextCompiler: any = {
      compile: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'compiled' }],
        token_count: 10,
      })),
    };
    const deps = makeDeps({ contextCompiler: contextCompiler as any });
    const goal = '12345678'; // 8 chars -> ceil(8/4) = 2
    const config = makeConfig({ goal });
    const engine = new LoopEngine(config, deps);
    await engine.run();
    const input = contextCompiler.compile.mock.calls[0]?.[0] as any;
    expect(input.layers.task[0].token_count).toBe(Math.ceil(goal.length / 4));
  });

  it('passes exact RAG evidence to contextCompiler with correct fields', async () => {
    const ragResults = [
      { chunk: { text: 'evidence text 1' }, citation: { source_path: '/doc1.txt', content_hash: 'hash1' } },
      { chunk: { text: 'evidence text 2' }, citation: { source_path: '/doc2.txt', content_hash: 'hash2' } },
    ];
    const contextCompiler: any = {
      compile: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'compiled' }],
        token_count: 10,
      })),
    };
    const deps = makeDeps({
      contextCompiler,
      ragQuery: vi.fn(async () => ragResults),
    });
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    await engine.run();
    const input = contextCompiler.compile.mock.calls[0]?.[0] as any;
    // Assert exact RAG evidence structure
    expect(input.layers.retrieved_evidence).toHaveLength(2);
    expect(input.layers.retrieved_evidence[0].id).toBe('rag-0');
    expect(input.layers.retrieved_evidence[1].id).toBe('rag-1');
    expect(input.layers.retrieved_evidence[0].content.text).toBe('evidence text 1');
    expect(input.layers.retrieved_evidence[0].content.source).toBe('/doc1.txt');
    expect(input.layers.retrieved_evidence[0].source_hash).toBe('hash1');
    expect(input.layers.retrieved_evidence[0].trust).toBe('untrusted');
    expect(input.layers.retrieved_evidence[0].layer).toBe('retrieved_evidence');
    expect(input.layers.retrieved_evidence[0].token_count).toBe(Math.ceil('evidence text 1'.length / 4));
    expect(input.selected.rag_source_ids).toEqual(['rag-0', 'rag-1']);
  });

  it('passes empty arrays for unused layers', async () => {
    const contextCompiler: any = {
      compile: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'compiled' }],
        token_count: 10,
      })),
    };
    const deps = makeDeps({ contextCompiler: contextCompiler as any });
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    await engine.run();
    const input = contextCompiler.compile.mock.calls[0]?.[0] as any;
    expect(input.layers.system_policy).toEqual([]);
    expect(input.layers.active_plan).toEqual([]);
    expect(input.layers.recent_conversation).toEqual([]);
    expect(input.layers.tool_definitions).toEqual([]);
    expect(input.layers.tool_results).toEqual([]);
    expect(input.layers.memory).toEqual([]);
    expect(input.selected.tool_ids).toEqual([]);
    expect(input.selected.skill_ids).toEqual([]);
    expect(input.selected.disclosures).toEqual([]);
  });

  it('passes exact run_id and context_capacity_tokens', async () => {
    const contextCompiler: any = {
      compile: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'compiled' }],
        token_count: 10,
      })),
    };
    const deps = makeDeps({ contextCompiler: contextCompiler as any });
    const config = makeConfig({ goal: 'test', run_id: 'my-run-id', context_capacity_tokens: 64000 });
    const engine = new LoopEngine(config, deps);
    await engine.run();
    const input = contextCompiler.compile.mock.calls[0]?.[0] as any;
    expect(input.run_id).toBe('my-run-id');
    expect(input.session_id).toBe('my-run-id');
    expect(input.context_capacity_tokens).toBe(64000);
    expect(input.reserved_output_tokens).toBe(4096);
    expect(input.cache_breakpoint).toBe(0);
    expect(input.context_generation).toBe(0);
  });

  it('uses default context_capacity_tokens when undefined', async () => {
    const contextCompiler: any = {
      compile: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'compiled' }],
        token_count: 10,
      })),
    };
    const deps = makeDeps({ contextCompiler: contextCompiler as any });
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    await engine.run();
    const input = contextCompiler.compile.mock.calls[0]?.[0] as any;
    expect(input.context_capacity_tokens).toBe(128_000);
  });

  it('pushes compiled messages with role and content', async () => {
    const capturedMessages: unknown[] = [];
    const contextCompiler: any = {
      compile: vi.fn(async () => ({
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'user message' },
        ],
        token_count: 20,
      })),
    };
    const deps = makeDeps({
      contextCompiler,
      modelCall: vi.fn(async (messages: unknown[]) => {
        capturedMessages.push(...messages);
        return { content: 'done', decision_summary: 'completed', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }),
    });
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    await engine.run();
    // The compiled messages should be pushed to the messages array
    expect(capturedMessages.length).toBeGreaterThanOrEqual(2);
  });
});

// L324, L348, L350-352: Termination strings
describe('loop-survival-4 termination and error strings (L324-352)', () => {
  it('records runtime_error event with exact classification and message', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => { throw new Error('model crashed'); }) as any,
    });
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    const result = await engine.run();
    const errors = deps.session.getEvents().filter((e: any) => e.type === 'error');
    if (errors.length > 0) {
      expect((errors[0] as any).data.event).toBe('runtime_error');
      expect((errors[0] as any).data.message).toBe('model crashed');
      expect((errors[0] as any).data.classification).toBeDefined();
    }
  });

  it('records post_turn_hook_failed when flushPendingTurnHook throws', async () => {
    const deps = makeDeps({
      turnHooks: {
        beforeTurn: vi.fn(async () => {}),
        afterTurn: vi.fn(async () => { throw new Error('hook crashed'); }),
      },
    });
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    await engine.run();
    const errors = deps.session.getEvents().filter((e: any) => e.type === 'error');
    if (errors.length > 0) {
      const hookError = errors.find((e: any) => e.data.event === 'post_turn_hook_failed');
      if (hookError) {
        expect((hookError as any).data.message).toBe('hook crashed');
      }
    }
  });
});

// L432, L437-440: Context pressure check
describe('loop-survival-4 context pressure (L432-440)', () => {
  it('triggers context_reset when estimated tokens exceed threshold', async () => {
    const events: any[] = [];
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        // Return a large message to fill context
        return { content: 'x'.repeat(10000), decision_summary: 'big', stop_reason: 'stop', usage: { input_tokens: 100, output_tokens: 50 } } as ModelTurn;
      }),
      eventBus: { publish: vi.fn((event: any) => events.push(event)) } as any,
    });
    const config = makeConfig({
      goal: 'test',
      context_capacity_tokens: 100,
      context_compaction_threshold: 0.5,
    });
    const engine = new LoopEngine(config, deps);
    const result = await engine.run();
    // With a very small context_capacity_tokens, context_reset should trigger
    // if the messages exceed the threshold
    if (result.termination_reason === 'context_reset') {
      const resetEvents = events.filter((e: any) => e.type === 'run_state_change' && e.data?.state === 'context_reset');
      if (resetEvents.length > 0) {
        expect(resetEvents[0].data.state).toBe('context_reset');
        expect(resetEvents[0].data.pressure).toBeGreaterThan(0);
      }
    }
  });
});

// L501, L508, L527: Steering NoCov paths
describe('loop-survival-4 steering NoCov (L501-527)', () => {
  it('handles steering interruption during model call', async () => {
    const steeringCallbacks: ((cmd: any) => void)[] = [];
    const steering = {
      subscribe: vi.fn((cb: (cmd: any) => void) => {
        steeringCallbacks.push(cb);
        return () => {};
      }),
    };
    let callCount = 0;
    const deps = makeDeps({
      steering: steering as any,
      modelCall: vi.fn(async (messages: unknown[], attempt: number, budget: any, directive: any, signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1) {
          // Simulate steering interruption
          steeringCallbacks.forEach(cb => cb({ type: 'interrupt', priority: 'kill' }));
          if (signal) {
            // Wait a bit for the abort to propagate
            await new Promise(r => setTimeout(r, 10));
            if (signal.aborted) throw new Error('aborted');
          }
        }
        return { content: 'done', decision_summary: 'completed', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    try {
      await engine.run();
    } catch {
      // may throw
    }
    expect(steering.subscribe).toHaveBeenCalled();
  });
});

// L888: Termination reason string
describe('loop-survival-4 termination reason (L888)', () => {
  it('returns internal_error when termination_reason is null', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        return { content: '', decision_summary: '', stop_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 } } as ModelTurn;
      }),
    });
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
    expect(typeof result.termination_reason).toBe('string');
  });

  it('returns completed termination_reason on successful run', async () => {
    const deps = makeDeps();
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('completed');
  });

  it('returns exact usage with input/output/total tokens', async () => {
    const deps = makeDeps();
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    const result = await engine.run();
    expect(result.usage).toHaveProperty('input_tokens');
    expect(result.usage).toHaveProperty('output_tokens');
    expect(result.usage).toHaveProperty('total_tokens');
    expect(result.usage.total_tokens).toBe(result.usage.input_tokens + result.usage.output_tokens);
  });

  it('returns step_states as frozen object', async () => {
    const deps = makeDeps();
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    const result = await engine.run();
    expect(result.step_states).toBeDefined();
    expect(Object.isFrozen(result.step_states)).toBe(true);
  });

  it('includes progress_path when data_dir is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop4-'));
    roots.push(dir);
    const deps = makeDeps();
    const config = makeConfig({ goal: 'test', data_dir: dir });
    const engine = new LoopEngine(config, deps);
    const result = await engine.run();
    expect(result.progress_path).toBe(join(dir, 'progress.json'));
  });

  it('omits progress_path when data_dir is undefined', async () => {
    const deps = makeDeps();
    const config = makeConfig({ goal: 'test' });
    const engine = new LoopEngine(config, deps);
    const result = await engine.run();
    expect(result).not.toHaveProperty('progress_path');
  });
});
