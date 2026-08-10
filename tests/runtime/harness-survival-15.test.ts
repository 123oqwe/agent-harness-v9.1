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
  budgetLedgerPricing?: any;
  noBudgetLedger?: boolean;
}

function makeFixture(opts: FixtureOpts = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('hs15-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'hs15-v1',
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
    executionContext: createDefaultExecutionContext('hs15-ctx', () => CLOCK),
  };
  if (opts.hookPort !== undefined) config.hooks = opts.hookPort;
  if (opts.pauseResume !== undefined) config.pauseResume = opts.pauseResume;
  if (opts.signal !== undefined) config.signal = opts.signal;
  if (opts.hookTimeoutMs !== undefined) config.hookTimeoutMs = opts.hookTimeoutMs;
  if (opts.budgetLedgerPricing !== undefined) config.budgetLedgerPricing = opts.budgetLedgerPricing;
  if (!opts.noBudgetLedger && opts.budgetLedgerPricing) {
    config.budgetLedger = { checkBudget: () => true, recordUsage: () => {}, getUsage: () => ({}) };
  }
  return { harness: new Harness(config as unknown as HarnessConfig), config: config as unknown as HarnessConfig };
}

describe('harness-survival-15: budgetLedger conditional', () => {
  it('does not create ledger adapter when budgetLedgerPricing is undefined', async () => {
    const { harness } = makeFixture();
    expect((harness as any).budgetLedgerAdapter).toBeUndefined();
  });

  it('has budgetLedger undefined when not configured', async () => {
    const { harness } = makeFixture();
    expect((harness as any).budgetLedger).toBeUndefined();
  });

  it('has budgetLedgerPricing undefined when not configured', async () => {
    const { harness } = makeFixture();
    expect((harness as any).budgetLedgerPricing).toBeUndefined();
  });

  it('does not create adapter when only pricing is provided (no ledger)', async () => {
    const { harness } = makeFixture({
      budgetLedgerPricing: {
        input_token_cost: 0.001,
        output_token_cost: 0.002,
        currency: 'USD',
      },
      noBudgetLedger: true,
    });
    expect((harness as any).budgetLedgerAdapter).toBeUndefined();
  });
});

describe('harness-survival-15: before_provider_request payload validation', () => {
  it('throws when before_provider_request returns null payload', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'before_provider_request') {
          return Promise.resolve({ action: 'continue', payload: null });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('throws when before_provider_request returns non-object payload', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'before_provider_request') {
          return Promise.resolve({ action: 'continue', payload: 'string-not-object' });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('throws when before_provider_request returns array payload', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'before_provider_request') {
          return Promise.resolve({ action: 'continue', payload: [1, 2, 3] });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });
});

describe('harness-survival-15: preTool payload validation', () => {
  it('throws when preTool returns null payload', async () => {
    const responses: ParsedResponse[] = [
      {
                content: 'I will use a tool',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }],
      },
      { content: 'Done', stop_reason: 'stop' },
    ];
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'pre_tool') {
          return Promise.resolve({ action: 'continue', payload: null });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ responses, hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('throws when preTool returns non-object payload', async () => {
    const responses: ParsedResponse[] = [
      {
                content: 'I will use a tool',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }],
      },
      { content: 'Done', stop_reason: 'stop' },
    ];
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'pre_tool') {
          return Promise.resolve({ action: 'continue', payload: 42 });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ responses, hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('throws when preTool returns array payload', async () => {
    const responses: ParsedResponse[] = [
      {
                content: 'I will use a tool',
        stop_reason: 'tool_use',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/workspace/test.txt' } }],
      },
      { content: 'Done', stop_reason: 'stop' },
    ];
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'pre_tool') {
          return Promise.resolve({ action: 'continue', payload: [1, 2] });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ responses, hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });
});

describe('harness-survival-15: user_prompt hook actions', () => {
  it('records denied status when action is force_prompt', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'user_prompt_submit') {
          return Promise.resolve({
            action: 'force_prompt',
            state: 'approval_required',
            reasonCode: 'test_reason',
          });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
    expect(result.loop_result?.termination_reason).toBe('denied');
  });

  it('records denied status when action is skip', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'user_prompt_submit') {
          return Promise.resolve({
            action: 'skip',
            state: 'blocked',
            reasonCode: 'test_skip',
          });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
    expect(result.loop_result?.termination_reason).toBe('denied');
  });

  it('allows execution when action is continue', async () => {
    const hookPort = {
      dispatch: async (ctx: any) => ({
        event: ctx.event,
        action: 'continue',
        reason_code: undefined,
        follow_ups: [],
        replayed: false,
        payload: ctx.payload,
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(true);
  });
});

describe('harness-survival-15: pre_turn message validation', () => {
  it('throws when pre_turn returns null messages', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'pre_turn') {
          return Promise.resolve({ action: 'continue', payload: { messages: null } });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('throws when pre_turn returns non-array messages', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'pre_turn') {
          return Promise.resolve({ action: 'continue', payload: { messages: 'not-array' } });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('throws when pre_turn returns message with invalid role type', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'pre_turn') {
          return Promise.resolve({
            action: 'continue',
            payload: { messages: [{ role: 123, content: 'test' }] },
          });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('throws when pre_turn returns message that is null', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'pre_turn') {
          return Promise.resolve({
            action: 'continue',
            payload: { messages: [null] },
          });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('throws when pre_turn returns message that is not an object', async () => {
    const hookPort = {
      dispatch: vi.fn().mockImplementation((ctx: any) => {
        if (ctx.event === 'pre_turn') {
          return Promise.resolve({
            action: 'continue',
            payload: { messages: ['string-not-object'] },
          });
        }
        return Promise.resolve({ action: 'continue' });
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(false);
  });

  it('accepts valid pre_turn messages', async () => {
    const hookPort = {
      dispatch: async (ctx: any) => ({
        event: ctx.event,
        action: 'continue',
        reason_code: undefined,
        follow_ups: [],
        replayed: false,
        payload: ctx.payload,
      }),
    };
    const { harness } = makeFixture({ hookPort });
    const result = await harness.run(task());
    expect(result.success).toBe(true);
  });
});

describe('harness-survival-15: hookTimeoutMs config', () => {
  it('passes hookTimeoutMs when configured', async () => {
    const hookPort = {
      dispatch: async (ctx: any) => ({
        event: ctx.event,
        action: 'continue',
        reason_code: undefined,
        follow_ups: [],
        replayed: false,
        payload: ctx.payload,
      }),
    };
    const { harness } = makeFixture({ hookPort, hookTimeoutMs: 5000 });
    const result = await harness.run(task());
    expect(result.success).toBe(true);
  });

  it('works without hookTimeoutMs configured', async () => {
    const { harness } = makeFixture();
    const result = await harness.run(task());
    expect(result.success).toBe(true);
  });
});

describe('harness-survival-15: provider count check', () => {
  it('contextCapacity is set when providers exist', async () => {
    const { harness } = makeFixture();
    expect((harness as any).contextCapacity).toBeDefined();
    expect(typeof (harness as any).contextCapacity).toBe('number');
  });
});
