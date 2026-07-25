import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunPlan } from '../../contracts/index.js';
import { LoopEngine, LoopError, stripCredentialsFromEnv } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(id = 'loop-authority'): DurableSession {
  return new DurableSession(id, {
    clock: () => '2026-07-25T00:00:00.000Z',
  });
}

function reactPlan(tool = 'read_file'): RunPlan {
  return {
    tool_grants: [{ tool, granted: true }],
    workflow_graph: { nodes: [], edges: [] },
  } as unknown as RunPlan;
}

function planExecutePlan(): RunPlan {
  return {
    tool_grants: [{ tool: 'read_file', granted: true }],
    workflow_graph: {
      nodes: [
        { step_id: 'model', step_type: 'model_call', status: 'pending' },
        {
          step_id: 'tool',
          step_type: 'tool_call',
          status: 'pending',
          tool_name: 'read_file',
        },
        { step_id: 'verify', step_type: 'verification', status: 'pending' },
      ],
      edges: [
        { from_step: 'model', to_step: 'tool' },
        { from_step: 'tool', to_step: 'verify' },
      ],
    },
  } as unknown as RunPlan;
}

function directConfig(overrides: Record<string, unknown> = {}) {
  return {
    strategy: 'direct' as const,
    max_iterations: 1,
    run_id: 'run-authority',
    goal: 'answer',
    clock: () => '2026-07-25T00:00:00.000Z',
    nowMs: () => 100,
    ...overrides,
  };
}

describe('LoopEngine authority boundaries', () => {
  it('strips credential-shaped environment keys and preserves unrelated keys', () => {
    const sensitive = 'AH_LOOP_AUTHORITY_API_KEY';
    const safe = 'AH_LOOP_AUTHORITY_VALUE';
    const previousSensitive = process.env[sensitive];
    const previousSafe = process.env[safe];
    process.env[sensitive] = 'secret';
    process.env[safe] = 'safe';
    try {
      expect(stripCredentialsFromEnv()).toContain(sensitive);
      expect(process.env[sensitive]).toBeUndefined();
      expect(process.env[safe]).toBe('safe');
    } finally {
      if (previousSensitive === undefined) delete process.env[sensitive];
      else process.env[sensitive] = previousSensitive;
      if (previousSafe === undefined) delete process.env[safe];
      else process.env[safe] = previousSafe;
    }
  });

  it.each([
    [{ run_id: '' }, 'run_id is required'],
    [{ run_id: '   ' }, 'run_id is required'],
    [{ goal: ' ' }, 'goal is required'],
    [{ max_iterations: -1 }, 'max_iterations must be a non-negative safe integer'],
    [{ max_iterations: 1.5 }, 'max_iterations must be a non-negative safe integer'],
    [{ budget_tokens: -1 }, 'budget_tokens must be a non-negative safe integer'],
    [{ deadline_ms: -1 }, 'deadline_ms must be a non-negative safe integer'],
    [{ max_output_tokens_per_call: -1 }, 'max_output_tokens_per_call must be a non-negative safe integer'],
    [{ max_observation_bytes: -1 }, 'max_observation_bytes must be a non-negative safe integer'],
  ])('rejects invalid config %j', (override, message) => {
    expect(() => new LoopEngine(
      directConfig(override),
      { session: session(), modelCall: async () => ({ content: '', decision_summary: '' }) },
    )).toThrow(message);
  });

  it('rejects invalid monotonic and wall clocks', async () => {
    expect(() => new LoopEngine(
      directConfig({ nowMs: () => -1 }),
      { session: session(), modelCall: async () => ({ content: '', decision_summary: '' }) },
    )).toThrow('nowMs returned an invalid timestamp');

    const loop = new LoopEngine(
      directConfig({ clock: () => 'not-a-time' }),
      {
        session: session(),
        modelCall: async () => ({ content: 'x', decision_summary: 'x' }),
      },
    );
    await expect(loop.run()).resolves.toMatchObject({
      termination_reason: 'malformed_response',
    });
  });

  it('normalizes unknown strategies and non-Error provider failures', async () => {
    const unknownSession = session('unknown-strategy');
    const unknown = new LoopEngine(
      directConfig({ strategy: 'other' as never }),
      {
        session: unknownSession,
        modelCall: async () => ({ content: '', decision_summary: '' }),
      },
    );
    const unknownResult = await unknown.run();
    expect(unknownResult.termination_reason).toBe('malformed_response');
    expect(unknownSession.getEvents().find((event) => event.type === 'error')?.data)
      .toMatchObject({
        event: 'runtime_error',
        classification: 'malformed_response',
        message: 'unknown strategy: other',
      });

    const valueSession = session('provider-value');
    const value = new LoopEngine(directConfig(), {
      session: valueSession,
      modelCall: async () => Promise.reject('offline'),
    });
    expect((await value.run()).termination_reason).toBe('provider_failure');
    expect(valueSession.getEvents().find((event) => event.type === 'error')?.data)
      .toMatchObject({ message: 'unknown runtime error' });
  });

  it('classifies an aborted provider failure as user cancellation', async () => {
    const controller = new AbortController();
    const loop = new LoopEngine(directConfig(), {
      session: session(),
      signal: controller.signal,
      modelCall: async () => {
        controller.abort();
        throw new Error('transport closed');
      },
    });
    const result = await loop.run();
    expect(result.termination_reason).toBe('user_cancel');
    expect(result.context_reset_emitted).toBe(false);
  });

  it.each([
    [{ input_tokens: -1, output_tokens: 0 }],
    [{ input_tokens: 0.5, output_tokens: 0 }],
    [{ input_tokens: 0, output_tokens: -1 }],
    [{ input_tokens: 0, output_tokens: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects invalid model usage %j', async (usage) => {
    const loop = new LoopEngine(directConfig(), {
      session: session(),
      modelCall: async () => ({
        content: '',
        decision_summary: 'invalid usage',
        usage,
      }),
    });
    const result = await loop.run();
    expect(result.termination_reason).toBe('malformed_response');
    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  });

  it('records canonical bounded observations with exact bytes and digest', async () => {
    let calls = 0;
    const payload = { z: 1, a: { value: 2n } };
    const serialized = '{"a":{"value":"2"},"z":1}';
    const loop = new LoopEngine(
      {
        ...directConfig(),
        strategy: 'react',
        max_iterations: 2,
        max_observation_bytes: Buffer.byteLength(serialized),
        run_plan: reactPlan(),
      },
      {
        session: session(),
        modelCall: async () => {
          calls += 1;
          return calls === 1
            ? {
                content: '',
                decision_summary: 'read',
                tool_calls: [
                  { id: 'read-1', name: 'read_file', arguments: { path: '/x' } },
                ],
              }
            : { content: 'done', decision_summary: 'done' };
        },
        toolExecute: async () => payload,
      },
    );
    const result = await loop.run();
    const observation = result.turns[0]!.tool_observations[0]!;
    expect(observation).toMatchObject({
      tool_call_id: 'read-1',
      name: 'read_file',
      arguments: { path: '/x' },
      status: 'ok',
      bytes: Buffer.byteLength(serialized),
      truncated: false,
      sha256: createHash('sha256').update(serialized).digest('hex'),
      result: { a: { value: '2' }, z: 1 },
    });
    expect(result.turns[0]!.tool_executed).toEqual({
      name: 'read_file',
      arguments: { path: '/x' },
      result: { a: { value: '2' }, z: 1 },
    });
  });

  it('truncates at one byte beyond the configured observation boundary', async () => {
    let calls = 0;
    const loop = new LoopEngine(
      {
        ...directConfig(),
        strategy: 'react',
        max_iterations: 2,
        max_observation_bytes: 4,
        run_plan: reactPlan(),
      },
      {
        session: session(),
        modelCall: async () => {
          calls += 1;
          return calls === 1
            ? {
                content: '',
                decision_summary: 'read',
                tool_calls: [
                  { id: 'read-1', name: 'read_file', arguments: {} },
                ],
              }
            : { content: '', decision_summary: 'done' };
        },
        toolExecute: async () => 'abc',
      },
    );
    const observation = (await loop.run()).turns[0]!.tool_observations[0]!;
    expect(observation.truncated).toBe(true);
    expect(observation.result).toEqual({
      truncated: true,
      original_bytes: 5,
      preview: '"abc',
    });
  });

  it('canonicalizes circular results and keeps the first successful compatibility result', async () => {
    let calls = 0;
    const circular: Record<string, unknown> = { value: 1 };
    circular.self = circular;
    const loop = new LoopEngine(
      {
        ...directConfig(),
        strategy: 'react',
        max_iterations: 2,
        run_plan: reactPlan(),
      },
      {
        session: session(),
        modelCall: async () => {
          calls += 1;
          return calls === 1
            ? {
                content: '',
                decision_summary: 'two reads',
                tool_calls: [
                  {
                    id: 'one',
                    name: 'read_file',
                    arguments: { path: '/one' },
                  },
                  {
                    id: 'two',
                    name: 'read_file',
                    arguments: { path: '/two' },
                  },
                ],
              }
            : { content: 'done', decision_summary: 'done' };
        },
        toolExecute: async (_name, args) =>
          args.path === '/one' ? circular : { value: 2 },
      },
    );
    const result = await loop.run();
    expect(result.turns[0]!.tool_observations[0]!.result).toEqual({
      self: '[circular]',
      value: 1,
    });
    expect(result.turns[0]!.tool_executed).toEqual({
      name: 'read_file',
      arguments: { path: '/one' },
      result: { self: '[circular]', value: 1 },
    });
  });

  it('sets compatibility output after an error and records exact assistant evidence', async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const sess = session('error-then-success');
    const loop = new LoopEngine(
      {
        ...directConfig(),
        strategy: 'react',
        max_iterations: 2,
        run_plan: reactPlan(),
      },
      {
        session: sess,
        modelCall: async () => {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                content: 'act',
                decision_summary: 'exact summary',
                usage: { input_tokens: 2, output_tokens: 3 },
                tool_calls: [
                  {
                    id: 'bad',
                    name: 'read_file',
                    arguments: { path: '/bad' },
                  },
                  {
                    id: 'good',
                    name: 'read_file',
                    arguments: { path: '/good' },
                  },
                ],
              }
            : { content: 'done', decision_summary: 'done' };
        },
        toolExecute: async (_name, args) => {
          toolCalls += 1;
          if (args.path === '/bad') throw new Error('read failed');
          return 'content';
        },
      },
    );
    const result = await loop.run();
    expect(toolCalls).toBe(2);
    expect(
      result.turns[0]!.tool_observations.map((value) => value.status),
    ).toEqual(['error', 'ok']);
    expect(result.turns[0]!.tool_executed).toEqual({
      name: 'read_file',
      arguments: { path: '/good' },
      result: 'content',
    });
    expect(
      sess.getEvents().find((event) => event.type === 'assistant')?.data,
    ).toEqual({
      decision_summary: 'exact summary',
      tool_calls: [
        { id: 'bad', name: 'read_file', arguments: { path: '/bad' } },
        { id: 'good', name: 'read_file', arguments: { path: '/good' } },
      ],
      usage: { input_tokens: 2, output_tokens: 3 },
    });
  });

  it('supports an explicit context-reset stop before execution', async () => {
    const modelCall = vi.fn(async () => ({ content: '', decision_summary: '' }));
    const loop = new LoopEngine(directConfig(), {
      session: session(),
      modelCall,
    });
    loop.stop('context_reset');
    const result = await loop.run();
    expect(result).toMatchObject({
      termination_reason: 'context_reset',
      context_reset_emitted: true,
      iterations: 0,
    });
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('drops a model result when cancellation arrives during the call', async () => {
    let loop!: LoopEngine;
    loop = new LoopEngine(directConfig(), {
      session: session(),
      modelCall: async () => {
        loop.stop('user_cancel');
        return {
          content: 'must not be recorded',
          decision_summary: 'must not be recorded',
        };
      },
    });
    const result = await loop.run();
    expect(result.termination_reason).toBe('user_cancel');
    expect(result.turns).toEqual([]);
    expect(result.decision_summaries).toEqual([]);
  });

  it('is single-use and stop is idempotent after completion', async () => {
    const loop = new LoopEngine(directConfig(), {
      session: session(),
      modelCall: async () => ({ content: 'done', decision_summary: 'done' }),
    });
    expect((await loop.run()).termination_reason).toBe('completed');
    loop.stop('user_cancel');
    await expect(loop.run()).rejects.toThrow(
      'LoopEngine instances can run exactly once',
    );
  });

  it('enforces exact deadline and budget preflight boundaries', async () => {
    const noCall = vi.fn(async () => ({
      content: '',
      decision_summary: '',
    }));
    const deadline = new LoopEngine(
      directConfig({ deadline_ms: 0 }),
      { session: session(), modelCall: noCall },
    );
    expect((await deadline.run()).termination_reason).toBe('deadline');
    expect(noCall).not.toHaveBeenCalled();

    const budget = new LoopEngine(
      directConfig({ budget_tokens: 0 }),
      { session: session(), modelCall: noCall },
    );
    expect((await budget.run()).termination_reason).toBe('budget_exhausted');
    expect(noCall).not.toHaveBeenCalled();

    const times = [100, 100];
    const observedBudgets: unknown[] = [];
    const allowed = new LoopEngine(
      directConfig({
        deadline_ms: 1,
        nowMs: () => times.shift() ?? 100,
      }),
      {
        session: session(),
        modelCall: async (_messages, _attempt, modelBudget) => {
          observedBudgets.push(modelBudget);
          return { content: 'done', decision_summary: 'done' };
        },
      },
    );
    expect((await allowed.run()).termination_reason).toBe('completed');
    expect(observedBudgets).toEqual([
      {
        remaining_tokens: Number.MAX_SAFE_INTEGER,
        max_output_tokens: 4_096,
      },
    ]);
  });

  it('writes exact progress and converts a turn-time persistence failure to internal_error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-progress-'));
    roots.push(root);
    const loop = new LoopEngine(directConfig({ data_dir: root }), {
      session: session(),
      modelCall: async () => ({
        content: 'done',
        decision_summary: 'done',
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    });
    const result = await loop.run();
    expect(result.progress_path).toBe(join(root, 'progress.json'));
    expect(JSON.parse(readFileSync(result.progress_path!, 'utf8'))).toEqual({
      run_id: 'run-authority',
      current_step: 1,
      goal: 'answer',
      completed_steps: [],
      open_tasks: [],
      last_error: null,
      checkpoint_refs: ['2026-07-25T00:00:00.000Z'],
      last_updated: '2026-07-25T00:00:00.000Z',
    });

    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const failedSession = session('progress-failure');
    const failed = new LoopEngine(directConfig({ data_dir: blocked }), {
      session: failedSession,
      modelCall: async () => ({ content: 'x', decision_summary: 'x' }),
    });
    expect((await failed.run()).termination_reason).toBe('internal_error');
    expect(
      failedSession.getEvents().find((event) => event.type === 'error')?.data,
    ).toMatchObject({
      event: 'progress_write_failed',
    });
  });

  it('persists completed and verification-pending plan states', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-plan-progress-'));
    roots.push(root);
    const loop = new LoopEngine(
      {
        ...directConfig({ data_dir: root }),
        strategy: 'plan_execute',
        max_iterations: 1,
        run_plan: planExecutePlan(),
      },
      {
        session: session(),
        modelCall: async () => ({
          content: '',
          decision_summary: 'read',
          tool_calls: [
            {
              id: 'read',
              name: 'read_file',
              arguments: { path: '/x' },
            },
          ],
        }),
        toolExecute: async () => 'content',
      },
    );
    const result = await loop.run();
    expect(result.step_states).toEqual({
      model: 'done',
      tool: 'done',
      verify: 'awaiting_verification',
    });
    const progress = JSON.parse(
      readFileSync(join(root, 'progress.json'), 'utf8'),
    );
    expect(progress.completed_steps).toEqual([
      { step: 'model', summary: 'done' },
      { step: 'tool', summary: 'done' },
    ]);
    expect(progress.open_tasks).toEqual([]);
    expect(progress.last_error).toBeNull();
  });
});
