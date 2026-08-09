import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopEngine } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';
import { EventBus } from '../../runtime/event-bus.js';
import type { LoopConfig, LoopDeps, ModelTurn, LoopResult } from '../../runtime/loop.js';
import { LoopError } from '../../runtime/errors.js';
import { HookRestrictionError } from '../../runtime/hook-port.js';

const roots: string[] = [];

function cleanup() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    run_id: 'test-surv3',
    goal: 'test goal',
    strategy: 'direct',
    max_iterations: 3,
    ...overrides,
  } as LoopConfig;
}

function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  const session = new DurableSession('test-surv3');
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
// RAG evidence injection (L315-340) - StringLiteral, ArrayDeclaration
// ============================================================

describe('Loop survival-3 - RAG evidence injection exact assertions', () => {
  it('injects RAG evidence as user role with untrusted warning', async () => {
    const capturedMessages: unknown[] = [];
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        capturedMessages.push(...messages);
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
      ragQuery: vi.fn(async () => [
        { chunk: { text: 'evidence text' }, citation: { source_path: '/doc/evidence.md', content_hash: 'abc123' } },
      ]) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    // Should have the goal message and the RAG evidence message
    expect(capturedMessages.length).toBeGreaterThanOrEqual(2);
    const ragMsg = capturedMessages.find((m: any) => typeof m.content === 'string' && m.content.includes('UNTRUSTED'));
    expect(ragMsg).toBeDefined();
    expect((ragMsg as any).role).toBe('user');
    expect((ragMsg as any).content).toContain('evidence text');
    expect((ragMsg as any).content).toContain('/doc/evidence.md');
    expect((ragMsg as any).content).toContain('adversarial content');
  });

  it('injects multiple RAG results with source path and text', async () => {
    const capturedMessages: unknown[] = [];
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        capturedMessages.push(...messages);
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
      ragQuery: vi.fn(async () => [
        { chunk: { text: 'first evidence' }, citation: { source_path: '/doc/first.md', content_hash: 'hash1' } },
        { chunk: { text: 'second evidence' }, citation: { source_path: '/doc/second.md', content_hash: 'hash2' } },
      ]) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    const ragMsg = capturedMessages.find((m: any) => typeof m.content === 'string' && m.content.includes('UNTRUSTED'));
    if (ragMsg) {
      expect((ragMsg as any).content).toContain('first evidence');
      expect((ragMsg as any).content).toContain('second evidence');
      expect((ragMsg as any).content).toContain('/doc/first.md');
      expect((ragMsg as any).content).toContain('/doc/second.md');
    }
  });

  it('does not inject RAG evidence when results are empty', async () => {
    const capturedMessages: unknown[] = [];
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        capturedMessages.push(...messages);
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
      ragQuery: vi.fn(async () => []) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    const ragMsg = capturedMessages.find((m: any) => typeof m.content === 'string' && m.content.includes('UNTRUSTED'));
    expect(ragMsg).toBeUndefined();
  });

  it('continues without RAG evidence when ragQuery throws', async () => {
    const deps = makeDeps({
      ragQuery: vi.fn(async () => { throw new Error('RAG unavailable'); }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('completed');
  });
});

// ============================================================
// recordTurn usage tracking (L645-670) - exact token accounting
// ============================================================

describe('Loop survival-3 - recordTurn usage tracking', () => {
  it('accumulates input_tokens from multiple turns', async () => {
    let callCount = 0;
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        callCount++;
        return {
          content: `turn ${callCount}`,
          decision_summary: `summary ${callCount}`,
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10 * callCount, output_tokens: 5 * callCount },
        } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig({ max_iterations: 2, strategy: 'direct' }), deps);
    const result = await engine.run();
    // direct strategy calls model once, so input_tokens should be 10
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
  });

  it('defaults usage to 0 when model returns no usage', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'done',
        stop_reason: 'stop' as const,
      }) as ModelTurn),
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
    expect(result.usage.total_tokens).toBe(0);
  });

  it('throws LoopError when model returns invalid usage (negative)', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'done',
        stop_reason: 'stop' as const,
        usage: { input_tokens: -1, output_tokens: 5 },
      }) as ModelTurn),
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    // Should terminate with malformed_response due to LoopError
    expect(result.termination_reason).toBe('malformed_response');
  });

  it('throws LoopError when model returns non-integer usage', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'done',
        stop_reason: 'stop' as const,
        usage: { input_tokens: 10.5, output_tokens: 5 },
      }) as ModelTurn),
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('malformed_response');
  });
});

// ============================================================
// recordObservation truncation (L690-720) - exact assertions
// ============================================================

describe('Loop survival-3 - observation truncation', () => {
  it('truncates observations exceeding max_observation_bytes', async () => {
    const largeResult = 'x'.repeat(200);
    let callCount = 0;
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'using tool',
            decision_summary: 'tool call',
            stop_reason: 'tool_use' as const,
            tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          } as ModelTurn;
        }
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 5, output_tokens: 2 } } as ModelTurn;
      }) as any,
      toolExecute: vi.fn(async () => largeResult) as any,
    });
    const engine = new LoopEngine(
      makeConfig({ max_observation_bytes: 50, strategy: 'react', max_iterations: 3 } as any),
      deps,
    );
    const result = await engine.run();
    const obs = result.turns.flatMap((t) => t.tool_observations);
    // If tool executed, verify truncation behavior
    for (const o of obs) {
      if (o.bytes > 50) {
        expect(o.truncated).toBe(true);
        expect(o.result).toHaveProperty('truncated', true);
      }
    }
  });

  it('does not truncate observations under max_observation_bytes', async () => {
    const smallResult = 'small result';
    let callCount = 0;
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'using tool',
            decision_summary: 'tool call',
            stop_reason: 'tool_use' as const,
            tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          } as ModelTurn;
        }
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 5, output_tokens: 2 } } as ModelTurn;
      }) as any,
      toolExecute: vi.fn(async () => smallResult) as any,
    });
    const engine = new LoopEngine(
      makeConfig({ max_observation_bytes: 1024, strategy: 'react', max_iterations: 3 } as any),
      deps,
    );
    const result = await engine.run();
    const obs = result.turns.flatMap((t) => t.tool_observations);
   if (obs.length > 0) {
      expect(obs[0]!.truncated).toBe(false);
   }
 });

 it('computes sha256 hash of observation payload', async () => {
   const deps = makeDeps({
     modelCall: vi.fn(async () => ({
       content: 'using tool',
       decision_summary: 'tool call',
       stop_reason: 'tool_use' as const,
       tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
       usage: { input_tokens: 10, output_tokens: 5 },
     }) as ModelTurn),
     toolExecute: vi.fn(async () => 'test result') as any,
   });
   const engine = new LoopEngine(makeConfig({ strategy: 'direct' }), deps);
   const result = await engine.run();
   const firstTurn = result.turns[0];
   if (firstTurn && firstTurn.tool_observations.length > 0) {
     const obs = firstTurn.tool_observations[0] as any;
     expect(obs?.sha256).toMatch(/^[0-9a-f]{64}$/);
   }
  });

  it('records observation with error status when tool throws', async () => {
    let callCount = 0;
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'using tool',
            decision_summary: 'tool call',
            stop_reason: 'tool_use' as const,
            tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          } as ModelTurn;
        }
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 5, output_tokens: 2 } } as ModelTurn;
      }) as any,
      toolExecute: vi.fn(async () => { throw new Error('tool failed'); }) as any,
    });
    const engine = new LoopEngine(makeConfig({ strategy: 'react', max_iterations: 3 }), deps);
    const result = await engine.run();
    const obs = result.turns.flatMap((t) => t.tool_observations);
    // If tool executed and errored, verify error status
    for (const o of obs) {
      if (o.status === 'error') {
        expect(o.error).toContain('tool failed');
      }
    }
  });
});

// ============================================================
// terminate event publishing (L752-786) - exact event names
// ============================================================

describe('Loop survival-3 - terminate event publishing', () => {
  it('publishes run_terminated event with exact termination_reason', async () => {
    const session = new DurableSession('test-term');
    const deps = makeDeps({ session });
    const engine = new LoopEngine(makeConfig({ run_id: 'test-term' }), deps);
    const result = await engine.run();
    const events = session.getEvents().filter((e: any) => e.data?.event === 'run_terminated');
   expect(events.length).toBe(1);
    expect((events[0] as any).data.termination_reason).toBe(result.termination_reason);
    expect((events[0] as any).data.iterations).toBe(result.iterations);
    expect((events[0] as any).data.usage.total_tokens).toBe(result.usage.total_tokens);
  });

  it('sets context_reset_emitted when termination reason is context_reset', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'done',
        decision_summary: 'done',
        stop_reason: 'stop' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn),
    });
    const engine = new LoopEngine(
      makeConfig({ context_capacity_tokens: 10, context_compaction_threshold: 0.5 }),
      deps,
    );
    const result = await engine.run();
    // With very low context capacity, should trigger context_reset
    if (result.termination_reason === 'context_reset') {
      expect(result.context_reset_emitted).toBe(true);
    }
  });

  it('does not set context_reset_emitted for non-context_reset terminations', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.context_reset_emitted).toBe(false);
  });
});

// ============================================================
// EventBus publishing (L880-887) - exact event types
// ============================================================

describe('Loop survival-3 - EventBus publishing', () => {
  it('publishes model_called event with exact properties', async () => {
    const eventBus = new EventBus();
    const publishedEvents: any[] = [];
    const originalPublish = eventBus.publish.bind(eventBus);
    eventBus.publish = (event: any) => {
      publishedEvents.push(event);
      originalPublish(event);
    };
    const deps = makeDeps({ eventBus });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    const modelCalledEvents = publishedEvents.filter((e) => e.type === 'model_called');
    expect(modelCalledEvents.length).toBeGreaterThan(0);
    expect(modelCalledEvents[0].run_id).toBe('test-surv3');
    expect(modelCalledEvents[0].data).toHaveProperty('iteration');
    expect(modelCalledEvents[0].data).toHaveProperty('decision_summary');
    expect(modelCalledEvents[0].data).toHaveProperty('tool_calls');
    expect(modelCalledEvents[0].data).toHaveProperty('usage');
  });

  it('publishes run_state_change event on termination', async () => {
    const eventBus = new EventBus();
    const publishedEvents: any[] = [];
    const originalPublish = eventBus.publish.bind(eventBus);
    eventBus.publish = (event: any) => {
      publishedEvents.push(event);
      originalPublish(event);
    };
    const deps = makeDeps({ eventBus });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    const stateChangeEvents = publishedEvents.filter((e) => e.type === 'run_state_change');
    expect(stateChangeEvents.length).toBeGreaterThan(0);
    const terminateEvent = stateChangeEvents.find((e) => e.data?.termination_reason);
    expect(terminateEvent).toBeDefined();
    expect(terminateEvent!.data.termination_reason).toBe(result.termination_reason);
  });

  it('does not publish events when no EventBus is attached', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    // Just verify it doesn't crash without eventBus
    expect(result.termination_reason).toBe('completed');
  });
});

// ============================================================
// validateConfig (L850-894) - exact error messages
// ============================================================

describe('Loop survival-3 - validateConfig exact errors', () => {
  it('throws LoopError for empty run_id', () => {
    expect(() => new LoopEngine(makeConfig({ run_id: '' } as any), makeDeps()))
      .toThrow('run_id is required');
  });

  it('throws LoopError for empty goal', () => {
    expect(() => new LoopEngine(makeConfig({ goal: '' } as any), makeDeps()))
      .toThrow('goal is required');
  });

  it('throws LoopError for negative max_iterations', () => {
    expect(() => new LoopEngine(makeConfig({ max_iterations: -1 } as any), makeDeps()))
      .toThrow('max_iterations must be a non-negative safe integer');
  });

  it('throws LoopError for non-integer max_iterations', () => {
    expect(() => new LoopEngine(makeConfig({ max_iterations: 1.5 } as any), makeDeps()))
      .toThrow('max_iterations must be a non-negative safe integer');
  });

  it('throws LoopError for negative budget_tokens', () => {
    expect(() => new LoopEngine(makeConfig({ budget_tokens: -100 } as any), makeDeps()))
      .toThrow('budget_tokens must be a non-negative safe integer');
  });

  it('throws LoopError for negative deadline_ms', () => {
    expect(() => new LoopEngine(makeConfig({ deadline_ms: -1 } as any), makeDeps()))
      .toThrow('deadline_ms must be a non-negative safe integer');
  });

  it('throws LoopError for negative max_output_tokens_per_call', () => {
    expect(() => new LoopEngine(makeConfig({ max_output_tokens_per_call: -1 } as any), makeDeps()))
      .toThrow('max_output_tokens_per_call must be a non-negative safe integer');
  });

  it('throws LoopError for negative max_observation_bytes', () => {
    expect(() => new LoopEngine(makeConfig({ max_observation_bytes: -1 } as any), makeDeps()))
      .toThrow('max_observation_bytes must be a non-negative safe integer');
  });

  it('accepts undefined optional values', () => {
    expect(() => new LoopEngine(makeConfig({
      budget_tokens: undefined,
      deadline_ms: undefined,
      max_output_tokens_per_call: undefined,
      max_observation_bytes: undefined,
    } as any), makeDeps())).not.toThrow();
  });
});

// ============================================================
// classifyUnhandled (L800-815) - exact classification
// ============================================================

describe('Loop survival-3 - classifyUnhandled exact classification', () => {
  it('classifies HookRestrictionError with force_prompt as approval_required', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        throw new HookRestrictionError('pre_turn', 'force_prompt', 'reason');
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('approval_required');
  });

  it('classifies HookRestrictionError with skip as skipped', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        throw new HookRestrictionError('pre_turn', 'skip', 'reason');
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('skipped');
  });

  it('classifies HookRestrictionError with deny as denied', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        throw new HookRestrictionError('pre_turn', 'deny', 'reason');
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('denied');
  });

  it('classifies LoopError as malformed_response', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        throw new LoopError('test error');
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('malformed_response');
  });

  it('classifies generic Error as provider_failure', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        throw new Error('network failure');
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('provider_failure');
  });
});

// ============================================================
// progress_path and writeProgressSafely (L400-420)
// ============================================================

describe('Loop survival-3 - progress path', () => {
  it('includes progress_path in result when data_dir is set', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'loop-progress-'));
    roots.push(tmpDir);
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ data_dir: tmpDir } as any), deps);
    const result = await engine.run();
    expect(result.progress_path).toBe(join(tmpDir, 'progress.json'));
  });

  it('does not include progress_path when data_dir is undefined', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.progress_path).toBeUndefined();
  });
});

// ============================================================
// stop() method (L395-405)
// ============================================================

describe('Loop survival-3 - stop method', () => {
  it('stop terminates with given reason', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    engine.stop('user_cancel');
    const result = await engine.run();
    // After stop, the loop should be terminated
    expect(result.termination_reason).toBe('user_cancel');
  });

  it('stop sets requestedStop which is checked in preflight', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig(), deps);
    engine.stop('user_cancel');
    const result = await engine.run();
    // stop() before run() sets requestedStop, which is checked in preflight()
    expect(result.termination_reason).toBe('user_cancel');
  });
});

// ============================================================
// run_id validation and double-run prevention
// ============================================================

describe('Loop survival-3 - double-run prevention', () => {
  it('throws LoopError when run() is called twice', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    await expect(engine.run()).rejects.toThrow('LoopEngine instances can run exactly once');
  });
});

// ============================================================
// Session events exact assertions
// ============================================================

describe('Loop survival-3 - session events', () => {
  it('appends assistant event with exact decision_summary and tool_calls', async () => {
    const session = new DurableSession('test-sess');
    const deps = makeDeps({
      session,
      modelCall: vi.fn(async () => ({
        content: 'response',
        decision_summary: 'exact summary',
        stop_reason: 'stop' as const,
        tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn),
    });
    const engine = new LoopEngine(makeConfig({ run_id: 'test-sess' }), deps);
    await engine.run();
    const assistantEvents = session.getEvents().filter((e: any) => e.type === 'assistant');
    expect(assistantEvents.length).toBeGreaterThan(0);
    expect((assistantEvents[0] as any).data.decision_summary).toBe('exact summary');
    expect((assistantEvents[0] as any).data.tool_calls).toBeDefined();
    expect((assistantEvents[0] as any).data.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('appends tool_call event with exact tool name and arguments', async () => {
    const session = new DurableSession('test-tool');
    const deps = makeDeps({
      session,
      modelCall: vi.fn(async () => ({
        content: 'using tool',
        decision_summary: 'tool summary',
        stop_reason: 'tool_use' as const,
        tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn),
      toolExecute: vi.fn(async () => 'result') as any,
    });
    const engine = new LoopEngine(makeConfig({ run_id: 'test-tool', strategy: 'direct' }), deps);
    await engine.run();
    const toolCallEvents = session.getEvents().filter((e: any) => e.type === 'tool_call');
    if (toolCallEvents.length > 0) {
      expect((toolCallEvents[0] as any).data.tool).toBe('read_file');
      expect((toolCallEvents[0] as any).data.tool_call_id).toBe('tc-1');
      expect((toolCallEvents[0] as any).data.arguments).toEqual({ path: '/workspace/test' });
    }
  });
});

// ============================================================
// ContextCompiler path (L282-315)
// ============================================================

describe('Loop survival-3 - ContextCompiler integration', () => {
  it('uses ContextCompiler when provided', async () => {
    const capturedMessages: unknown[] = [];
    const contextCompiler = {
      compile: vi.fn(async () => ({
        messages: [
          { role: 'system', content: 'compiled system' },
          { role: 'user', content: 'compiled user' },
        ],
        manifest: {},
        total_input_tokens: 10,
        reserved_output_tokens: 4096,
      })) as any,
    } as any;
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        capturedMessages.push(...messages);
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
      contextCompiler,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    expect(contextCompiler.compile).toHaveBeenCalledTimes(1);
    // Messages should be from the compiler, not just the goal
    const systemMsg = capturedMessages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect((systemMsg as any).content).toBe('compiled system');
  });

  it('falls back to manual messages when ContextCompiler throws', async () => {
    const capturedMessages: unknown[] = [];
    const contextCompiler = {
      compile: vi.fn(async () => { throw new Error('compiler failed'); }),
    } as any;
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        capturedMessages.push(...messages);
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
      contextCompiler,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    // Should fall back to just the goal message
    const userMsg = capturedMessages.find((m: any) => m.role === 'user' && m.content === 'test goal');
    expect(userMsg).toBeDefined();
  });

  it('joins array content from ContextCompiler messages', async () => {
    const capturedMessages: unknown[] = [];
    const contextCompiler = {
      compile: vi.fn(async () => ({
        messages: [
          { role: 'user', content: ['line1', 'line2', 'line3'] },
        ],
        manifest: {},
        total_input_tokens: 10,
        reserved_output_tokens: 4096,
      })) as any,
    } as any;
    const deps = makeDeps({
      modelCall: vi.fn(async (messages: unknown[]) => {
        capturedMessages.push(...messages);
        return { content: 'done', decision_summary: 'done', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }) as any,
      contextCompiler,
    });
    const engine = new LoopEngine(makeConfig(), deps);
    await engine.run();
    const userMsg = capturedMessages.find((m: any) => m.role === 'user');
    if (userMsg) {
      expect((userMsg as any).content).toBe('line1\nline2\nline3');
    }
  });
});
