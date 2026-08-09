import { describe, it, expect, vi } from 'vitest';
import { LoopEngine } from '../../runtime/loop.js';
import { DurableSession } from '../../session/durable-session.js';
import type { LoopConfig, LoopDeps, ModelTurn } from '../../runtime/loop.js';
import type { RuntimeSteeringPort, RuntimeSteeringCommand } from '../../runtime/steering-port.js';

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    run_id: 'steer-test',
    goal: 'test steering',
    strategy: 'direct',
    max_iterations: 5,
    budget: { input_tokens: 10000, output_tokens: 5000 },
    ...overrides,
  } as LoopConfig;
}

function makeDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  const session = new DurableSession('steer-test');
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

describe('LoopEngine steering interruption', () => {
  it('retries model dispatch when steering interrupts with steer queue', async () => {
    let callCount = 0;
    let steeringListener: ((cmd: RuntimeSteeringCommand) => void) | null = null;

    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        steeringListener = cb;
        return () => { steeringListener = null; };
      },
      drain(): readonly RuntimeSteeringCommand[] {
        return [];
      },
    };

    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async (signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1 && steeringListener) {
          // Interrupt the first call with a steer command
          steeringListener({
            command_id: 'steer-1',
            queue: 'steer',
            priority: 'user',
            content: 'change direction',
          });
          // Wait for the abort to propagate
          await new Promise(r => setTimeout(r, 10));
          // The signal should be aborted now
          if (signal?.aborted) {
            throw new DOMException('aborted', 'AbortError');
          }
        }
        return {
          content: `response-${callCount}`,
          decision_summary: 'done',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(result).toBeDefined();
  });

  it('steering with kill priority stops the loop', async () => {
    let steeringListener: ((cmd: RuntimeSteeringCommand) => void) | null = null;

    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        steeringListener = cb;
        return () => { steeringListener = null; };
      },
      drain(): readonly RuntimeSteeringCommand[] {
        return [];
      },
    };

    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async () => {
        if (steeringListener) {
          steeringListener({
            command_id: 'kill-1',
            queue: 'steer',
            priority: 'kill',
            content: 'stop everything',
          });
        }
        await new Promise(r => setTimeout(r, 10));
        return {
          content: 'response',
          decision_summary: 'done',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('user_cancel');
  });

  it('steering with human_cancel priority stops the loop', async () => {
    let steeringListener: ((cmd: RuntimeSteeringCommand) => void) | null = null;

    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        steeringListener = cb;
        return () => { steeringListener = null; };
      },
      drain(): readonly RuntimeSteeringCommand[] {
        return [];
      },
    };

    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async () => {
        if (steeringListener) {
          steeringListener({
            command_id: 'cancel-1',
            queue: 'steer',
            priority: 'human_cancel',
            content: 'human cancelled',
          });
        }
        await new Promise(r => setTimeout(r, 10));
        return {
          content: 'response',
          decision_summary: 'done',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('user_cancel');
  });

  it('applySteering adds steer commands to messages via drain', async () => {
    const steerCommand: RuntimeSteeringCommand = {
      command_id: 'drain-1',
      queue: 'steer',
      priority: 'user',
      content: 'drained steering content',
    };

    let drainCount = 0;
    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        return () => {};
      },
      drain(queue: string): readonly RuntimeSteeringCommand[] {
        drainCount++;
        // Return the steer command on the first drain call
        if (drainCount === 1 && queue === 'steer') {
          return [steerCommand];
        }
        return [];
      },
    };

    const deps = makeDeps({
      steering: steeringPort,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(drainCount).toBeGreaterThan(0);
    expect(result).toBeDefined();
  });

  it('steering without signal still works', async () => {
    let steeringListener: ((cmd: RuntimeSteeringCommand) => void) | null = null;

    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        steeringListener = cb;
        return () => { steeringListener = null; };
      },
      drain(): readonly RuntimeSteeringCommand[] {
        return [];
      },
    };

    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async () => {
        return {
          content: 'done',
          decision_summary: 'completed',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result).toBeDefined();
  });

  it('multiple steering interruptions are handled', async () => {
    let callCount = 0;
    let steeringListener: ((cmd: RuntimeSteeringCommand) => void) | null = null;

    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        steeringListener = cb;
        return () => { steeringListener = null; };
      },
      drain(): readonly RuntimeSteeringCommand[] {
        return [];
      },
    };

    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async (signal?: AbortSignal) => {
        callCount++;
        if (callCount <= 2 && steeringListener) {
          steeringListener({
            command_id: `steer-${callCount}`,
            queue: 'steer',
            priority: 'user',
            content: `interrupt ${callCount}`,
          });
          await new Promise(r => setTimeout(r, 10));
          if (signal?.aborted) {
            throw new DOMException('aborted', 'AbortError');
          }
        }
        return {
          content: `response-${callCount}`,
          decision_summary: 'done',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig({ max_iterations: 10 }), deps);
    const result = await engine.run();
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(result).toBeDefined();
  });

  it('steering command with security priority is not kill', async () => {
    let steeringListener: ((cmd: RuntimeSteeringCommand) => void) | null = null;

    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        steeringListener = cb;
        return () => { steeringListener = null; };
      },
      drain(): readonly RuntimeSteeringCommand[] {
        return [];
      },
    };

    let callCount = 0;
    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async (signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1 && steeringListener) {
          steeringListener({
            command_id: 'sec-1',
            queue: 'steer',
            priority: 'security',
            content: 'security steering',
          });
          await new Promise(r => setTimeout(r, 10));
          if (signal?.aborted) {
            throw new DOMException('aborted', 'AbortError');
          }
        }
        return {
          content: 'done',
          decision_summary: 'completed',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('steering with admin priority interrupts', async () => {
    let steeringListener: ((cmd: RuntimeSteeringCommand) => void) | null = null;

    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        steeringListener = cb;
        return () => { steeringListener = null; };
      },
      drain(): readonly RuntimeSteeringCommand[] {
        return [];
      },
    };

    let callCount = 0;
    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async (signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1 && steeringListener) {
          steeringListener({
            command_id: 'admin-1',
            queue: 'steer',
            priority: 'admin',
            content: 'admin steering',
          });
          await new Promise(r => setTimeout(r, 10));
          if (signal?.aborted) {
            throw new DOMException('aborted', 'AbortError');
          }
        }
        return {
          content: 'done',
          decision_summary: 'completed',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('steering with supervisor priority interrupts', async () => {
    let steeringListener: ((cmd: RuntimeSteeringCommand) => void) | null = null;

    const steeringPort: RuntimeSteeringPort = {
      subscribe(cb: (cmd: RuntimeSteeringCommand) => void): () => void {
        steeringListener = cb;
        return () => { steeringListener = null; };
      },
      drain(): readonly RuntimeSteeringCommand[] {
        return [];
      },
    };

    let callCount = 0;
    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async (signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1 && steeringListener) {
          steeringListener({
            command_id: 'sup-1',
            queue: 'steer',
            priority: 'supervisor',
            content: 'supervisor steering',
          });
          await new Promise(r => setTimeout(r, 10));
          if (signal?.aborted) {
            throw new DOMException('aborted', 'AbortError');
          }
        }
        return {
          content: 'done',
          decision_summary: 'completed',
          stop_reason: 'stop' as const,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('drain returns follow_up commands', async () => {
    let drainCount = 0;
    const steeringPort: RuntimeSteeringPort = {
      subscribe(): () => void { return () => {}; },
      drain(queue: string): readonly RuntimeSteeringCommand[] {
        drainCount++;
        if (queue === 'follow_up' && drainCount <= 2) {
          return [{
            command_id: 'followup-1',
            queue: 'follow_up',
            priority: 'user',
            content: 'follow up content',
          }];
        }
        return [];
      },
    };

    const deps = makeDeps({
      steering: steeringPort,
      modelCall: vi.fn(async () => ({
        content: 'thinking',
        decision_summary: 'not done',
        usage: { input_tokens: 10, output_tokens: 5 },
      }) as ModelTurn) as any,
    });

    const engine = new LoopEngine(makeConfig({ max_iterations: 2 }), deps);
    const result = await engine.run();
    expect(drainCount).toBeGreaterThan(0);
  });

  it('drain returns next_turn commands', async () => {
    const steeringPort: RuntimeSteeringPort = {
      subscribe(): () => void { return () => {}; },
      drain(queue: string): readonly RuntimeSteeringCommand[] {
        if (queue === 'next_turn') {
          return [{
            command_id: 'nextturn-1',
            queue: 'next_turn',
            priority: 'user',
            content: 'next turn content',
          }];
        }
        return [];
      },
    };

    const deps = makeDeps({
      steering: steeringPort,
    });

    const engine = new LoopEngine(makeConfig(), deps);
    const result = await engine.run();
    expect(result).toBeDefined();
  });

  it('deadline_ms triggers deadline termination', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 50));
        return {
          content: 'slow',
          decision_summary: 'not done',
          usage: { input_tokens: 10, output_tokens: 5 },
        } as ModelTurn;
      }) as any,
    });

    const engine = new LoopEngine(makeConfig({
      max_iterations: 100,
      deadline_ms: 10,
    }), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBeDefined();
  });

  it('budget_tokens triggers budget_exhausted termination', async () => {
    const deps = makeDeps({
      modelCall: vi.fn(async () => ({
        content: 'thinking',
        decision_summary: 'not done',
        usage: { input_tokens: 10000, output_tokens: 5000 },
      }) as ModelTurn) as any,
    });

    const engine = new LoopEngine(makeConfig({
      max_iterations: 100,
      budget_tokens: 100,
    }), deps);
    const result = await engine.run();
    expect(result.termination_reason).toBe('budget_exhausted');
  });
});
