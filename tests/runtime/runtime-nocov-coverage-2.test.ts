import { describe, it, expect, vi } from 'vitest';
import { createHarnessHookAttenuationPolicy } from '../../runtime/hook-port.js';
import { shouldUseBudgetLedger } from '../../runtime/harness-support.js';
import { LoopEngine } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';
import type { LoopConfig, LoopDeps, ModelTurn } from '../../runtime/loop.js';
import type { RuntimeSteeringPort, RuntimeSteeringCommand } from '../../runtime/steering-port.js';

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return { run_id: 'test-nocov2', goal: 'test', strategy: 'direct', max_iterations: 1, ...overrides } as LoopConfig;
}
function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  const session = new DurableSession('test-nocov2');
  return {
    session,
    modelCall: vi.fn(async () => ({ content: 'done', decision_summary: 'completed', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } }) as ModelTurn),
    ...overrides,
  } as unknown as LoopDeps;
}

function makeSteeringPort(commands: RuntimeSteeringCommand[]): RuntimeSteeringPort {
  let queue = [...commands];
  return {
    drain(q: 'steer' | 'follow_up' | 'next_turn') {
      const matching = queue.filter(c => c.queue === q);
      queue = queue.filter(c => c.queue !== q);
      return matching;
    },
    subscribe() { return () => {}; },
  };
}

// ---- loop.ts L370, L386, L397: runtime_error, post_turn_hook_failed events ----
describe('runtime-nocov-2: loop error events', () => {
  it('emits runtime_error with classification for unknown strategy', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ strategy: 'unknown' as 'direct' }), deps);
    try { await engine.run(); } catch { /* expected */ }
    const events = deps.session.getEvents();
    const error = events.find(e => (e.data as { event?: string }).event === 'runtime_error');
    expect(error).toBeDefined();
  });

  it('emits post_turn_hook_failed when flushPendingTurnHook throws', async () => {
    const deps = makeDeps({
      turnHooks: {
        beforeTurn: async () => {},
        afterTurn: async () => { throw new Error('flush failed'); },
      },
    });
    const engine = new LoopEngine(makeConfig({ max_iterations: 1 }), deps);
    await engine.run();
    const events = deps.session.getEvents();
    const failed = events.find(e => (e.data as { event?: string }).event === 'post_turn_hook_failed');
    expect(failed).toBeDefined();
  });

  it('emits progress_write_failed when writeProgress throws', async () => {
    const deps = makeDeps();
    const engine = new LoopEngine(makeConfig({ max_iterations: 1, data_dir: '/nonexistent/path/that/does/not/exist' }), deps);
    await engine.run();
    const events = deps.session.getEvents();
    const failed = events.find(e => (e.data as { event?: string }).event === 'progress_write_failed');
    expect(failed).toBeDefined();
  });
});

// ---- loop.ts L500, L526: steering interrupt with signal ----
describe('runtime-nocov-2: steering with signal', () => {
  it('combines deps.signal with controller signal', async () => {
    const controller = new AbortController();
    const killCmd: RuntimeSteeringCommand = {
      command_id: 'kill1', queue: 'steer', priority: 'kill', content: 'stop',
    };
    const steering = makeSteeringPort([killCmd]);
    const deps = makeDeps({
      steering,
      signal: controller.signal,
    });
    const engine = new LoopEngine(makeConfig({ max_iterations: 5, strategy: 'react' }), deps);
    const result = await engine.run();
    // Steering kill should cause user_cancel termination
    expect(result.termination_reason).toBe('user_cancel');
  });

  it('steer command in applySteering adds content to messages', async () => {
    const steerCmd: RuntimeSteeringCommand = {
      command_id: 'steer1', queue: 'steer', priority: 'user', content: 'redirect',
    };
    const steering = makeSteeringPort([steerCmd]);
    let capturedMessages: unknown[] = [];
    const deps = makeDeps({
      steering,
      modelCall: vi.fn(async (messages: unknown[]) => {
        capturedMessages = [...messages];
        return { content: 'done', decision_summary: 'completed', stop_reason: 'stop' as const, usage: { input_tokens: 10, output_tokens: 5 } } as ModelTurn;
      }),
    });
    const engine = new LoopEngine(makeConfig({ max_iterations: 1, strategy: 'react' }), deps);
    await engine.run();
    // The steer content should be in the messages
    const steerMsg = capturedMessages.find(m => {
      const msg = m as { metadata?: { source?: string } };
      return msg.metadata?.source === 'steering';
    });
    expect(steerMsg).toBeDefined();
  });
});

// ---- hook-port.ts L113: canonicalJson with undefined ----
describe('runtime-nocov-2: canonicalJson edge cases', () => {
  it('sameJson handles undefined values', () => {
    // Test through pre_turn event
    const policy = createHarnessHookAttenuationPolicy();
    const result = policy.validate({
      event: 'pre_turn',
      scope: { tenant_id: 't', run_id: 'r', session_id: 's', operation_id: 'o', attempt_id: 'a' },
      original_payload: undefined,
      candidate_payload: undefined,
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson handles numbers', () => {
    const policy = createHarnessHookAttenuationPolicy();
    const result = policy.validate({
      event: 'pre_turn',
      scope: { tenant_id: 't', run_id: 'r', session_id: 's', operation_id: 'o', attempt_id: 'a' },
      original_payload: 42,
      candidate_payload: 42,
    });
    expect(result.allowed).toBe(true);
  });

  it('sameJson handles booleans', () => {
    const policy = createHarnessHookAttenuationPolicy();
    const result = policy.validate({
      event: 'pre_turn',
      scope: { tenant_id: 't', run_id: 'r', session_id: 's', operation_id: 'o', attempt_id: 'a' },
      original_payload: true,
      candidate_payload: true,
    });
    expect(result.allowed).toBe(true);
  });
});

// ---- hook-port.ts L290: tools narrowing with empty arrays ----
describe('runtime-nocov-2: tools narrowing edge cases', () => {
  it('allows when both tools are empty arrays', () => {
    const policy = createHarnessHookAttenuationPolicy();
    function makeReq(overrides: Record<string, unknown> = {}) {
      return {
        registry_snapshot_hash: 'h1',
        estimated_input_tokens: 100,
        required_capabilities: ['text_reasoning'],
        requires_structured_output: false,
        request: { messages: [], tools: [], max_tokens: 1000 },
        data_policy: { local_only: false, allowed_regions: ['us'], max_retention_days: 30, training_allowed: false },
        policy: { allowed_provider_ids: ['p1'], denied_provider_ids: [] },
        run_plan: { allowed_provider_ids: ['p1'], required_capabilities: [] },
        ...overrides,
      };
    }
    const result = policy.validate({
      event: 'before_provider_request',
      scope: { tenant_id: 't', run_id: 'r', session_id: 's', operation_id: 'o', attempt_id: 'a' },
      original_payload: makeReq(),
      candidate_payload: makeReq(),
    });
    expect(result.allowed).toBe(true);
  });
});

// ---- shouldUseBudgetLedger: now used, tests will cover it ----
describe('runtime-nocov-2: shouldUseBudgetLedger', () => {
  it('returns true when both defined', () => {
    expect(shouldUseBudgetLedger({}, {})).toBe(true);
  });

  it('returns false when ledger is undefined', () => {
    expect(shouldUseBudgetLedger(undefined, {})).toBe(false);
  });

  it('returns false when pricing is undefined', () => {
    expect(shouldUseBudgetLedger({}, undefined)).toBe(false);
  });

  it('returns false when both are undefined', () => {
    expect(shouldUseBudgetLedger(undefined, undefined)).toBe(false);
  });
});
