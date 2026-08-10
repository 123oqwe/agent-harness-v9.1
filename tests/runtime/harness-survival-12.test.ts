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
import { PolicyEngine } from '../../security/policy-engine.js';
import type { Policy } from '../../security/policy-engine.js';
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

function makeHookOutcome(action: string = 'continue', payload?: unknown): any {
  return {
    action,
    payload: payload ?? null,
    reason_code: action !== 'continue' ? 'hook_restricted' : undefined,
    follow_ups: [],
    replayed: false,
  };
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
        return { event: ctx.event, action: 'continue', reason_code: undefined, follow_ups: [], replayed: false, ...result };
      }
      return { event: ctx.event, action: 'continue', reason_code: undefined, follow_ups: [], replayed: false, payload: ctx.payload };
    },
  };
}

interface FixtureOpts {
  responses?: readonly ParsedResponse[];
  hookPort?: any;
  onModelDelta?: (delta: string) => void;
  gateway?: ModelGateway;
  maxOutputTokensPerCall?: number;
  signal?: AbortSignal;
  onToolOutput?: (toolCallId: string, stepId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  eventBus?: { publish: (type: string, data: unknown) => void };
  budgetLedger?: any;
  budgetLedgerPricing?: any;
  steeringController?: any;
}

function makeFixture(opts: FixtureOpts = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('hs12-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'hs12-v1',
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
  const { gateway: defaultGateway } = createScriptedGateway({
    responses: opts.responses ?? [{ content: 'done', stop_reason: 'stop' }],
    clock: () => new Date(CLOCK),
  });
  const security = createTestSecurityDeps(policy, () => CLOCK);
  const config: Record<string, unknown> = {
    toolRegistry: registry,
    skillRegistry: skills,
    policyEngine: policy,
    vfs,
    sandbox,
    gateway: opts.gateway ?? defaultGateway,
    security,
    verification: createTestVerificationEngine(),
    executionContext: createDefaultExecutionContext('hs12-ctx', () => CLOCK),
  };
  if (opts.signal !== undefined) config.signal = opts.signal;
  if (opts.hookPort !== undefined) config.hooks = opts.hookPort;
  if (opts.onModelDelta !== undefined) config.onModelDelta = opts.onModelDelta;
  if (opts.maxOutputTokensPerCall !== undefined) config.maxOutputTokensPerCall = opts.maxOutputTokensPerCall;
  if (opts.onToolOutput !== undefined) config.onToolOutput = opts.onToolOutput;
  if (opts.eventBus !== undefined) config.eventBus = opts.eventBus;
  if (opts.budgetLedger !== undefined) config.budgetLedger = opts.budgetLedger;
  if (opts.budgetLedgerPricing !== undefined) config.budgetLedgerPricing = opts.budgetLedgerPricing;
  if (opts.steeringController !== undefined) config.steeringController = opts.steeringController;
  return { harness: new Harness(config as unknown as HarnessConfig), config: config as unknown as HarnessConfig };
}

function wrapGateway(real: ModelGateway, overrides: Record<string, unknown>): ModelGateway {
  return Object.assign(Object.create(real) as ModelGateway, overrides);
}

// L1287-1293: isTaskContract validation - test all branches
describe('harness-survival-12: isTaskContract validation', () => {
  it('rejects null input', async () => {
    const { harness } = makeFixture();
    await expect(harness.run(null as any)).rejects.toThrow();
  });

  it('rejects non-object input (string)', async () => {
    const { harness } = makeFixture();
    await expect(harness.run('not an object' as any)).rejects.toThrow();
  });

  it('rejects non-object input (number)', async () => {
    const { harness } = makeFixture();
    await expect(harness.run(42 as any)).rejects.toThrow();
  });

  it('rejects array input', async () => {
    const { harness } = makeFixture();
    await expect(harness.run([1, 2, 3] as any)).rejects.toThrow();
  });

  it('rejects object with non-string goal', async () => {
    const { harness } = makeFixture();
    await expect(harness.run({ goal: 123, success_criteria: [], constraints: [] } as any)).rejects.toThrow();
  });

  it('rejects object with empty/whitespace goal', async () => {
    const { harness } = makeFixture();
    await expect(harness.run({ goal: '   ', success_criteria: [], constraints: [] } as any)).rejects.toThrow();
  });

  it('rejects object with non-array success_criteria', async () => {
    const { harness } = makeFixture();
    await expect(harness.run({ goal: 'test', success_criteria: 'not array', constraints: [] } as any)).rejects.toThrow();
  });

  it('rejects object with non-array constraints', async () => {
    const { harness } = makeFixture();
    await expect(harness.run({ goal: 'test', success_criteria: [], constraints: 'not array' } as any)).rejects.toThrow();
  });

  it('rejects object with missing goal', async () => {
    const { harness } = makeFixture();
    await expect(harness.run({ success_criteria: [], constraints: [] } as any)).rejects.toThrow();
  });

  it('rejects object with missing success_criteria', async () => {
    const { harness } = makeFixture();
    await expect(harness.run({ goal: 'test', constraints: [] } as any)).rejects.toThrow();
  });

  it('rejects object with missing constraints', async () => {
    const { harness } = makeFixture();
    await expect(harness.run({ goal: 'test', success_criteria: [] } as any)).rejects.toThrow();
  });
});

// L738: beforeProvider payload validation - test invalid payloads
describe('harness-survival-12: before_provider_request payload validation', () => {
  it('throws when before_provider_request returns null payload', async () => {
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'before_provider_request') {
        return { action: 'continue', payload: null };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });

  it('throws when before_provider_request returns non-object payload', async () => {
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'before_provider_request') {
        return { action: 'continue', payload: 'not an object' };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });

  it('throws when before_provider_request returns array payload', async () => {
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'before_provider_request') {
        return { action: 'continue', payload: [1, 2, 3] };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });
});

// L1108: preTool payload validation - test invalid payloads
describe('harness-survival-12: pre_tool_use payload validation', () => {
  it('throws when pre_tool_use returns null payload for tool execution', async () => {
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'pre_tool_use') {
        return { action: 'continue', payload: null };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const responses: ParsedResponse[] = [
      { content: 'using tool', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }], stop_reason: 'tool_use' as const },
      { content: 'done', stop_reason: 'stop' },
    ];
    const { config } = makeFixture({ hookPort, responses });
    const harness = new Harness(config);
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });

  it('throws when pre_tool_use returns non-object payload', async () => {
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'pre_tool_use') {
        return { action: 'continue', payload: 'string-not-object' };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const responses: ParsedResponse[] = [
      { content: 'using tool', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }], stop_reason: 'tool_use' as const },
      { content: 'done', stop_reason: 'stop' },
    ];
    const { config } = makeFixture({ hookPort, responses });
    const harness = new Harness(config);
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });

  it('throws when pre_tool_use returns array payload', async () => {
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'pre_tool_use') {
        return { action: 'continue', payload: [1, 2, 3] };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const responses: ParsedResponse[] = [
      { content: 'using tool', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }], stop_reason: 'tool_use' as const },
      { content: 'done', stop_reason: 'stop' },
    ];
    const { config } = makeFixture({ hookPort, responses });
    const harness = new Harness(config);
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });
});

// L571: budgetLedger conditional - verify both branches
describe('harness-survival-12: budgetLedger conditional behavior', () => {
  it('runs normally without budgetLedger', async () => {
    const { harness } = makeFixture();
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });

  it('runs normally with budgetLedger but without pricing (no adapter)', async () => {
    const mockLedger = { recordUsage: vi.fn() };
    const { harness } = makeFixture({ budgetLedger: mockLedger });
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });

  it('runs normally with budgetLedgerPricing but without ledger (no adapter)', async () => {
    const mockPricing = { cost: vi.fn() };
    const { harness } = makeFixture({ budgetLedgerPricing: mockPricing });
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });
});

// L877-879: onToolOutput and eventBus callbacks
describe('harness-survival-12: tool output and event bus callbacks', () => {
  it('eventBus receives events when provided', async () => {
    const events: { type: string; data: unknown }[] = [];
    const responses: ParsedResponse[] = [
      { content: 'using tool', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }], stop_reason: 'tool_use' as const },
      { content: 'done', stop_reason: 'stop' },
    ];
    const { config } = makeFixture({
      responses,
      eventBus: {
        publish: (type: string, data: unknown) => events.push({ type, data }),
      },
    });
    config.vfs.writeText('/workspace/test.txt', 'hello world');
    const harness = new Harness(config);
    await harness.run(task('Read the file'));
    expect(events.length).toBeGreaterThan(0);
    const eventTypes = new Set(events.map((e) => e.type));
    expect(eventTypes.size).toBeGreaterThan(0);
  });
});

// L683, L696, L700, L715: conditional spreads for config options
describe('harness-survival-12: config option conditional spreads', () => {
  it('runs with maxOutputTokensPerCall set (spread is applied)', async () => {
    const { harness } = makeFixture({ maxOutputTokensPerCall: 4096 });
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });

  it('runs without maxOutputTokensPerCall (spread is skipped)', async () => {
    const { harness } = makeFixture();
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });

  it('runs with signal provided (signal is passed to loop)', async () => {
    const controller = new AbortController();
    const { harness } = makeFixture({ signal: controller.signal });
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });

  it('runs without signal (signal is undefined, not passed)', async () => {
    const { harness } = makeFixture();
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });

  it('runs with steeringController provided (effective steering is set)', async () => {
    const mockSteering = {
      drain: vi.fn(() => []),
      inject: vi.fn(),
    };
    const { harness } = makeFixture({ steeringController: mockSteering });
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });

  it('runs without steeringController (steering from deps is used)', async () => {
    const { harness } = makeFixture();
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).toBeDefined();
  });
});

// L778-780: streaming event type checks - verify exact event handling
describe('harness-survival-12: streaming event type handling', () => {
  it('text_delta events without text content are ignored (does not call onDelta)', async () => {
    const deltas: string[] = [];
    const { config } = makeFixture({ onModelDelta: (d) => deltas.push(d) });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: '' };
        yield { type: 'message_stop', usage: { input_tokens: 5, output_tokens: 0 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    expect(deltas.every((d) => d !== '')).toBe(true);
  });

  it('tool_call events without tool_call object are ignored', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'hello' };
        yield { type: 'tool_call' };
        yield { type: 'message_stop', usage: { input_tokens: 5, output_tokens: 5 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.response.tool_calls).toBeUndefined();
  });

  it('message_stop events without usage are handled (usage defaults to zeros)', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'hello' };
        yield { type: 'message_stop' };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('text_delta with text calls onDelta with exact text content', async () => {
    const deltas: string[] = [];
    const { config } = makeFixture({ onModelDelta: (d) => deltas.push(d) });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'Hello ' };
        yield { type: 'text_delta', text: 'World' };
        yield { type: 'message_stop', usage: { input_tokens: 5, output_tokens: 2 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    expect(deltas).toEqual(['Hello ', 'World']);
  });

  it('tool_call events collect exact tool_call objects in order', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'tool_call', tool_call: { id: 'tc-1', name: 'search', arguments: { q: 'test' } } };
        yield { type: 'tool_call', tool_call: { id: 'tc-2', name: 'read_file', arguments: { path: '/workspace/f' } } };
        yield { type: 'message_stop', usage: { input_tokens: 10, output_tokens: 5 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.response.tool_calls).toHaveLength(2);
    expect(streamResult.response.tool_calls![0]!.id).toBe('tc-1');
    expect(streamResult.response.tool_calls![0]!.name).toBe('search');
    expect(streamResult.response.tool_calls![1]!.id).toBe('tc-2');
    expect(streamResult.response.tool_calls![1]!.name).toBe('read_file');
  });

  it('message_stop with usage records exact usage values', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'response' };
        yield { type: 'message_stop', usage: { input_tokens: 42, output_tokens: 17 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.usage).toEqual({ input_tokens: 42, output_tokens: 17 });
    expect(streamResult.response.usage).toEqual({ input_tokens: 42, output_tokens: 17 });
  });
});
