import { describe, it, expect, vi } from 'vitest';
import { LoopEngine, type LoopConfig, type LoopDeps, type ModelTurn } from '../../runtime/loop.js';
import type { DurableSession } from '../../session/durable-session.js';

function makeSession(id = 'rag-test'): DurableSession {
  return {
    session_id: id, append: vi.fn(), appendEvent: vi.fn(), getEvents: vi.fn(() => []),
    eventCount: vi.fn(() => 0), acquireWriter: vi.fn(), releaseWriter: vi.fn(), snapshot_: vi.fn(),
  } as unknown as DurableSession;
}

function baseConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    strategy: 'direct', max_iterations: 1, run_id: 'rag-run',
    goal: 'answer the question', clock: () => '2026-07-25T00:00:00.000Z',
    nowMs: () => 1000, ...overrides,
  };
}

function baseDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  return {
    session: makeSession(),
    modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 'answered' } as ModelTurn)),
    ...overrides,
  } as LoopDeps;
}

function makeRagResult(text: string, source: string, hash: string) {
  return {
    chunk: { text },
    citation: { source_path: source, content_hash: hash },
  };
}

describe('LoopEngine: ContextCompiler path', () => {
  it('uses contextCompiler when provided', async () => {
    const compiled = { messages: [{ role: 'user', content: 'compiled message' }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const deps = baseDeps({ contextCompiler });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    expect(contextCompiler.compile).toHaveBeenCalledOnce();
  });

  it('passes goal text to contextCompiler as task layer', async () => {
    const compiled = { messages: [{ role: 'user', content: 'result' }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const deps = baseDeps({ contextCompiler });
    const loop = new LoopEngine(baseConfig({ goal: 'my specific goal' }), deps);
    await loop.run();
    const call = (contextCompiler.compile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const task = call.layers.task[0];
    expect(task.content.text).toBe('my specific goal');
  });

  it('passes run_id to contextCompiler', async () => {
    const compiled = { messages: [{ role: 'user', content: 'result' }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const deps = baseDeps({ contextCompiler });
    const loop = new LoopEngine(baseConfig({ run_id: 'my-run-id' }), deps);
    await loop.run();
    const call = (contextCompiler.compile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.run_id).toBe('my-run-id');
    expect(call.session_id).toBe('my-run-id');
  });

  it('queries RAG when contextCompiler and ragQuery both provided', async () => {
    const compiled = { messages: [{ role: 'user', content: 'result' }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const ragQuery = vi.fn(async () => [makeRagResult('evidence text', 'src.txt', 'hash123')]);
    const deps = baseDeps({ contextCompiler, ragQuery });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    expect(ragQuery).toHaveBeenCalled();
    const call = (contextCompiler.compile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const evidence = call.layers.retrieved_evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0].content.text).toBe('evidence text');
    expect(evidence[0].content.source).toBe('src.txt');
    expect(evidence[0].source_hash).toBe('hash123');
  });

  it('RAG failure with contextCompiler returns empty results', async () => {
    const compiled = { messages: [{ role: 'user', content: 'result' }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const ragQuery = vi.fn(async () => { throw new Error('RAG failed'); });
    const deps = baseDeps({ contextCompiler, ragQuery });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
  });

  it('contextCompiler failure falls back to manual message building', async () => {
    const contextCompiler = { compile: vi.fn(async () => { throw new Error('compile failed'); }) };
    const modelCall = vi.fn(async () => ({ content: 'fallback ok', decision_summary: 'ok' } as ModelTurn));
    const deps = baseDeps({ contextCompiler, modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
    expect(modelCall).toHaveBeenCalled();
  });

  it('contextCompiler with array content joins with newlines', async () => {
    const compiled = { messages: [{ role: 'user', content: ['line1', 'line2'] }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const modelCall = vi.fn(async (ctx: unknown) => {
      const context = ctx as { messages: unknown[] };
      const msg = context.messages[context.messages.length - 1] as { content: string };
      expect(msg.content).toBe('line1\nline2');
      return { content: 'ok', decision_summary: 'ok' } as ModelTurn;
    });
    const deps = baseDeps({ contextCompiler, modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
  });

  it('contextCompiler uses context_capacity_tokens from config', async () => {
    const compiled = { messages: [{ role: 'user', content: 'result' }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const deps = baseDeps({ contextCompiler });
    const loop = new LoopEngine(baseConfig({ context_capacity_tokens: 64000 }), deps);
    await loop.run();
    const call = (contextCompiler.compile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.context_capacity_tokens).toBe(64000);
  });

  it('contextCompiler defaults context_capacity_tokens to 128000', async () => {
    const compiled = { messages: [{ role: 'user', content: 'result' }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const deps = baseDeps({ contextCompiler });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    const call = (contextCompiler.compile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.context_capacity_tokens).toBe(128_000);
  });

  it('contextCompiler selected.rag_source_ids maps RAG results', async () => {
    const compiled = { messages: [{ role: 'user', content: 'result' }] };
    const contextCompiler = { compile: vi.fn(async () => compiled) } as any;
    const ragQuery = vi.fn(async () => [
      makeRagResult('a', 'src1', 'h1'),
      makeRagResult('b', 'src2', 'h2'),
    ]);
    const deps = baseDeps({ contextCompiler, ragQuery });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    const call = (contextCompiler.compile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.selected.rag_source_ids).toEqual(['rag-0', 'rag-1']);
  });
});

describe('LoopEngine: RAG query path (no contextCompiler)', () => {
  it('injects RAG evidence as user role when ragQuery provided', async () => {
    const ragQuery = vi.fn(async () => [makeRagResult('evidence text', 'src.txt', 'hash')]);
    const modelCall = vi.fn(async (ctx: unknown) => {
      const context = ctx as { messages: Array<{ role: string; content: string }> };
      const ragMsg = context.messages.find(m => m.content.includes('evidence text'));
      expect(ragMsg).toBeDefined();
      expect(ragMsg!.role).toBe('user');
      return { content: 'ok', decision_summary: 'ok' } as ModelTurn;
    });
    const deps = baseDeps({ ragQuery, modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    expect(ragQuery).toHaveBeenCalled();
  });

  it('RAG evidence includes UNTRUSTED warning', async () => {
    const ragQuery = vi.fn(async () => [makeRagResult('some evidence', 'doc.txt', 'h')]);
    const modelCall = vi.fn(async (ctx: unknown) => {
      const context = ctx as { messages: Array<{ content: string }> };
      const ragMsg = context.messages.find(m => m.content.includes('some evidence'));
      expect(ragMsg!.content).toContain('UNTRUSTED');
      return { content: 'ok', decision_summary: 'ok' } as ModelTurn;
    });
    const deps = baseDeps({ ragQuery, modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
  });

  it('RAG evidence includes source path', async () => {
    const ragQuery = vi.fn(async () => [makeRagResult('text', '/path/to/doc.txt', 'h')]);
    const modelCall = vi.fn(async (ctx: unknown) => {
      const context = ctx as { messages: Array<{ content: string }> };
      const ragMsg = context.messages.find(m => m.content.includes('text'));
      expect(ragMsg!.content).toContain('/path/to/doc.txt');
      return { content: 'ok', decision_summary: 'ok' } as ModelTurn;
    });
    const deps = baseDeps({ ragQuery, modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
  });

  it('RAG with multiple results joins with double newlines', async () => {
    const ragQuery = vi.fn(async () => [
      makeRagResult('first', 'a.txt', 'h1'),
      makeRagResult('second', 'b.txt', 'h2'),
    ]);
    const modelCall = vi.fn(async (ctx: unknown) => {
      const context = ctx as { messages: Array<{ content: string }> };
      const ragMsg = context.messages.find(m => m.content.includes('first'));
      expect(ragMsg!.content).toContain('first');
      expect(ragMsg!.content).toContain('second');
      expect(ragMsg!.content).toContain('\n\n');
      return { content: 'ok', decision_summary: 'ok' } as ModelTurn;
    });
    const deps = baseDeps({ ragQuery, modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
  });

  it('RAG failure does not block run', async () => {
    const ragQuery = vi.fn(async () => { throw new Error('RAG error'); });
    const deps = baseDeps({ ragQuery });
    const loop = new LoopEngine(baseConfig(), deps);
    const result = await loop.run();
    expect(result.termination_reason).toBe('completed');
  });

  it('RAG with empty results does not inject evidence', async () => {
    const ragQuery = vi.fn(async () => []);
    const modelCall = vi.fn(async (ctx: unknown) => {
      const context = ctx as { messages: Array<{ content: string }> };
      // Only the goal message should exist, no RAG evidence
      expect(context.messages).toHaveLength(1);
      expect(context.messages[0]!.content).toBe('answer the question');
      return { content: 'ok', decision_summary: 'ok' } as ModelTurn;
    });
    const deps = baseDeps({ ragQuery, modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
  });

  it('no RAG and no contextCompiler: only goal message', async () => {
    const modelCall = vi.fn(async (ctx: unknown) => {
      const context = ctx as { messages: Array<{ content: string }> };
      expect(context.messages).toHaveLength(1);
      expect(context.messages[0]!.content).toBe('answer the question');
      return { content: 'ok', decision_summary: 'ok' } as ModelTurn;
    });
    const deps = baseDeps({ modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
  });

  it('goal message role is user', async () => {
    const modelCall = vi.fn(async (ctx: unknown) => {
      const context = ctx as { messages: Array<{ role: string }> };
      expect(context.messages[0]!.role).toBe('user');
      return { content: 'ok', decision_summary: 'ok' } as ModelTurn;
    });
    const deps = baseDeps({ modelCall });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
  });
});

describe('LoopEngine: plan mode (auto_execute=false)', () => {
  it('pauses when auto_execute is false', async () => {
    const session = makeSession();
    const deps = baseDeps({ session });
    const loop = new LoopEngine(baseConfig({ auto_execute: false, strategy: 'plan_execute' }), deps);
    await loop.run();
    expect(session.append).toHaveBeenCalledWith('system', expect.objectContaining({
      event: 'plan_mode_paused',
    }));
  });

  it('does not pause when auto_execute is true', async () => {
    const session = makeSession();
    const deps = baseDeps({ session });
    const loop = new LoopEngine(baseConfig({ auto_execute: true }), deps);
    await loop.run();
    expect(session.append).not.toHaveBeenCalledWith('system', expect.objectContaining({
      event: 'plan_mode_paused',
    }));
  });

  it('does not pause when auto_execute is undefined', async () => {
    const session = makeSession();
    const deps = baseDeps({ session });
    const loop = new LoopEngine(baseConfig(), deps);
    await loop.run();
    expect(session.append).not.toHaveBeenCalledWith('system', expect.objectContaining({
      event: 'plan_mode_paused',
    }));
  });
});
