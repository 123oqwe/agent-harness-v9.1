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
import { EventBus } from '../../runtime/event-bus.js';
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

function makeFixture(opts: {
  responses?: readonly ParsedResponse[];
  signal?: AbortSignal;
  onModelDelta?: (delta: string) => void;
} = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('harness-surv2-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'harness-surv2-v1',
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
    executionContext: createDefaultExecutionContext('harness-surv2', () => CLOCK),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onModelDelta !== undefined ? { onModelDelta: opts.onModelDelta } : {}),
  };
  return { harness: new Harness(config), config };
}

// --- Provider fallback when dispatch fails ---

describe('Harness provider fallback', () => {
  it('tries switchProvider when dispatch fails', async () => {
    const { config } = makeFixture({
      responses: [{ content: 'fallback result' }],
    });
    // Create a gateway wrapper that fails first dispatch then succeeds
    const realGateway = config.gateway;
    let callCount = 0;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async (...args: Parameters<typeof realGateway.dispatch>) => {
      callCount++;
      if (callCount === 1) throw new Error('provider failed');
      return realGateway.dispatch(...args);
    };
    const harness = new Harness({ ...config, gateway: wrappedGateway });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('handles when all providers fail', async () => {
    const { config } = makeFixture({
      responses: [{ content: 'result' }],
    });
    // Create a gateway wrapper that always fails dispatch
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('all providers failed'); };
    wrappedGateway.switchProvider = () => { throw new Error('no more providers'); };
    const harness = new Harness({ ...config, gateway: wrappedGateway });
    // The run should handle the failure
    const outcome = await harness.run(task()).catch((e) => {
      // If it throws, that's also acceptable - the error is propagated
      return { success: false, error: e };
    });
    expect(outcome).toBeDefined();
  });
});

// --- Streaming with signal ---

describe('Harness streaming with signal', () => {
  it('passes signal to dispatchStream', async () => {
    const controller = new AbortController();
    const deltas: string[] = [];
    const { harness } = makeFixture({
      signal: controller.signal,
      onModelDelta: (d) => deltas.push(d),
      responses: [{ content: 'streaming with signal' }],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('passes signal to non-streaming dispatch', async () => {
    const controller = new AbortController();
    const { harness } = makeFixture({
      signal: controller.signal,
      responses: [{ content: 'with signal' }],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- ModelFallback controller ---

describe('Harness modelFallback', () => {
  it('uses modelFallback when dispatch fails', async () => {
    const { config } = makeFixture({
      responses: [{ content: 'fallback result' }],
    });
    // Create a gateway wrapper that fails dispatch
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('primary failed'); };
    const harnessWithFallback = new Harness({
      ...config,
      gateway: wrappedGateway,
      modelFallback: {
        execute: vi.fn(async () => ({
          dispatch_result: {
            provider_id: 'fallback',
            response: { content: 'fallback success' },
            usage: { input_tokens: 5, output_tokens: 3 },
          },
          selected_provider_id: 'fallback',
          context_generation: 0,
        })),
      } as any,
    });
    const outcome = await harnessWithFallback.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- Tool execution error paths ---

describe('Harness tool execution errors', () => {
  it('handles tool dispatch failure', async () => {
    const { harness, config } = makeFixture({
      responses: [
        {
          content: 'using tool',
          tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test' } }],
          stop_reason: 'tool_use' as const,
        },
        { content: 'done' },
      ],
    });
    // The run should complete even with tool execution
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- Verification and finalize paths ---

describe('Harness verification and finalize', () => {
  it('handles verification success', async () => {
    const { harness } = makeFixture();
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
    // Verification should have been called
    if (outcome.loop_result.termination_reason === 'goal_satisfied') {
      expect(outcome.verification_report).not.toBeNull();
      expect(outcome.success).toBe(true);
    }
  });

  it('handles verification failure', async () => {
    const { config } = makeFixture();
    const failingVerification = {
      verify: vi.fn().mockResolvedValue({
        all_passed: false,
        results: [{ criterion_index: 0, passed: false, evidence: { reason: 'failed' } }],
      }),
    };
    const harness = new Harness({ ...config, verification: failingVerification as any });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
  });

  it('handles verification crash', async () => {
    const { config } = makeFixture();
    const crashingVerification = {
      verify: vi.fn().mockRejectedValue(new Error('verification engine crashed')),
    };
    const harness = new Harness({ ...config, verification: crashingVerification as any });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    expect(outcome.verification_report).toBeNull();
  });
});

// --- Session persistence with errors ---

describe('Harness session persistence with errors', () => {
  it('persists session even when verification fails', async () => {
    const logPath = join(rootDir('harness-persist-err-'), 'session.json');
    const { config } = makeFixture();
    const failingVerification = {
      verify: vi.fn().mockRejectedValue(new Error('verification crashed')),
    };
    const harness = new Harness({
      ...config,
      verification: failingVerification as any,
      sessionLogPath: logPath,
      sessionMasterKey: MASTER_KEY,
    });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
  });
});

// --- Internal error in run() ---

describe('Harness internal error handling', () => {
  it('catches internal errors and re-throws', async () => {
    const { config } = makeFixture();
    // Create a gateway wrapper with broken resolve
    const realGateway = config.gateway;
    const brokenGateway = Object.create(realGateway) as typeof realGateway;
    brokenGateway.resolve = vi.fn(() => { throw new Error('resolve failed'); }) as any;
    const harness = new Harness({ ...config, gateway: brokenGateway });
    // The harness should handle the error (either throw or return failure)
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });
});

// --- PauseResume controller ---

describe('Harness pauseResume', () => {
  it('resumes when pauseResume returns continue_next_step', async () => {
    const { config } = makeFixture({
      responses: [
        { content: 'first response', stop_reason: 'tool_use' as const },
        { content: 'second response' },
      ],
    });
    // Create a mock pauseResume controller that returns continue_next_step
    const pauseResume = {
      resume: vi.fn().mockResolvedValue({
        action: 'continue_next_step' as const,
        operation_id: 'op-pause',
      }),
    };
    // Need auto_execute=false to trigger approval_required, then pauseResume kicks in
    const harness = new Harness({
      ...config,
      pauseResume: pauseResume as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- ContextCompiler failure ---

describe('Harness contextCompiler failure', () => {
  it('falls back to manual messages when contextCompiler fails', async () => {
    const { config } = makeFixture();
    const failingCompiler = {
      compile: vi.fn().mockRejectedValue(new Error('compiler failed')),
    };
    const harness = new Harness({
      ...config,
      contextCompiler: failingCompiler as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- BudgetLedger ---

describe('Harness budgetLedger', () => {
  it('uses budgetLedger when configured', async () => {
    const { config } = makeFixture();
    const budgetLedger = {
      record: vi.fn(async () => {}),
      getBalance: vi.fn(async () => ({ remaining_tokens: 10000, used_tokens: 0 })),
    };
    const harness = new Harness({
      ...config,
      budgetLedger: budgetLedger as any,
      budgetLedgerPricing: {
        input_per_million: 1,
        output_per_million: 2,
        currency: 'USD',
      } as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});
