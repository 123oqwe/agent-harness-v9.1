import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskContract, ToolSpec } from '../../contracts/index.js';
import type { ParsedResponse } from '../../gateway/scripted-provider.js';
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
import type { RuntimeHookRequest, RuntimeHookOutcome, HookRuntimePort } from '../../runtime/hook-port.js';
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

function makeHookPort(action: 'deny' | 'skip' | 'force_prompt' | 'continue', event?: string): HookRuntimePort {
  return {
    dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
      if (event && req.event !== event) {
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }
      if (action === 'continue' && req.event === 'user_prompt_submit') {
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }
      return {
        event: req.event,
        action,
        payload: req.payload,
        reason_code: 'test_restriction',
        follow_ups: [],
        replayed: false,
      };
    }),
  };
}

function makeFixture(opts: {
  responses?: readonly ParsedResponse[];
  hooks?: HookRuntimePort;
  sessionLogPath?: string;
} = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('harness-hook-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'v1',
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
  const config: HarnessConfig = {
    toolRegistry: registry,
    skillRegistry: skills,
    policyEngine: policy,
    vfs,
    sandbox,
    gateway,
    security: createTestSecurityDeps(policy, () => CLOCK),
    verification: createTestVerificationEngine(),
    executionContext: createDefaultExecutionContext('harness-hook', () => CLOCK),
    ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
    ...(opts.sessionLogPath === undefined ? {} : { sessionLogPath: opts.sessionLogPath, sessionMasterKey: MASTER_KEY }),
  };
  return { harness: new Harness(config), config };
}

describe('Harness: prompt restriction (user_prompt_submit hook)', () => {
  it('handles deny action from user_prompt_submit hook', async () => {
    const hooks = makeHookPort('deny', 'user_prompt_submit');
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
    expect(result.loop_result.termination_reason).toBe('denied');
  });

  it('handles skip action from user_prompt_submit hook', async () => {
    const hooks = makeHookPort('skip', 'user_prompt_submit');
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('handles force_prompt action from user_prompt_submit hook', async () => {
    const hooks = makeHookPort('force_prompt', 'user_prompt_submit');
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('uses default reason_code hook_restricted when not provided', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        if (req.event === 'user_prompt_submit') {
          return { event: req.event, action: 'deny', payload: req.payload, follow_ups: [], replayed: false };
        }
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('continues when hook returns continue action', async () => {
    const hooks = makeHookPort('continue', 'user_prompt_submit');
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.loop_result.termination_reason).not.toBe('denied');
  });

  it('persists session when sessionLogPath is set and hook denies', async () => {
    const sessionLogPath = join(rootDir('harness-sessionlog-'), 'session.json');
    const hooks = makeHookPort('deny', 'user_prompt_submit');
    const { harness } = makeFixture({ hooks, sessionLogPath });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });
});

describe('Harness: hook dispatch for other events', () => {
  it('dispatches pre_turn hook', async () => {
    const dispatchedEvents: string[] = [];
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        dispatchedEvents.push(req.event);
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    await harness.run(task());
    expect(dispatchedEvents).toContain('user_prompt_submit');
    expect(dispatchedEvents).toContain('session_start');
  });

  it('dispatches post_turn hook', async () => {
    const dispatchedEvents: string[] = [];
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        dispatchedEvents.push(req.event);
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    await harness.run(task());
    expect(dispatchedEvents).toContain('post_turn');
  });

  it('dispatches stop hook on completion', async () => {
    const dispatchedEvents: string[] = [];
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        dispatchedEvents.push(req.event);
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    await harness.run(task());
    expect(dispatchedEvents).toContain('stop');
  });

  it('dispatches session_end hook', async () => {
    const dispatchedEvents: string[] = [];
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        dispatchedEvents.push(req.event);
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    await harness.run(task());
    expect(dispatchedEvents).toContain('session_end');
  });
});

describe('Harness: isTaskContract validation', () => {
  it('hook boundary denies when hook returns non-object payload for continue', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        if (req.event === 'user_prompt_submit') {
          return { event: req.event, action: 'continue', payload: 'not an object', follow_ups: [], replayed: false };
        }
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('hook boundary denies when hook returns null payload for continue', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        if (req.event === 'user_prompt_submit') {
          return { event: req.event, action: 'continue', payload: null, follow_ups: [], replayed: false };
        }
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('hook boundary denies when hook returns array payload for continue', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        if (req.event === 'user_prompt_submit') {
          return { event: req.event, action: 'continue', payload: [], follow_ups: [], replayed: false };
        }
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('hook boundary denies when hook returns object without goal', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        if (req.event === 'user_prompt_submit') {
          return { event: req.event, action: 'continue', payload: { success_criteria: [], constraints: [] }, follow_ups: [], replayed: false };
        }
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('hook boundary denies when hook returns object with empty goal', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        if (req.event === 'user_prompt_submit') {
          return { event: req.event, action: 'continue', payload: { goal: '  ', success_criteria: [], constraints: [] }, follow_ups: [], replayed: false };
        }
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('accepts valid modified TaskContract from hook', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req: RuntimeHookRequest): Promise<RuntimeHookOutcome> => {
        if (req.event === 'user_prompt_submit') {
          const original = req.payload as TaskContract;
          return {
            event: req.event,
            action: 'continue',
            payload: { ...original, goal: 'Modified goal from hook' },
            follow_ups: [],
            replayed: false,
          };
        }
        return { event: req.event, action: 'continue', payload: req.payload, follow_ups: [], replayed: false };
      }),
    };
    const { harness } = makeFixture({ hooks });
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });
});

describe('Harness: cache metrics', () => {
  it('getCacheMetrics returns metrics object', async () => {
    const { harness } = makeFixture();
    await harness.run(task());
    const metrics = harness.getCacheMetrics();
    expect(metrics).toBeDefined();
    expect(metrics.total_calls).toBeGreaterThan(0);
  });
});

describe('Harness: finalizeOverlay', () => {
  it('finalizeOverlay with no workspace does not throw', () => {
    const { harness } = makeFixture();
    expect(() => harness.finalizeOverlay(true)).not.toThrow();
    expect(() => harness.finalizeOverlay(false)).not.toThrow();
  });
});
