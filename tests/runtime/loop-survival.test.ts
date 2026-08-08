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
