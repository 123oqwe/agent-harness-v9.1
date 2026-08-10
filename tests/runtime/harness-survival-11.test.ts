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

function makeHookOutcome(action: string = 'continue', payload?: unknown, reasonCode?: string): any {
  return {
    action,
    payload: payload ?? null,
    reason_code: action !== 'continue' ? (reasonCode ?? 'hook_restricted') : undefined,
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

function makeRecordingHookPort(calls: HookCall[], outcome?: (call: HookCall) => any): any {
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
}

function makeFixture(opts: FixtureOpts = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('hs11-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'hs11-v1',
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
  const config: HarnessConfig = {
    toolRegistry: registry,
    skillRegistry: skills,
    policyEngine: policy,
    vfs,
    sandbox,
    gateway: opts.gateway ?? defaultGateway,
    security,
    verification: createTestVerificationEngine(),
    executionContext: createDefaultExecutionContext('hs11-ctx', () => CLOCK),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.hookPort !== undefined ? { hooks: opts.hookPort } : {}),
    ...(opts.onModelDelta !== undefined ? { onModelDelta: opts.onModelDelta } : {}),
    ...(opts.maxOutputTokensPerCall !== undefined ? { maxOutputTokensPerCall: opts.maxOutputTokensPerCall } : {}),
  };
  return { harness: new Harness(config), config };
}

function wrapGateway(real: ModelGateway, overrides: Record<string, unknown>): ModelGateway {
  return Object.assign(Object.create(real) as ModelGateway, overrides);
}

// L769-782: Streaming event handling - verify exact streamResult content
// These tests kill mutants by asserting exact properties in after_response hook payload

describe('harness-survival-11: streaming result content verification', () => {
  it('after_response hook receives streamResult with tool_calls when stream has tool_call events', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({
      hookPort,
      onModelDelta: () => {},
      responses: [{ content: 'done' }, { content: 'done' }],
    });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'Using tool' };
        yield { type: 'tool_call', tool_call: { id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } } };
        yield { type: 'message_stop', usage: { input_tokens: 10, output_tokens: 5 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    expect(afterResponse).toBeDefined();
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.response.tool_calls).toBeDefined();
    expect(streamResult.response.tool_calls).toHaveLength(1);
    expect(streamResult.response.tool_calls![0]!.id).toBe('tc-1');
    expect(streamResult.response.tool_calls![0]!.name).toBe('read_file');
    expect(streamResult.response.tool_calls![0]!.arguments).toEqual({ path: '/workspace/test' });
  });

  it('after_response hook receives streamResult WITHOUT tool_calls when stream has no tool_call events', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'just text response' };
        yield { type: 'message_stop', usage: { input_tokens: 5, output_tokens: 3 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    expect(afterResponse).toBeDefined();
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.response.tool_calls).toBeUndefined();
  });

  it('after_response hook receives streamResult with usage when stream has message_stop with usage', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'response with usage' };
        yield { type: 'message_stop', usage: { input_tokens: 100, output_tokens: 50 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    expect(afterResponse).toBeDefined();
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.response.usage).toBeDefined();
    expect(streamResult.response.usage!.input_tokens).toBe(100);
    expect(streamResult.response.usage!.output_tokens).toBe(50);
    expect(streamResult.usage.input_tokens).toBe(100);
    expect(streamResult.usage.output_tokens).toBe(50);
  });

  it('after_response hook receives streamResult with default usage when stream has message_stop without usage', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'no usage' };
        yield { type: 'message_stop' };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    expect(afterResponse).toBeDefined();
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.response.usage).toBeUndefined();
    expect(streamResult.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('after_response hook receives streamResult with provider_id from resolved request', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'test' };
        yield { type: 'message_stop', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    expect(afterResponse).toBeDefined();
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.provider_id).toBe('scripted');
  });

  it('text_delta content is accumulated correctly in streamResult.response.content', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: 'Hello ' };
        yield { type: 'text_delta', text: 'World' };
        yield { type: 'text_delta', text: '!' };
        yield { type: 'message_stop', usage: { input_tokens: 3, output_tokens: 3 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.response.content).toBe('Hello World!');
  });

  it('text_delta with empty text is not accumulated (ev.text falsy check)', async () => {
    const calls: HookCall[] = [];
    const hookPort = makeRecordingHookPort(calls);
    const { config } = makeFixture({ hookPort, onModelDelta: () => {} });
    const wrapped = wrapGateway(config.gateway, {
      dispatchStream: async function* () {
        yield { type: 'text_delta', text: '' };
        yield { type: 'text_delta', text: 'after empty' };
        yield { type: 'message_stop', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const harness = new Harness({ ...config, gateway: wrapped });
    await harness.run(task());
    const afterResponse = calls.find((c) => c.event === 'after_response');
    const streamResult = afterResponse!.payload as GatewayDispatchResult;
    expect(streamResult.response.content).toBe('after empty');
  });
});

// L731: before_provider_request validation - verify error messages


describe('harness-survival-11: maxOutputTokensPerCall conditional spread', () => {
  it('harness runs successfully with maxOutputTokensPerCall set', async () => {
    const { harness } = makeFixture({ maxOutputTokensPerCall: 4096 });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
    expect(outcome.success).toBe(true);
  });

  it('harness runs successfully without maxOutputTokensPerCall (undefined)', async () => {
    const { harness } = makeFixture({});
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
    expect(outcome.success).toBe(true);
  });
});
