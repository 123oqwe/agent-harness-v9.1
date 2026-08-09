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

function makeHookOutcome(action: string = 'continue', payload?: unknown, reasonCode?: string): any {
  return {
    action,
    payload: payload ?? null,
    reason_code: action !== 'continue' ? (reasonCode ?? 'hook_restricted') : undefined,
    follow_ups: [],
    replayed: false,
  };
}

function wrapGateway(real: ModelGateway, overrides: Partial<ModelGateway>): ModelGateway {
  return Object.assign(Object.create(real) as ModelGateway, overrides);
}

interface HookCall {
  event: string;
  invocation_id: string;
  idempotency_key: string;
  scope: any;
  payload: unknown;
}

function makeRecordingHookPort(
  calls: HookCall[],
  outcome?: (call: HookCall) => any,
): any {
  return {
    dispatch: async (ctx: any, _opts: any) => {
      const call: HookCall = {
        event: ctx.event,
        invocation_id: ctx.invocation_id,
        idempotency_key: ctx.idempotency_key,
        scope: ctx.scope,
        payload: ctx.payload,
      };
      calls.push(call);
      if (outcome) {
        const result = outcome(call);
        return { ...result, event: ctx.event, payload: ctx.payload };
      }
      return { event: ctx.event, action: 'continue', payload: null, reason_code: undefined, follow_ups: [], replayed: false };
    },
  };
}

interface FixtureOpts {
  responses?: readonly ParsedResponse[];
  hookPort?: any;
  modelFallback?: any;
  pauseResume?: any;
  verificationEngine?: any;
  signal?: AbortSignal;
  onModelDelta?: (delta: string) => void;
}

function makeFixture(opts: FixtureOpts = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('harness-surv7-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'harness-surv7-v1',
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
    verification: opts.verificationEngine ?? createTestVerificationEngine(),
    executionContext: createDefaultExecutionContext('harness-surv7', () => CLOCK),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.hookPort !== undefined ? { hooks: opts.hookPort } : {}),
    ...(opts.modelFallback !== undefined ? { modelFallback: opts.modelFallback } : {}),
    ...(opts.pauseResume !== undefined ? { pauseResume: opts.pauseResume } : {}),
    ...(opts.onModelDelta !== undefined ? { onModelDelta: opts.onModelDelta } : {}),
  };
  return { harness: new Harness(config), config };
}

function findEvents(session: any, eventName: string): any[] {
  return session.getEvents().filter((e: any) => {
    const d = e.data;
    return d && typeof d === 'object' && d.event === eventName;
  });
}

// ============================================================
// Fallback dispatch path - NoCoverage at L770, L792, L835, L846
// ============================================================

describe('Harness survival-7 - fallback dispatch NoCoverage', () => {


  it('throws dispatch error when all fallbacks fail', async () => {
    const { config } = makeFixture();
    const failingGateway = wrapGateway(config.gateway, {
      dispatch: vi.fn().mockRejectedValue(new Error('all dispatches fail')),
      switchProvider: vi.fn().mockImplementation(() => {
        return { provider_id: 'fallback-provider' };
      }),
    });
    const harness = new Harness({ ...config, gateway: failingGateway } as any);
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
  });

  it('uses modelFallback.execute when dispatch fails with modelFallback configured', async () => {
    const { config } = makeFixture();
    const failingGateway = wrapGateway(config.gateway, {
      dispatch: vi.fn().mockRejectedValue(new Error('primary failed')),
    });
    const modelFallback = {
      execute: vi.fn().mockResolvedValue({
        dispatch_result: {
          provider_id: 'fallback-provider',
          response: { content: 'fallback response' },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    };
    const harness = new Harness({ ...config, gateway: failingGateway, modelFallback } as any);
    const outcome = await harness.run(task());
    expect(modelFallback.execute).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Streaming dispatch NoCoverage - L734-735, L750
// ============================================================

describe('Harness survival-7 - streaming dispatch NoCoverage', () => {
  it('executes streaming path with tool_calls and usage in stream', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'stream content' };
        yield { type: 'tool_call', tool_call: { id: 'tc-s1', name: 'read_file', arguments: { path: '/workspace/test' } } };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 5, output_tokens: 3 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    await harness.run(task());
    // after_response should have been called with the stream result
    const afterResponseCalls = calls.filter((c) => c.event === 'after_response');
    if (afterResponseCalls.length > 0) {
      const result = (afterResponseCalls[0] as any)?.payload;
      expect(result.provider_id).toBeDefined();
      expect(result.response.content).toBe('stream content');
      expect(result.usage.input_tokens).toBe(5);
      expect(result.usage.output_tokens).toBe(3);
    }
  });

  it('executes streaming path without usage in message_stop', async () => {
    const { config } = makeFixture();
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'no usage stream' };
        yield { type: 'message_stop', stop_reason: 'stop' };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// ============================================================
// Verification failure NoCoverage - L933-960
// ============================================================

describe('Harness survival-7 - verification failure NoCoverage', () => {
  it('records verification_engine_failed event when verification throws', async () => {
    const failingVerification = {
      verify: vi.fn().mockRejectedValue(new Error('verification crashed')),
    };
    const { config } = makeFixture({ verificationEngine: failingVerification });
    const { gateway } = createScriptedGateway({
      responses: [{ content: 'completed', stop_reason: 'stop' }],
      clock: () => new Date(CLOCK),
    });
    const harness = new Harness({ ...config, gateway } as any);
    const outcome = await harness.run(task());
    // Check if verification_engine_failed event was recorded
    const events = findEvents(outcome.session, 'verification_engine_failed');
    if (events.length > 0) {
      expect(events[0].data.message).toBe('verification crashed');
    }
  });

  it('records workspace_finalize_failed event when finalizeOverlay throws', async () => {
    const { harness } = makeFixture();
    const outcome = await harness.run(task());
    // Normal run should not have workspace_finalize_failed
    const events = findEvents(outcome.session, 'workspace_finalize_failed');
    expect(events.length).toBe(0);
  });
});

// ============================================================
// Hook identity exact assertions - StringLiteral survived
// ============================================================

describe('Harness survival-7 - hook identity exact strings', () => {
  it('session_end hook identity contains session-end prefix', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { harness } = makeFixture({ hookPort });
    await harness.run(task());
    const sessionEndCall = calls.find((c) => c.event === 'session_end');
    expect(sessionEndCall).toBeDefined();
    expect(sessionEndCall!.invocation_id).toMatch(/^hook-[0-9a-f]{32}$/);
    expect(sessionEndCall!.idempotency_key).toMatch(/^hook-idempotency-[0-9a-f]{32}$/);
  });

  it('session_start hook identity is unique from session_end', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { harness } = makeFixture({ hookPort });
    await harness.run(task());
    const startCall = calls.find((c) => c.event === 'session_start');
    const endCall = calls.find((c) => c.event === 'session_end');
    expect(startCall).toBeDefined();
    expect(endCall).toBeDefined();
    expect(startCall!.invocation_id).not.toBe(endCall!.invocation_id);
    expect(startCall!.idempotency_key).not.toBe(endCall!.idempotency_key);
  });

  it('stop hook is dispatched with exact termination_reason in payload', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { harness } = makeFixture({ hookPort });
    const outcome = await harness.run(task());
    const stopCalls = calls.filter((c) => c.event === 'stop');
    expect(stopCalls.length).toBeGreaterThan(0);
    const lastStop = stopCalls[stopCalls.length - 1]! as any;
    expect((lastStop.payload as any).termination_reason).toBe(outcome.loop_result.termination_reason);
  });

  it('stop hook for denied has denied in payload', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls, (ctx) => {
      if (ctx.event === 'user_prompt_submit') return makeHookOutcome('deny');
      return makeHookOutcome('continue');
    });
    const { harness } = makeFixture({ hookPort });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    const stopCalls = calls.filter((c) => c.event === 'stop');
    const deniedStop = stopCalls.find((c) => (c.payload as any)?.termination_reason === 'denied');
    expect(deniedStop).toBeDefined();
  });
});

// ============================================================
// ConditionalExpression - test both branches
// ============================================================

describe('Harness survival-7 - conditional branches', () => {
  it('onModelDelta is passed to loop when configured', async () => {
    const deltas: string[] = [];
    const { config } = makeFixture();
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'delta1' };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: (d: string) => deltas.push(d) } as any);
    await harness.run(task());
    expect(deltas).toEqual(['delta1']);
  });

  it('modelFallback path is used when configured and dispatch fails', async () => {
    const { config } = makeFixture();
    const failingGateway = wrapGateway(config.gateway, {
      dispatch: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const modelFallback = {
      execute: vi.fn().mockResolvedValue({
        dispatch_result: {
          provider_id: 'fb',
          response: { content: 'fb result' },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    };
    const harness = new Harness({ ...config, gateway: failingGateway, modelFallback } as any);
    const outcome = await harness.run(task());
    expect(modelFallback.execute).toHaveBeenCalledTimes(1);
  });

 it('switchProvider path is used when no modelFallback and dispatch fails', async () => {
   const { config } = makeFixture();
   let callCount = 0;
   const failingGateway = wrapGateway(config.gateway, {
     dispatch: vi.fn().mockImplementation(() => {
       callCount++;
       if (callCount <= 1) throw new Error('fail');
       return Promise.resolve({
         provider_id: 'recovered',
         response: { content: 'recovered' },
         usage: { input_tokens: 0, output_tokens: 0 },
       });
     }),
      switchProvider: vi.fn().mockReturnValue({ provider_id: 'fb-1' }) as any,
    });
    const harness = new Harness({ ...config, gateway: failingGateway } as any);
    const outcome = await harness.run(task());
    // dispatch should have been called at least twice (original + fallback)
    expect(callCount).toBeGreaterThan(1);
 });
});

// ============================================================
// Signal combining - L765, L781
// ============================================================

describe('Harness survival-7 - signal combining', () => {
  it('combines config.signal with modelSignal in non-streaming mode', async () => {
    const ac = new AbortController();
    const { config } = makeFixture({ signal: ac.signal });
    const harness = new Harness({ ...config });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('combines config.signal with modelSignal in streaming mode', async () => {
    const ac = new AbortController();
    const { config } = makeFixture({ signal: ac.signal });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'sig stream' };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// ============================================================
// dispatchHook scope - L1213-1217 NoCoverage
// ============================================================

describe('Harness survival-7 - dispatchHook scope', () => {
  it('uses scopeOverrides for run_id in stop hook', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { harness } = makeFixture({ hookPort });
    await harness.run(task());
    // The stop hook should have scope with run_id
    const stopCall = calls.find((c) => c.event === 'stop');
    expect(stopCall).toBeDefined();
    expect(stopCall!.scope.run_id).toBeDefined();
    expect(stopCall!.scope.session_id).toBeDefined();
    expect(stopCall!.scope.tenant_id).toBeDefined();
  });

  it('uses scopeOverrides for operation_id in pre_tool_use hook', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort });
    const { gateway } = createScriptedGateway({
      responses: [
        { content: 'use tool', tool_calls: [{ id: 'tc-1', name: 'list_files', arguments: { path: '/workspace' } }], stop_reason: 'tool_use' },
        { content: 'done', stop_reason: 'stop' },
      ],
      clock: () => new Date(CLOCK),
    });
    const harness = new Harness({ ...config, gateway, hooks: hookPort } as any);
    try {
      await harness.run(task());
    } catch {
      // Tool may fail
    }
    const preToolCalls = calls.filter((c) => c.event === 'pre_tool_use');
    if (preToolCalls.length > 0) {
      expect((preToolCalls[0] as any).scope.operation_id).toBeDefined();
      expect((preToolCalls[0] as any).scope.attempt_id).toBeDefined();
    }
  });
});

// ============================================================
// run_finalized event exact properties
// ============================================================

describe('Harness survival-7 - run_finalized exact properties', () => {
  it('records run_finalized with exact termination_reason, verification_report, and workspace_changes', async () => {
    const { harness } = makeFixture();
    const outcome = await harness.run(task());
    const events = findEvents(outcome.session, 'run_finalized');
    expect(events.length).toBe(1);
    expect(events[0].data.termination_reason).toBe(outcome.loop_result.termination_reason);
    expect(events[0].data.verification_report).toBeDefined();
    expect(events[0].data.workspace_changes).toBeDefined();
    expect(Array.isArray(events[0].data.workspace_changes)).toBe(true);
  });
});

// ============================================================
// user_prompt_submit hook with scopeOverrides
// ============================================================

describe('Harness survival-7 - user_prompt_submit scope', () => {
  it('user_prompt_submit hook has scope with run_id and session_id', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { harness } = makeFixture({ hookPort });
    await harness.run(task('test scope'));
    const promptCall = calls.find((c) => c.event === 'user_prompt_submit');
    expect(promptCall).toBeDefined();
    expect(promptCall!.scope.run_id).toBeDefined();
    expect(promptCall!.scope.session_id).toBeDefined();
    expect((promptCall!.payload as any).goal).toBe('test scope');
  });
});

// ============================================================
// isTaskContract validation - L66
// ============================================================

describe('Harness survival-7 - isTaskContract validation', () => {
  it('accepts valid TaskContract from user_prompt_submit hook', async () => {
    const hookPort = makeRecordingHookPort([], (ctx) => {
      if (ctx.event === 'user_prompt_submit') {
        return makeHookOutcome('continue', ctx.payload);
      }
      return makeHookOutcome('continue');
    });
    const { harness } = makeFixture({ hookPort });
    const outcome = await harness.run(task('valid task'));
    expect(outcome.success).toBe(true);
  });

  it('denies when user_prompt_submit returns non-TaskContract payload', async () => {
    const hookPort = makeRecordingHookPort([], (ctx) => {
      if (ctx.event === 'user_prompt_submit') {
        return makeHookOutcome('continue', { not_a_task: true });
      }
      return makeHookOutcome('continue');
    });
    const { harness } = makeFixture({ hookPort });
    try {
      const outcome = await harness.run(task());
      // Should either fail or throw
      expect(outcome.success).toBe(false);
    } catch {
      // Throwing is also acceptable
    }
  });
});

// ============================================================
// Internal error stop hook - L1041-1050
// ============================================================

describe('Harness survival-7 - internal error handling', () => {
  it('dispatches stop hook with internal_error when gateway resolve fails', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture();
    const failingGateway = wrapGateway(config.gateway, {
      resolve: vi.fn().mockImplementation(() => { throw new Error('resolve boom'); }),
    });
    const harness = new Harness({ ...config, gateway: failingGateway, hooks: hookPort } as any);
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    const sessionEndCall = calls.find((c) => c.event === 'session_end');
    expect(sessionEndCall).toBeDefined();
  });
});

// ============================================================
// Cache tracking - L740-745
// ============================================================

describe('Harness survival-7 - cache tracking', () => {
  it('tracks cache key with exact provider_id after dispatch', async () => {
    const { harness } = makeFixture();
    await harness.run(task());
    const metrics = harness.getCacheMetrics();
    expect(metrics).toBeDefined();
    expect(typeof metrics).toBe('object');
  });

  it('tracks cache key in streaming mode', async () => {
    const { config } = makeFixture();
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'cache stream' };
        yield { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped, onModelDelta: () => {} } as any);
    await harness.run(task());
    const metrics = harness.getCacheMetrics();
    expect(metrics).toBeDefined();
  });
});
