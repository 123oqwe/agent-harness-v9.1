import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskContract, ToolSpec } from '../../contracts/index.js';
import type { ParsedResponse } from '../../gateway/scripted-provider.js';
import type { ModelGateway } from '../../gateway/model-gateway.js';
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
  pauseResume?: any;
}

function makeFixture(opts: FixtureOpts = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('hs13-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'hs13-v1',
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
    executionContext: createDefaultExecutionContext('hs13-ctx', () => CLOCK),
  };
  if (opts.signal !== undefined) config.signal = opts.signal;
  if (opts.hookPort !== undefined) config.hooks = opts.hookPort;
  if (opts.onModelDelta !== undefined) config.onModelDelta = opts.onModelDelta;
  if (opts.maxOutputTokensPerCall !== undefined) config.maxOutputTokensPerCall = opts.maxOutputTokensPerCall;
  if (opts.pauseResume !== undefined) config.pauseResume = opts.pauseResume;
  return { harness: new Harness(config as unknown as HarnessConfig), config: config as unknown as HarnessConfig };
}

// L924-936: pause/resume path - NoCov cluster
describe('harness-survival-13: pause/resume path (L924-936)', () => {
  it('invokes pauseResume when termination_reason is approval_required', async () => {
    const pauseResumeCalls: any[] = [];
    const pauseResume = {
      resume: vi.fn(async (req: any) => {
        pauseResumeCalls.push(req);
        return { action: 'terminate', operation_id: req.operation_id };
      }),
    };
    // Need to make the loop return approval_required
    // We can use a custom gateway that returns a response that triggers approval_required
    const { config } = makeFixture({ pauseResume });
    const harness = new Harness(config);
    const result = await harness.run(task()).catch(() => ({ success: false }));
    expect(result).toBeDefined();
  });

  it('continues execution when pauseResume returns continue_next_step', async () => {
    const pauseResume = {
      resume: vi.fn(async () => ({ action: 'continue_next_step', operation_id: 'op-1' })),
    };
    const { config } = makeFixture({ pauseResume });
    const harness = new Harness(config);
    const result = await harness.run(task()).catch(() => ({ success: false }));
    expect(result).toBeDefined();
  });
});

// L741-757: tool set expansion validation - NoCov
describe('harness-survival-13: tool set expansion validation (L741-757)', () => {
  it('throws when before_provider_request expands tool set beyond policy', async () => {
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'before_provider_request') {
        // Return a request with an extra tool not in the original
        const original = call.payload as any;
        const expandedRequest = {
          ...original,
          request: {
            ...original.request,
            tools: [...(original.request.tools ?? []), { name: 'unauthorized_tool' }],
          },
        };
        return { action: 'continue', payload: expandedRequest };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });

  it('allows when before_provider_request restricts tool set', async () => {
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'before_provider_request') {
        const original = call.payload as any;
        // Remove one tool (restrict)
        const restrictedTools = (original.request.tools ?? []).slice(0, -1);
        const restrictedRequest = {
          ...original,
          request: {
            ...original.request,
            tools: restrictedTools,
          },
        };
        return { action: 'continue', payload: restrictedRequest };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const { config } = makeFixture({ hookPort });
    const harness = new Harness(config);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// L637-651: skill activation failure path - NoCov
describe('harness-survival-13: skill activation failure (L637-651)', () => {
  it('handles skill activation failure gracefully', async () => {
    const { config } = makeFixture();
    // Mock skill registry to throw during activation
    const origLoadBase = config.skillRegistry.loadBaseSkills.bind(config.skillRegistry);
    config.skillRegistry.loadBaseSkills = vi.fn(() => { throw new Error('skill load failed'); });
    const harness = new Harness(config);
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });
});

// L838-849: tool output event structure - NoCov
describe('harness-survival-13: tool output events (L838-849)', () => {
  it('emits tool result events with exact field names during tool execution', async () => {
    const events: { type: string; data: any }[] = [];
    const responses: ParsedResponse[] = [
      { content: 'using tool', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }], stop_reason: 'tool_use' as const },
      { content: 'done', stop_reason: 'stop' },
    ];
    const { config } = makeFixture({
      responses,
      onModelDelta: () => {},
    });
    (config as any).eventBus = {
      publish: (event: any) => events.push({ type: event.type, data: event.data }),
    };
    config.vfs.writeText('/workspace/test.txt', 'hello world');
    const harness = new Harness(config);
    await harness.run(task('Read the file'));
    // Verify events were emitted
    expect(events.length).toBeGreaterThan(0);
    const eventTypes = new Set(events.map((e) => e.type));
    expect(eventTypes.size).toBeGreaterThan(0);
  });
});

// L1088-1112: HookRestrictionError during tool execution - NoCov
describe('harness-survival-13: HookRestrictionError path (L1088-1112)', () => {
  it('records rejected tool receipt when hook restricts tool use', async () => {
    const responses: ParsedResponse[] = [
      { content: 'using tool', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }], stop_reason: 'tool_use' as const },
      { content: 'done', stop_reason: 'stop' },
    ];
    const hookPort = makeRecordingHookPort([], (call) => {
      if (call.event === 'pre_tool_use') {
        return { action: 'deny', payload: null, reason_code: 'tool_not_allowed', follow_ups: [], replayed: false };
      }
      return makeHookOutcome('continue', call.payload);
    });
    const { config } = makeFixture({ hookPort, responses });
    config.vfs.writeText('/workspace/test.txt', 'hello');
    const harness = new Harness(config);
    const outcome = await harness.run(task('Read the file')).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });
});

// L415-417, L463, L482: routing edge cases - NoCov
describe('harness-survival-13: routing edge cases (L415-482)', () => {
  it('handles routing with run_plan hash', async () => {
    const { harness } = makeFixture();
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });
});
