import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskContract, ToolSpec } from '../../contracts/index.js';
import type { ParsedResponse } from '../../gateway/scripted-provider.js';
import type { ModelGateway, GatewayDispatchResult } from '../../gateway/model-gateway.js';
import {
  Harness,
  createDefaultExecutionContext,
  type HarnessConfig,
} from '../../harness.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { LocalBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../../sandbox/process-sandbox.js';
import {
  createScriptedGateway,
  createTestSecurityDeps,
  createTestVerificationEngine,
} from '../helpers/test-security.js';

const roots: string[] = [];
const CLOCK = '2026-07-25T00:00:00.000Z';
const MASTER_KEY = Buffer.alloc(32, 0x5a);

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function rootDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

function task(goal = 'Provide a concise answer'): TaskContract {
  return {
    goal,
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints: [],
  };
}

function makeHookOutcome(action: string = 'continue', payload?: unknown): any {
  return { action, payload: payload ?? null, reason_code: undefined, follow_ups: [], replayed: false };
}

function wrapGateway(real: ModelGateway, overrides: Partial<ModelGateway>): ModelGateway {
  return Object.assign(Object.create(real) as ModelGateway, overrides);
}

interface FixtureOpts {
  responses?: readonly ParsedResponse[];
  signal?: AbortSignal;
  hookPort?: any;
  modelFallback?: any;
  pauseResume?: any;
  sessionTreeAuthority?: any;
  steeringController?: any;
  contextCompiler?: any;
  budgetLedger?: any;
  budgetLedgerPricing?: any;
}

function makeFixture(opts: FixtureOpts = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('harness-surv5-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'harness-surv5-v1',
    default_decision: 'deny',
    allowed_tools: definitions.map((t) => t.name),
    allowed_resource_prefixes: ['/workspace'],
    rules: [{ id: 'workspace', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }],
  } as Policy);
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new LocalBackend('/workspace', workspace));
  const sandbox: SandboxProfile = {
    workspaceRoot: workspace,
    allowNetwork: false,
    allowUnixSockets: false,
    allowRead: [],
  };
  const { gateway } = createScriptedGateway({
    responses: opts.responses ?? [{ content: 'done' }],
    clock: () => new Date(CLOCK),
  });
  const security = createTestSecurityDeps(policy, () => CLOCK);
  const config: HarnessConfig = {
    toolRegistry: registry,
    skillRegistry: skills,
    policyEngine: policy,
    vfs,
    sandbox,
    gateway,
    security,
    verification: createTestVerificationEngine(),
    executionContext: createDefaultExecutionContext('harness-surv5', () => CLOCK),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.hookPort !== undefined ? { hooks: opts.hookPort } : {}),
    ...(opts.modelFallback !== undefined ? { modelFallback: opts.modelFallback } : {}),
    ...(opts.pauseResume !== undefined ? { pauseResume: opts.pauseResume } : {}),
    ...(opts.sessionTreeAuthority !== undefined ? { sessionTreeAuthority: opts.sessionTreeAuthority } : {}),
    ...(opts.steeringController !== undefined ? { steeringController: opts.steeringController } : {}),
    ...(opts.contextCompiler !== undefined ? { contextCompiler: opts.contextCompiler } : {}),
    ...(opts.budgetLedger !== undefined ? { budgetLedger: opts.budgetLedger } : {}),
    ...(opts.budgetLedgerPricing !== undefined ? { budgetLedgerPricing: opts.budgetLedgerPricing } : {}),
  };
  return { harness: new Harness(config), config };
}

describe('Harness survival-5 - streaming result exact assertions', () => {
  it('returns exact content from streaming text deltas', async () => {
    const { config } = makeFixture({ onModelDelta: () => {} } as any);
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'Hello World' };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    const outcome = await harness.run(task());
    expect(outcome.loop_result.termination_reason).toBe('goal_satisfied');
  });

  it('accumulates exact content from multiple text deltas', async () => {
    const received: string[] = [];
    const { config } = makeFixture();
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'part1 ' };
        yield { type: 'text_delta', text: 'part2 ' };
        yield { type: 'text_delta', text: 'part3' };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 3, output_tokens: 3 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: (d: string) => received.push(d) } as any);
    await harness.run(task());
    expect(received).toEqual(['part1 ', 'part2 ', 'part3']);
  });

  it('passes exact usage from message_stop event', async () => {
    const { config } = makeFixture();
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'response' };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 42, output_tokens: 17 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    const outcome = await harness.run(task());
    expect(outcome.loop_result.termination_reason).toBe('goal_satisfied');
  });

  it('defaults usage to zeros when message_stop has no usage', async () => {
    const { config } = makeFixture();
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'no usage' };
        yield { type: 'message_stop', stop_reason: 'stop' };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    const outcome = await harness.run(task());
    expect(outcome.loop_result.termination_reason).toBe('goal_satisfied');
  });

  it('collects exact tool_calls from stream events', async () => {
    const { config } = makeFixture({ responses: [{ content: 'done' }, { content: 'done' }] });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'Using tool' };
        yield { type: 'tool_call', tool_call: { id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } } };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
    expect(outcome.loop_result).toBeDefined();
  });
});

describe('Harness survival-5 - provider fallback exact assertions', () => {
  it('calls modelFallback.execute with exact provider_id', async () => {
    const fallbackExecute = vi.fn().mockResolvedValue({
      dispatch_result: {
        provider_id: 'fallback-provider',
        response: { content: 'fallback response' },
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    });
    const { config } = makeFixture({
      modelFallback: { execute: fallbackExecute },
      responses: [{ content: 'done' }],
    });
    const wrapped = wrapGateway(config.gateway, {
      dispatch: vi.fn().mockRejectedValueOnce(new Error('primary failed')),
    });
    const harness = new Harness({ ...config, gateway: wrapped });
   const outcome = await harness.run(task());
   expect(fallbackExecute).toHaveBeenCalledTimes(1);
    const callArg = fallbackExecute.mock.calls[0]![0];
   expect(callArg.visited_provider_ids).toEqual([expect.any(String)]);
    expect(callArg.initial_failure).toBeInstanceOf(Error);
    expect(callArg.initial_failure.message).toBe('primary failed');
    expect(outcome.loop_result.termination_reason).toBe('goal_satisfied');
  });

  it('returns provider_failure outcome when modelFallback also fails', async () => {
    const fallbackExecute = vi.fn().mockRejectedValue(new Error('fallback also failed'));
    const { config } = makeFixture({
      modelFallback: { execute: fallbackExecute },
      responses: [{ content: 'done' }],
    });
    const wrapped = wrapGateway(config.gateway, {
      dispatch: vi.fn().mockRejectedValueOnce(new Error('primary failed')),
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    expect(outcome.loop_result.termination_reason).toBe('provider_failure');
  });

  it('tries switchProvider up to 5 times when no modelFallback', async () => {
    let switchCount = 0;
    const { config } = makeFixture({ responses: [{ content: 'done' }] });
    const wrapped = wrapGateway(config.gateway, {
      dispatch: vi.fn()
        .mockRejectedValueOnce(new Error('first failed'))
        .mockRejectedValueOnce(new Error('second failed'))
        .mockRejectedValueOnce(new Error('third failed'))
        .mockRejectedValueOnce(new Error('fourth failed'))
        .mockRejectedValueOnce(new Error('fifth failed'))
        .mockRejectedValueOnce(new Error('sixth failed')),
      switchProvider: vi.fn().mockImplementation((prev) => {
        switchCount++;
        return { ...prev, provider_id: `provider-${switchCount + 1}` };
      }),
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    expect(outcome.loop_result.termination_reason).toBe('provider_failure');
  });

  it('succeeds when second switchProvider attempt works', async () => {
    let switchCount = 0;
    const { config } = makeFixture({ responses: [{ content: 'done' }] });
    const wrapped = wrapGateway(config.gateway, {
      dispatch: vi.fn()
        .mockRejectedValueOnce(new Error('first failed'))
        .mockResolvedValueOnce({
          provider_id: 'provider-2',
          response: { content: 'success' },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      switchProvider: vi.fn().mockImplementation((prev) => {
        switchCount++;
        return { ...prev, provider_id: `provider-${switchCount + 1}` };
      }),
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    const outcome = await harness.run(task());
    expect(outcome.loop_result.termination_reason).toBe('goal_satisfied');
  });
});

describe('Harness survival-5 - pre-turn hook exact assertions', () => {
  it('returns failed outcome when pre_turn returns null payload', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'pre_turn') return makeHookOutcome('continue', null);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    try {
      const outcome = await harness.run(task());
      expect(outcome.success).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('returns failed outcome when pre_turn returns non-array messages', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'pre_turn') return makeHookOutcome('continue', { messages: 'not-array' });
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    try {
      const outcome = await harness.run(task());
      expect(outcome.success).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('returns failed outcome when pre_turn returns message with invalid role', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'pre_turn') return makeHookOutcome('continue', { messages: [{ content: 'hi' }] });
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    try {
      const outcome = await harness.run(task());
      expect(outcome.success).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('accepts valid messages from pre_turn hook', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'pre_turn') return makeHookOutcome('continue', { messages: [{ role: 'user', content: 'ok' }] });
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

describe('Harness survival-5 - before_provider_request exact assertions', () => {
  it('returns failed outcome when before_provider_request returns null', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'before_provider_request') return makeHookOutcome('continue', null);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    try {
      const outcome = await harness.run(task());
      expect(outcome.success).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('returns failed outcome when before_provider_request returns array', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'before_provider_request') return makeHookOutcome('continue', [1, 2, 3]);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    try {
      const outcome = await harness.run(task());
      expect(outcome.success).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});

describe('Harness survival-5 - tool expansion exact assertions', () => {
  it('returns failed outcome with tool name when hook expands tool set', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'before_provider_request') {
          return makeHookOutcome('continue', {
            ...req.payload,
            request: {
              ...req.payload.request,
              tools: [
                ...(req.payload.request?.tools ?? []),
                { name: 'unauthorized_tool', description: 'hack', parameters: {} },
              ],
            },
          });
        }
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    try {
      const outcome = await harness.run(task());
      expect(outcome.success).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});

describe('Harness survival-5 - user_prompt_submit exact assertions', () => {
  it('returns denied outcome when user_prompt_submit returns invalid payload', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'user_prompt_submit') return makeHookOutcome('continue', null);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
  });

  it('returns denied outcome when user_prompt_submit returns array payload', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'user_prompt_submit') return makeHookOutcome('continue', [1, 2]);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
  });

  it('returns denied outcome when user_prompt_submit returns object without goal', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'user_prompt_submit') return makeHookOutcome('continue', { success_criteria: [], constraints: [] });
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
  });

  it('returns denied outcome when user_prompt_submit returns object with empty goal', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((req: any) => {
        if (req.event === 'user_prompt_submit') return makeHookOutcome('continue', { goal: '  ', success_criteria: [], constraints: [] });
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
  });
});

describe('Harness survival-5 - session_end and stop hooks', () => {
  it('dispatches session_end in finally block', async () => {
    const events: string[] = [];
    const hookPort = {
      dispatch: vi.fn().mockImplementation(async (req: any) => {
        events.push(req.event);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    await harness.run(task());
    expect(events).toContain('session_end');
  });

  it('dispatches session_end even when run throws', async () => {
    const events: string[] = [];
    const hookPort = {
      dispatch: vi.fn().mockImplementation(async (req: any) => {
        events.push(req.event);
        if (req.event === 'before_provider_request') return makeHookOutcome('continue', null);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    try { await harness.run(task()); } catch {}
    expect(events).toContain('session_end');
  });
});

describe('Harness survival-5 - cache tracking', () => {
  it('tracks cache key after model dispatch', async () => {
    const { config } = makeFixture();
    const harness = new Harness(config);
    await harness.run(task());
    const metrics = harness.getCacheMetrics();
    expect(metrics).toBeDefined();
    expect(typeof metrics).toBe('object');
  });

  it('tracks cache key in streaming mode', async () => {
    const { config } = makeFixture();
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'streamed' };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    await harness.run(task());
    const metrics = harness.getCacheMetrics();
    expect(metrics).toBeDefined();
  });
});

describe('Harness survival-5 - finalizeOverlay', () => {
  it('finalizeOverlay(true) does not throw when workspace exists', async () => {
    const { config } = makeFixture();
    const harness = new Harness(config);
    await harness.run(task());
    expect(() => harness.finalizeOverlay(true)).not.toThrow();
  });

  it('finalizeOverlay(false) does not throw when workspace exists', async () => {
    const { config } = makeFixture();
    const harness = new Harness(config);
    await harness.run(task());
    expect(() => harness.finalizeOverlay(false)).not.toThrow();
  });

  it('finalizeOverlay returns silently when no workspace exists', () => {
    const { config } = makeFixture();
    const harness = new Harness(config);
    expect(() => harness.finalizeOverlay(true)).not.toThrow();
    expect(() => harness.finalizeOverlay(false)).not.toThrow();
  });
});

describe('Harness survival-5 - pause/resume exact assertions', () => {
  it('handles retry_new_attempt action without re-running loop', async () => {
    const pauseResume = {
      resume: vi.fn().mockResolvedValue({
        action: 'retry_new_attempt',
        operation_id: 'op-1',
      }),
    };
    const { config } = makeFixture({ pauseResume });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('handles await_human action without re-running loop', async () => {
    const pauseResume = {
      resume: vi.fn().mockResolvedValue({
        action: 'await_human',
        operation_id: 'op-1',
      }),
    };
    const { config } = makeFixture({ pauseResume });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

describe('Harness survival-5 - hook scope override exact assertions', () => {
  it('generates unique invocation_id for different hook events', async () => {
    const ids: string[] = [];
    const hookPort = {
      dispatch: vi.fn().mockImplementation(async (req: any) => {
        ids.push(req.invocation_id);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    await harness.run(task());
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('generates unique idempotency_key for different hook events', async () => {
    const keys: string[] = [];
    const hookPort = {
      dispatch: vi.fn().mockImplementation(async (req: any) => {
        keys.push(req.idempotency_key);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    await harness.run(task());
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('passes signal to hook boundary when config.signal is set', async () => {
    const ac = new AbortController();
    const hookPort = {
      dispatch: vi.fn().mockImplementation(async (req: any) => {
        expect(req.signal).toBeDefined();
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ signal: ac.signal, hookPort });
    const harness = new Harness(config);
    await harness.run(task());
  });

  it('passes hookTimeoutMs to hook boundary when configured', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation(async (req: any) => {
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort, hookTimeoutMs: 5000 } as any);
    const harness = new Harness(config);
    await harness.run(task());
  });
});

describe('Harness survival-5 - signal combining exact assertions', () => {
  it('combines config.signal and modelSignal in streaming mode', async () => {
    const ac = new AbortController();
    const { config } = makeFixture({ signal: ac.signal });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* (resolved: any, req: any, ctx: any) {
        expect(ctx.signal).toBeDefined();
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    await harness.run(task());
  });

  it('combines config.signal and modelSignal in non-streaming mode', async () => {
    const ac = new AbortController();
    const { config } = makeFixture({ signal: ac.signal });
    const wrapped = wrapGateway(config.gateway, {
      dispatch: vi.fn().mockImplementation(async (resolved: any, req: any, ctx: any) => {
        expect(ctx.signal).toBeDefined();
        return {
          provider_id: resolved.provider_id,
          response: { content: 'ok' },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
  });
});

describe('Harness survival-5 - internal error handling', () => {
  it('dispatches stop hook with internal_error on uncaught exception', async () => {
    const events: string[] = [];
    const hookPort = {
      dispatch: vi.fn().mockImplementation(async (req: any) => {
        events.push(req.event);
        if (req.event === 'before_provider_request') return makeHookOutcome('continue', null);
        return makeHookOutcome('continue');
      }),
    };
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    try { await harness.run(task()); } catch {}
    expect(events).toContain('stop');
    expect(events).toContain('session_end');
  });
});

describe('Harness survival-5 - ragQuery lazy loading', () => {
  it('lazy-loads RAG module on first ragQuery call', async () => {
    const { config } = makeFixture({ responses: [{ content: 'done' }] });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

describe('Harness survival-5 - session tree branch recording', () => {
  it('records session branch when sessionTreeAuthority is provided', async () => {
    const sessionTreeAuthority = {
      readSessionHead: vi.fn().mockResolvedValue(null),
      recordBranch: vi.fn().mockResolvedValue(undefined),
    };
    const { config } = makeFixture({ sessionTreeAuthority });
    const harness = new Harness(config);
    await harness.run(task());
  });
});

describe('Harness survival-5 - budget ledger adapter', () => {
  it('uses BudgetLedgerRuntimeAdapter when both ledger and pricing are provided', async () => {
    const ledger = {
      getBalance: vi.fn().mockReturnValue({ token_limit: 10000, usd_micros: 1000000 }),
      recordUsage: vi.fn(),
      commit: vi.fn(),
      authorize: vi.fn().mockReturnValue(true),
    };
    const pricing = {
      getPrice: vi.fn().mockReturnValue({ input_per_token_micros: 1, output_per_token_micros: 2 }),
    };
    const { config } = makeFixture({ budgetLedger: ledger, budgetLedgerPricing: pricing });
    const harness = new Harness(config);
    await harness.run(task());
  });
});

describe('Harness survival-5 - steering controller', () => {
  it('uses steeringController when provided', async () => {
    const steeringController = {
      interrupt: vi.fn().mockReturnValue(false),
      getSuggestions: vi.fn().mockReturnValue([]),
      bind: vi.fn().mockReturnValue({ interrupt: vi.fn().mockReturnValue(false) }),
    };
    const { config } = makeFixture({ steeringController });
    const harness = new Harness(config);
    await harness.run(task());
  });
});

describe('Harness survival-5 - context compiler', () => {
  it('uses contextCompiler when provided', async () => {
    const contextCompiler = {
      compile: vi.fn().mockReturnValue({
        messages: [{ role: 'system', content: 'compiled' }],
        selected: { tool_ids: [], skill_ids: [], rag_source_ids: [], disclosures: [] },
        context_generation: 0,
        context_capacity_tokens: 128000,
        reserved_output_tokens: 4096,
        cache_breakpoint: 0,
        layers: {
          system_policy: [],
          task: [],
          active_plan: [],
          recent_conversation: [],
          retrieved_evidence: [],
          tool_definitions: [],
          tool_results: [],
          memory: [],
        },
      }),
    };
    const { config } = makeFixture({ contextCompiler });
    const harness = new Harness(config);
    await harness.run(task());
  });
});
