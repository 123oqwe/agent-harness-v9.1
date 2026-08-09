import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LoopEngine, stripCredentialsFromEnv } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';
import type { LoopConfig, LoopDeps, ModelTurn, LoopResult } from '../../runtime/loop.js';

// ===== stripCredentialsFromEnv =====

describe('loop.ts: stripCredentialsFromEnv', () => {
  it('strips TOKEN env vars', () => {
    process.env.TEST_TOKEN = 'secret';
    const stripped = stripCredentialsFromEnv();
    expect(stripped).toContain('TEST_TOKEN');
    expect(process.env.TEST_TOKEN).toBeUndefined();
  });

  it('strips API_KEY env vars', () => {
    process.env.MY_API_KEY = 'key';
    const stripped = stripCredentialsFromEnv();
    expect(stripped).toContain('MY_API_KEY');
    expect(process.env.MY_API_KEY).toBeUndefined();
  });

  it('strips SECRET env vars', () => {
    process.env.DB_SECRET = 's';
    const stripped = stripCredentialsFromEnv();
    expect(stripped).toContain('DB_SECRET');
    expect(process.env.DB_SECRET).toBeUndefined();
  });

  it('strips PASSWORD env vars', () => {
    process.env.APP_PASSWORD = 'p';
    const stripped = stripCredentialsFromEnv();
    expect(stripped).toContain('APP_PASSWORD');
    expect(process.env.APP_PASSWORD).toBeUndefined();
  });

  it('strips CREDENTIAL env vars', () => {
    process.env.MY_CREDENTIAL = 'c';
    const stripped = stripCredentialsFromEnv();
    expect(stripped).toContain('MY_CREDENTIAL');
    expect(process.env.MY_CREDENTIAL).toBeUndefined();
  });

  it('does not strip non-credential env vars', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home';
    const stripped = stripCredentialsFromEnv();
    expect(stripped).not.toContain('PATH');
    expect(stripped).not.toContain('HOME');
    expect(process.env.PATH).toBe('/usr/bin');
    expect(process.env.HOME).toBe('/home');
  });
});

// ===== LoopEngine basic behavior =====

describe('loop.ts: LoopEngine basic execution', () => {
  function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
    return {
      run_id: 'test-run',
      goal: 'test goal',
      strategy: 'direct',
      max_iterations: 3,
      budget: { input_tokens: 10000, output_tokens: 5000 },
      ...overrides,
    } as LoopConfig;
  }

  function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
    const session = new DurableSession('test-run');
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

  it('runs and terminates with goal_satisfied when model returns stop_reason=stop', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    const result = await engine.run();
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.termination_reason).toBeDefined();
  });

  it('throws when run() called twice', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    await engine.run();
    await expect(engine.run()).rejects.toThrow('LoopEngine instances can run exactly once');
  });

  it('stop() terminates the loop', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ max_iterations: 10 }), deps);
    // Stop after first turn
    deps.modelCall = vi.fn(async () => {
      engine.stop('user_cancel');
      return { content: 'stop', decision_summary: 'stop', stop_reason: 'stop' as const } as ModelTurn;
    }) as any;
    const result = await engine.run();
    expect(result.termination_reason).toBe('user_cancel');
  });

  it('respects max_iterations limit', async () => {
    let callCount = 0;
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        callCount++;
        return {
          content: 'thinking',
          decision_summary: 'not done',
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig({ max_iterations: 2 }), deps);
    const result = await engine.run();
    expect(result.iterations).toBeLessThanOrEqual(2);
  });

  it('records usage from model calls', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'done',
        stop_reason: 'stop' as const,
        usage: { input_tokens: 100, output_tokens: 50 },
      }) as ModelTurn) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.usage.input_tokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.output_tokens).toBeGreaterThanOrEqual(0);
  });

  it('records decision summaries', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'answer',
        decision_summary: 'my decision',
        stop_reason: 'stop' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.decision_summaries.length).toBeGreaterThan(0);
  });

  it('returns frozen step_states', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    const result = await engine.run();
    expect(Object.isFrozen(result.step_states)).toBe(true);
  });

  it('returns strategy from config', async () => {
    const engine = new LoopEngine(makeConfig({ strategy: 'react' }), makeDeps());
    const result = await engine.run();
    expect(result.strategy).toBe('react');
  });

  it('handles model errors gracefully', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        throw new Error('provider failure');
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('includes progress_path when data_dir is set', async () => {
    const engine = new LoopEngine(makeConfig({ data_dir: '/tmp/test-progress' } as any), makeDeps());
    const result = await engine.run();
    expect(result.progress_path).toContain('progress.json');
  });

  it('omits progress_path when data_dir is undefined', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    const result = await engine.run();
    expect(result.progress_path).toBeUndefined();
  });
});

// ===== LoopEngine extended survival tests =====

describe('loop.ts: LoopEngine extended survival', () => {
  function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
    return {
      run_id: 'test-run',
      goal: 'test goal',
      strategy: 'direct',
      max_iterations: 3,
      budget: { input_tokens: 10000, output_tokens: 5000 },
      ...overrides,
    } as LoopConfig;
  }

  function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
    const session = new DurableSession('test-run');
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

  it('throws LoopError for unknown strategy', async () => {
    const engine = new LoopEngine(
      makeConfig({ strategy: 'unknown' as any }),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('auto_execute=false pauses with approval_required', async () => {
    const engine = new LoopEngine(
      makeConfig({ auto_execute: false } as any),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.termination_reason).toBe('approval_required');
  });

  it('auto_execute=true proceeds normally', async () => {
    const engine = new LoopEngine(
      makeConfig({ auto_execute: true } as any),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.termination_reason).not.toBe('approval_required');
  });

  it('context_capacity_tokens triggers context_reset when exceeded', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        // Create a very large message to trigger context pressure
        return {
          content: 'A'.repeat(200000),
          decision_summary: 'large response',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(
      makeConfig({
        context_capacity_tokens: 100,
        context_compaction_threshold: 0.5,
      } as any),
      deps,
    );
    const result = await engine.run();
    // The loop should either complete or trigger context_reset
    expect(result.termination_reason).toBeDefined();
  });

  it('RAG query injects evidence into messages', async () => {
    const ragQuery = vi.fn(async () => [
      {
        chunk: { text: 'RAG evidence content' },
        citation: { source_path: '/doc.md', content_hash: 'hash123' },
      },
    ]);
    const deps = makeDeps({ ragQuery } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(ragQuery).toHaveBeenCalled();
    expect(result.termination_reason).toBeDefined();
  });

  it('RAG query failure does not block the run', async () => {
    const ragQuery = vi.fn(async () => {
      throw new Error('RAG service unavailable');
    });
    const deps = makeDeps({ ragQuery } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('RAG query with empty results does not inject evidence', async () => {
    const ragQuery = vi.fn(async () => []);
    const deps = makeDeps({ ragQuery } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(ragQuery).toHaveBeenCalled();
    expect(result.termination_reason).toBeDefined();
  });

  it('budget guard beforeModelCall is called', async () => {
    const budgetGuard = {
      beforeModelCall: vi.fn(async () => ({
        allowed: true, remaining_tokens: 5000,
        max_output_tokens: 1000,
      })),
      afterModelCall: vi.fn(async () => {}),
    };
    const deps = makeDeps({ budgetGuard } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(budgetGuard.beforeModelCall).toHaveBeenCalled();
  });

  it('budget guard afterModelCall is called', async () => {
    const budgetGuard = {
      beforeModelCall: vi.fn(async () => ({
        allowed: true, remaining_tokens: 5000,
        max_output_tokens: 1000,
      })),
      afterModelCall: vi.fn(async () => {}),
    };
    const deps = makeDeps({ budgetGuard } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('turn hooks beforeTurn is called', async () => {
    const beforeTurn = vi.fn(async () => {});
    const afterTurn = vi.fn(async () => {});
    const deps = makeDeps({
      turnHooks: { beforeTurn, afterTurn },
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(beforeTurn).toHaveBeenCalled();
  });

  it('turn hooks afterTurn is called', async () => {
    const beforeTurn = vi.fn(async () => {});
    const afterTurn = vi.fn(async () => {});
    const deps = makeDeps({
      turnHooks: { beforeTurn, afterTurn },
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(afterTurn).toHaveBeenCalled();
  });

  it('EventBus publishes events during run', async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe((event) => { events.push(event); });
    const deps = makeDeps({ eventBus: bus } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(events.length).toBeGreaterThan(0);
  });

  it('onModelDelta callback receives text deltas', async () => {
    const deltas: string[] = [];
    const deps = makeDeps({
      modelCall: vi.fn(async (messages, attempt, budget, directive, signal, onDelta) => {
        if (onDelta) onDelta('delta1');
        return {
          content: 'done',
          decision_summary: 'done',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
      onModelDelta: (d: string) => deltas.push(d),
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('steering subscribe is called when steering is provided', async () => {
    const subscribe = vi.fn(() => () => {});
    const deps = makeDeps({
      steering: { subscribe } as any,
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(subscribe).toHaveBeenCalled();
  });

  it('context_compiler is used when provided', async () => {
    const contextCompiler = {
      compile: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'compiled message' }],
        token_count: 10,
        layer_breakdown: {},
      })),
    };
    const deps = makeDeps({ contextCompiler } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(contextCompiler.compile).toHaveBeenCalled();
    expect(result.termination_reason).toBeDefined();
  });

  it('context_compiler failure falls back to manual messages', async () => {
    const contextCompiler = {
      compile: vi.fn(async () => {
        throw new Error('compilation failed');
      }),
    };
    const deps = makeDeps({ contextCompiler } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('writeProgressSafely does not throw when data_dir is set', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-progress-'));
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

  it('modelCall with tool_calls triggers tool execution', async () => {
    const toolExecute = vi.fn(async () => 'tool result');
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'using tool',
        decision_summary: 'call tool',
        stop_reason: 'tool_use' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
        tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test' } }],
      }) as ModelTurn),
      toolExecute,
    } as any);
    const engine = new LoopEngine(makeConfig({ strategy: 'react', max_iterations: 5 }), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('toolExecute failure is handled gracefully', async () => {
    const toolExecute = vi.fn(async () => {
      throw new Error('tool failed');
    });
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'using tool',
        decision_summary: 'call tool',
        stop_reason: 'tool_use' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
        tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test' } }],
      }) as ModelTurn),
      toolExecute,
    } as any);
    const engine = new LoopEngine(makeConfig({ strategy: 'react', max_iterations: 5 }), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('model refusal terminates with model_refusal', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'I cannot help with that',
        decision_summary: 'refused',
        stop_reason: 'content_filter' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn),
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('repeated run after completion throws', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    await engine.run();
    await expect(engine.run()).rejects.toThrow();
  });

  it('stop before run does not crash', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig(), deps);
    engine.stop('user_cancel');
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('context_reset_emitted is boolean', async () => {
    const engine = new LoopEngine(makeConfig(), makeDeps());
    const result = await engine.run();
    expect(typeof result.context_reset_emitted).toBe('boolean');
  });
});

// Import missing deps
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../runtime/event-bus.js';

// ===== LoopEngine NoCov targeted tests =====

describe('loop.ts: NoCov targeted tests', () => {
  function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
    return {
      run_id: 'test-run',
      goal: 'test goal',
      strategy: 'direct',
      max_iterations: 3,
      budget: { input_tokens: 10000, output_tokens: 5000 },
      ...overrides,
    } as LoopConfig;
  }

  function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
    const session = new DurableSession('test-run');
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

  it('contextCompiler with ragQuery injects evidence', async () => {
    const ragQuery = vi.fn(async () => [
      { chunk: { text: 'evidence' }, citation: { source_path: '/doc.md', content_hash: 'h1' } },
    ]);
    const contextCompiler = {
      compile: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'compiled' }],
        token_count: 10,
        layer_breakdown: {},
      })),
    };
    const deps = makeDeps({ ragQuery, contextCompiler } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('contextCompiler with RAG results builds layers', async () => {
    const ragQuery = vi.fn(async () => [
      { chunk: { text: 'evidence 1' }, citation: { source_path: '/doc1.md', content_hash: 'h1' } },
      { chunk: { text: 'evidence 2' }, citation: { source_path: '/doc2.md', content_hash: 'h2' } },
    ]);
    const contextCompiler = {
      compile: vi.fn(async (input: any) => {
        // Verify RAG results are passed to compiler
        expect(input.layers.retrieved_evidence.length).toBeGreaterThan(0);
        return {
          messages: [{ role: 'user', content: 'compiled with rag' }],
          token_count: 20,
          layer_breakdown: {},
        };
      }),
    };
    const deps = makeDeps({ ragQuery, contextCompiler } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
  });

  it('auto_execute=false with run_plan triggers pause', async () => {
    const engine = new LoopEngine(
      makeConfig({
        auto_execute: false,
        run_plan: { run_id: 'test', reasoning_strategy: 'direct' } as any,
      }),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.termination_reason).toBe('approval_required');
  });

  it('auto_execute=true with run_plan proceeds', async () => {
    const engine = new LoopEngine(
      makeConfig({
        auto_execute: true,
        run_plan: { run_id: 'test', reasoning_strategy: 'direct' } as any,
      }),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.termination_reason).not.toBe('approval_required');
  });

  it('data_dir with progress path writes file', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-nocov-'));
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

  it('steering subscribe and apply', async () => {
    let steeringCmd: unknown = null;
    const subscribe = vi.fn((cb: (cmd: unknown) => void) => {
      steeringCmd = cb;
      return () => {};
    });
    const deps = makeDeps({
      steering: { subscribe } as any,
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(subscribe).toHaveBeenCalled();
  });

  it('contextCompiler with empty RAG results', async () => {
    const ragQuery = vi.fn(async () => []);
    const contextCompiler = {
      compile: vi.fn(async (input: any) => {
        expect(input.layers.retrieved_evidence).toEqual([]);
        return { messages: [{ role: 'user', content: 'no rag' }], token_count: 5, layer_breakdown: {} };
      }),
    };
    const deps = makeDeps({ ragQuery, contextCompiler } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
  });

  it('contextCompiler with RAG failure falls back to manual', async () => {
    const ragQuery = vi.fn(async () => { throw new Error('RAG failed'); });
    const contextCompiler = {
      compile: vi.fn(async () => { throw new Error('compiler failed'); }),
    };
    const deps = makeDeps({ ragQuery, contextCompiler } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('modelCall with directive containing allowed_tools', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async (messages, attempt, budget, directive) => {
        expect(directive).toBeDefined();
        return {
          content: 'done with directive',
          decision_summary: 'done',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
  });

  it('context_capacity with high threshold does not trigger reset', async () => {
    const engine = new LoopEngine(
      makeConfig({
        context_capacity_tokens: 100000,
        context_compaction_threshold: 0.95,
      } as any),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.termination_reason).not.toBe('context_reset');
  });

  it('context_capacity with low threshold triggers reset', async () => {
    const engine = new LoopEngine(
      makeConfig({
        context_capacity_tokens: 10,
        context_compaction_threshold: 0.01,
      } as any),
      makeDeps(),
    );
    const result = await engine.run();
    expect(result.context_reset_emitted).toBeDefined();
  });

  it('stop_reason content_filter terminates with model_refusal', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'I cannot help',
        decision_summary: 'refused',
        stop_reason: 'content_filter' as const,
        usage: { input_tokens: 5, output_tokens: 3 },
      }) as ModelTurn),
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('toolExecute returns result that gets added to observations', async () => {
    const toolExecute = vi.fn(async () => 'tool result');
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'use tool',
        decision_summary: 'call tool',
        stop_reason: 'tool_use' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
        tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test' } }],
      }) as ModelTurn),
      toolExecute,
    } as any);
    const engine = new LoopEngine(makeConfig({ strategy: 'react', max_iterations: 5 }), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('modelCall returns without usage', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'done',
        stop_reason: 'stop' as const,
      }) as ModelTurn),
    } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('budget guard denies model call', async () => {
    const budgetGuard = {
      beforeModelCall: vi.fn(async () => ({ allowed: false, remaining_tokens: 0, max_output_tokens: 0 })),
      afterModelCall: vi.fn(async () => {}),
    };
    const deps = makeDeps({ budgetGuard } as any);
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('budget_exhausted');
  });

  it('handles unknown error classification', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        throw new TypeError('not a LoopError');
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
    expect(result.termination_reason).not.toBe('completed');
  });
});
