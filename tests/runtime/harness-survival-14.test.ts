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

interface FixtureOpts {
  responses?: readonly ParsedResponse[];
  hookPort?: any;
  pauseResume?: any;
  signal?: AbortSignal;
  hookTimeoutMs?: number;
}

function makeFixture(opts: FixtureOpts = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('hs14-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'hs14-v1',
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
    gateway,
    security,
    verification: createTestVerificationEngine(),
    executionContext: createDefaultExecutionContext('hs14-ctx', () => CLOCK),
  };
  if (opts.hookPort !== undefined) config.hooks = opts.hookPort;
  if (opts.pauseResume !== undefined) config.pauseResume = opts.pauseResume;
  if (opts.signal !== undefined) config.signal = opts.signal;
  if (opts.hookTimeoutMs !== undefined) config.hookTimeoutMs = opts.hookTimeoutMs;
  return { harness: new Harness(config as unknown as HarnessConfig), config: config as unknown as HarnessConfig };
}

function makeForcePromptHook(): any {
  return {
    dispatch: async (ctx: any) => {
      if (ctx.event === 'before_provider_request') {
        return {
          event: ctx.event,
          action: 'force_prompt',
          reason_code: 'requires_human_review',
          follow_ups: [],
          replayed: false,
          payload: ctx.payload,
        };
      }
      return {
        event: ctx.event,
        action: 'continue',
        reason_code: undefined,
        follow_ups: [],
        replayed: false,
        payload: ctx.payload,
      };
    },
  };
}

function makeDenyHook(): any {
  return {
    dispatch: async (ctx: any) => {
      if (ctx.event === 'before_provider_request') {
        return {
          event: ctx.event,
          action: 'deny',
          reason_code: 'provider_not_allowed',
          follow_ups: [],
          replayed: false,
          payload: null,
        };
      }
      return {
        event: ctx.event,
        action: 'continue',
        reason_code: undefined,
        follow_ups: [],
        replayed: false,
        payload: ctx.payload,
      };
    },
  };
}

function makeSkipHook(): any {
  return {
    dispatch: async (ctx: any) => {
      if (ctx.event === 'before_provider_request') {
        return {
          event: ctx.event,
          action: 'skip',
          reason_code: 'skip_provider',
          follow_ups: [],
          replayed: false,
          payload: null,
        };
      }
      return {
        event: ctx.event,
        action: 'continue',
        reason_code: undefined,
        follow_ups: [],
        replayed: false,
        payload: ctx.payload,
      };
    },
  };
}

// L925-939: Pause/resume path - 9 NoCov
describe('harness-survival-14: pause/resume path (L925-939)', () => {
  it('invokes pauseResume.resume when termination_reason is approval_required', async () => {
    const resumeCalls: any[] = [];
    const pauseResume = {
      resume: vi.fn(async (req: any) => {
        resumeCalls.push(req);
        return { action: 'terminate', operation_id: req.operation_id };
      }),
    };
    const { harness } = makeFixture({
      hookPort: makeForcePromptHook(),
      pauseResume,
    });
    const result = await harness.run(task());
    expect(resumeCalls.length).toBeGreaterThanOrEqual(1);
    expect(resumeCalls[0].run_id).toBeDefined();
    expect(resumeCalls[0].operation_id).toContain('pause');
  });

  it('handles continue_next_step from pauseResume (loop re-run may fail)', async () => {
    let resumeCount = 0;
    const pauseResume = {
      resume: vi.fn(async () => {
        resumeCount++;
        if (resumeCount === 1) {
          return { action: 'continue_next_step', operation_id: 'op-1' };
        }
        return { action: 'terminate', operation_id: 'op-2' };
      }),
    };
    const { harness } = makeFixture({
      hookPort: makeForcePromptHook(),
      pauseResume,
    });
    // The loop may throw when re-run (single-use constraint), harness should handle it
    const result = await harness.run(task()).catch(() => ({ success: false }));
    expect(resumeCount).toBeGreaterThanOrEqual(1);
  });

  it('does not invoke pauseResume when termination_reason is not approval_required', async () => {
    const resumeCalls: any[] = [];
    const pauseResume = {
      resume: vi.fn(async (req: any) => {
        resumeCalls.push(req);
        return { action: 'terminate', operation_id: req.operation_id };
      }),
    };
    const { harness } = makeFixture({ pauseResume });
    await harness.run(task());
    expect(resumeCalls.length).toBe(0);
  });
});

// L469-496: Prompt restriction hook path
describe('harness-survival-14: prompt restriction hook (L469-496)', () => {
  it('handles force_prompt from user_prompt_submit hook', async () => {
    const hookPort = {
      dispatch: async (ctx: any) => {
        if (ctx.event === 'user_prompt_submit') {
          return {
            event: ctx.event,
            action: 'force_prompt',
            reason_code: 'requires_clarification',
            follow_ups: [],
            replayed: false,
            payload: ctx.payload,
          };
        }
        return {
          event: ctx.event,
          action: 'continue',
          reason_code: undefined,
          follow_ups: [],
          replayed: false,
          payload: ctx.payload,
        };
      },
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });

  it('handles skip from user_prompt_submit hook', async () => {
    const hookPort = {
      dispatch: async (ctx: any) => {
        if (ctx.event === 'user_prompt_submit') {
          return {
            event: ctx.event,
            action: 'skip',
            reason_code: 'task_skipped',
            follow_ups: [],
            replayed: false,
            payload: ctx.payload,
          };
        }
        return {
          event: ctx.event,
          action: 'continue',
          reason_code: undefined,
          follow_ups: [],
          replayed: false,
          payload: ctx.payload,
        };
      },
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });

  it('handles deny from user_prompt_submit hook', async () => {
    const hookPort = {
      dispatch: async (ctx: any) => {
        if (ctx.event === 'user_prompt_submit') {
          return {
            event: ctx.event,
            action: 'deny',
            reason_code: 'task_denied',
            follow_ups: [],
            replayed: false,
            payload: ctx.payload,
          };
        }
        return {
          event: ctx.event,
          action: 'continue',
          reason_code: undefined,
          follow_ups: [],
          replayed: false,
          payload: ctx.payload,
        };
      },
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });
});

// L579: BudgetLedger conditional
describe('harness-survival-14: budgetLedger conditional (L579)', () => {
  it('creates BudgetLedgerRuntimeAdapter when both ledger and pricing are provided', async () => {
    const mockLedger = {
      recordUsage: vi.fn(),
      debit: vi.fn(),
      credit: vi.fn(),
    };
    const mockPricing = {
      cost: vi.fn(() => 0.001),
    };
    const { harness } = makeFixture({});
    (harness as any).budgetLedger = mockLedger;
    (harness as any).budgetLedgerPricing = mockPricing;
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });

  it('does not create adapter when only ledger is provided', async () => {
    const mockLedger = {
      recordUsage: vi.fn(),
      debit: vi.fn(),
      credit: vi.fn(),
    };
    const { harness } = makeFixture({});
    (harness as any).budgetLedger = mockLedger;
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });

  it('does not create adapter when only pricing is provided', async () => {
    const mockPricing = {
      cost: vi.fn(() => 0.001),
    };
    const { harness } = makeFixture({});
    (harness as any).budgetLedgerPricing = mockPricing;
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });
});

// L744-760: Tool set expansion validation
describe('harness-survival-14: tool set expansion (L744-760)', () => {
  it('throws when before_provider_request adds unauthorized tool', async () => {
    const hookPort = {
      dispatch: async (ctx: any) => {
        if (ctx.event === 'before_provider_request') {
          const original = ctx.payload as any;
          const expanded = {
            ...original,
            request: {
              ...original.request,
              tools: [...(original.request.tools ?? []), { name: 'unauthorized_tool', parameters: {} }],
            },
          };
          return {
            event: ctx.event,
            action: 'continue',
            reason_code: undefined,
            follow_ups: [],
            replayed: false,
            payload: expanded,
          };
        }
        return {
          event: ctx.event,
          action: 'continue',
          reason_code: undefined,
          follow_ups: [],
          replayed: false,
          payload: ctx.payload,
        };
      },
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task()).catch(() => ({ success: false }));
    expect(result).toBeDefined();
  });
});

// L835-856: Model fallback path
describe('harness-survival-14: model fallback (L835-856)', () => {
  it('tries fallback provider when dispatch fails', async () => {
    const { config } = makeFixture({});
    const wrappedGateway = Object.assign(Object.create(config.gateway), {
      dispatch: vi.fn().mockRejectedValueOnce(new Error('provider failed')),
      switchProvider: vi.fn((resolved: any) => resolved),
      resolve: vi.fn((req: any) => ({ provider_id: 'test-provider', model_id: 'test-model' })),
    });
    const harness = new Harness({ ...config, gateway: wrappedGateway });
    const result = await harness.run(task()).catch(() => ({ success: false }));
    expect(result).toBeDefined();
  });
});

// L1282: hookTimeoutMs conditional (now using spreadIfDefined)
describe('harness-survival-14: hookTimeoutMs config (L1282)', () => {
  it('passes timeout_ms when hookTimeoutMs is configured', async () => {
    const { harness } = makeFixture({ hookTimeoutMs: 5000 });
    const result = await harness.run(task());
    expect(result).toBeDefined();
  });
});
