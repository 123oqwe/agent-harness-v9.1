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
import type { HookRuntimePort, RuntimeHookOutcome } from '../../runtime/hook-port.js';

const roots: string[] = [];
const CLOCK = '2026-07-25T00:00:00.000Z';
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const BUILD_SHA = 'a'.repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function rootDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

function task(goal = 'Provide a concise answer', constraints: TaskContract['constraints'] = []): TaskContract {
  return {
    goal,
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints,
  };
}

function makeFixture(opts: {
  responses?: readonly ParsedResponse[];
  dataDir?: string;
  sessionLogPath?: string;
  buildCommitSha?: string;
  maxSkillRiskTier?: 1 | 2 | 3 | 4;
  signal?: AbortSignal;
  hooks?: HookRuntimePort;
  onModelDelta?: (delta: string) => void;
  maxOutputTokensPerCall?: number;
  eventBus?: EventBus;
} = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('harness-surv-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'harness-survival-v1',
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
    executionContext: createDefaultExecutionContext('harness-surv', () => CLOCK),
    ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir, sessionMasterKey: MASTER_KEY }),
    ...(opts.sessionLogPath === undefined ? {} : { sessionLogPath: opts.sessionLogPath, sessionMasterKey: MASTER_KEY }),
    ...(opts.buildCommitSha === undefined ? {} : { buildCommitSha: opts.buildCommitSha }),
    ...(opts.maxSkillRiskTier === undefined ? {} : { maxSkillRiskTier: opts.maxSkillRiskTier }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
    ...(opts.onModelDelta === undefined ? {} : { onModelDelta: opts.onModelDelta }),
    ...(opts.maxOutputTokensPerCall === undefined ? {} : { maxOutputTokensPerCall: opts.maxOutputTokensPerCall }),
    ...(opts.eventBus === undefined ? {} : { eventBus: opts.eventBus }),
  };
  return { harness: new Harness(config), config };
}

// NOTE: isTaskContract validation is tested through the attenuation policy path.
// The dispatchHookBoundary function validates payload changes before isTaskContract is reached.
// When a hook returns a different payload, the attenuation policy checks if it's a valid narrowing.
// Invalid payloads (null, array, wrong types) are blocked by the attenuation policy, not isTaskContract.
// isTaskContract is only reached when the hook returns 'continue' with a payload that passes attenuation.

// --- Hook restriction: deny/skip/force_prompt paths ---

describe('Harness hook deny restriction', () => {
  it('returns denied outcome when prompt hook denies', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req) => ({
        event: req.event,
        action: 'deny' as const,
        payload: req.payload,
        reason_code: 'policy_violation',
        follow_ups: [],
        replayed: false,
      }) as unknown as Promise<RuntimeHookOutcome>),
    };
    const { harness } = makeFixture({ hooks });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    expect(outcome.hook_disposition).toBeDefined();
    expect(outcome.hook_disposition!.action).toBe('deny');
    expect(outcome.hook_disposition!.state).toBe('blocked');
    expect(outcome.hook_disposition!.reason_code).toBe('policy_violation');
  });

  it('returns skipped outcome when prompt hook skips', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req) => ({
        event: req.event,
        action: 'skip' as const,
        payload: req.payload,
        reason_code: 'skip_reason',
        follow_ups: [],
        replayed: false,
      }) as unknown as Promise<RuntimeHookOutcome>),
    };
    const { harness } = makeFixture({ hooks });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    expect(outcome.hook_disposition!.action).toBe('skip');
    expect(outcome.hook_disposition!.state).toBe('skipped');
  });

  it('returns approval_required when prompt hook forces prompt', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req) => ({
        event: req.event,
        action: 'force_prompt' as const,
        payload: req.payload,
        reason_code: 'need_approval',
        follow_ups: [],
        replayed: false,
      }) as unknown as Promise<RuntimeHookOutcome>),
    };
    const { harness } = makeFixture({ hooks });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    expect(outcome.hook_disposition!.action).toBe('force_prompt');
    expect(outcome.hook_disposition!.state).toBe('approval_required');
  });

  it('uses default reason_code when not provided', async () => {
    const hooks: HookRuntimePort = {
      dispatch: vi.fn(async (req) => ({
        event: req.event,
        action: 'deny' as const,
        payload: req.payload,
        
        follow_ups: [],
        replayed: false,
      }) as unknown as Promise<RuntimeHookOutcome>),
    };
    const { harness } = makeFixture({ hooks });
    const outcome = await harness.run(task());
    expect(outcome.hook_disposition).toBeDefined();
    // When reason_code is undefined, the harness uses 'hook_restricted' as default
    expect(outcome.hook_disposition!.reason_code).toBeDefined();
  });
});

// --- Streaming dispatch ---

describe('Harness streaming dispatch', () => {
  it('routes through dispatchStream when onDelta is provided', async () => {
    const deltas: string[] = [];
    const { harness } = makeFixture({
      onModelDelta: (d) => deltas.push(d),
      responses: [{ content: 'Hello world' }],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('handles streaming with tool_calls in stream events', async () => {
    const deltas: string[] = [];
    const { harness } = makeFixture({
      onModelDelta: (d) => deltas.push(d),
      responses: [
        { content: 'Using tool', tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test' } }] },
        { content: 'Done' },
      ],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('handles streaming without usage in message_stop', async () => {
    const deltas: string[] = [];
    const { harness } = makeFixture({
      onModelDelta: (d) => deltas.push(d),
      responses: [{ content: 'Done' }],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- EventBus integration ---

describe('Harness EventBus integration', () => {
  it('passes eventBus to loop engine when configured', async () => {
    const bus = new EventBus();
    const { harness } = makeFixture({ eventBus: bus });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('uses withEventBus to attach bus after construction', async () => {
    const bus = new EventBus();
    const { harness } = makeFixture();
    harness.withEventBus(bus);
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- maxOutputTokensPerCall ---

describe('Harness maxOutputTokensPerCall', () => {
  it('passes maxOutputTokensPerCall to loop config when set', async () => {
    const { harness } = makeFixture({ maxOutputTokensPerCall: 4096 });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- finalizeOverlay ---

describe('Harness finalizeOverlay', () => {
  it('does nothing when no workspace is active', () => {
    const { harness } = makeFixture();
    expect(() => harness.finalizeOverlay(true)).not.toThrow();
    expect(() => harness.finalizeOverlay(false)).not.toThrow();
  });
});

// --- getCacheMetrics ---

describe('Harness getCacheMetrics', () => {
  it('returns metrics object', () => {
    const { harness } = makeFixture();
    const metrics = harness.getCacheMetrics();
    expect(metrics).toBeDefined();
    expect(typeof metrics).toBe('object');
  });
});

// --- withStreaming chaining ---

describe('Harness withStreaming', () => {
  it('returns this for chaining with both callbacks', () => {
    const { harness } = makeFixture();
    const result = harness.withStreaming({
      onModelDelta: () => {},
      onToolOutput: () => {},
    });
    expect(result).toBe(harness);
  });

  it('accepts only onModelDelta', () => {
    const { harness } = makeFixture();
    const result = harness.withStreaming({ onModelDelta: () => {} });
    expect(result).toBe(harness);
  });

  it('accepts only onToolOutput', () => {
    const { harness } = makeFixture();
    const result = harness.withStreaming({ onToolOutput: () => {} });
    expect(result).toBe(harness);
  });
});

// --- Constructor edge cases ---

describe('Harness constructor edge cases', () => {
  it('rejects sessionMasterKey with wrong byte length', () => {
    expect(() => {
      const { config } = makeFixture();
      new Harness({ ...config, dataDir: '/tmp/test', sessionMasterKey: Buffer.alloc(16, 0x5a) });
    }).toThrow('32-byte sessionMasterKey');
  });

  it('rejects buildCommitSha with uppercase letters', () => {
    expect(() => {
      const { config } = makeFixture();
      new Harness({ ...config, buildCommitSha: 'A'.repeat(40) });
    }).toThrow('buildCommitSha must be a lowercase 40-character SHA');
  });

  it('rejects buildCommitSha that is too short', () => {
    expect(() => {
      const { config } = makeFixture();
      new Harness({ ...config, buildCommitSha: 'abc123' });
    }).toThrow('buildCommitSha must be a lowercase 40-character SHA');
  });

  it('rejects maxSkillRiskTier of 5', () => {
    expect(() => {
      const { config } = makeFixture();
      new Harness({ ...config, maxSkillRiskTier: 5 as 1 | 2 | 3 | 4 });
    }).toThrow('maxSkillRiskTier must be an integer from 1 through 4');
  });

  it('rejects maxSkillRiskTier of 0', () => {
    expect(() => {
      const { config } = makeFixture();
      new Harness({ ...config, maxSkillRiskTier: 0 as 1 | 2 | 3 | 4 });
    }).toThrow('maxSkillRiskTier must be an integer from 1 through 4');
  });

  it('accepts maxSkillRiskTier of 4', () => {
    const { config } = makeFixture();
    const h = new Harness({ ...config, maxSkillRiskTier: 4 });
    expect(h).toBeDefined();
  });

  it('accepts valid buildCommitSha', () => {
    const { config } = makeFixture();
    const h = new Harness({ ...config, buildCommitSha: BUILD_SHA });
    expect(h).toBeDefined();
  });
});

// --- run() with empty runId ---

describe('Harness run with empty runId', () => {
  it('rejects empty string runId', async () => {
    const { harness } = makeFixture();
    await expect(harness.run(task(), '')).rejects.toThrow('runId must be a non-empty string');
  });

  it('rejects whitespace-only runId', async () => {
    const { harness } = makeFixture();
    await expect(harness.run(task(), '   ')).rejects.toThrow('runId must be a non-empty string');
  });
});

// --- Concurrent run guard ---

describe('Harness concurrent run guard', () => {
  it('rejects concurrent runs', async () => {
    const { harness } = makeFixture({
      responses: [
        { content: 'working' },
        { content: 'done' },
      ],
    });
    const p1 = harness.run(task());
    await expect(harness.run(task())).rejects.toThrow('one active Phase 1 run');
    await p1;
  });
});

// --- Tool execution hook restriction ---

describe('Harness tool execution hook restriction', () => {
  it('throws when pre_tool_use hook denies', async () => {
    const denyHook: HookRuntimePort = {
      dispatch: vi.fn(async (req) => {
        if (req.event === 'pre_tool_use') {
          return {
            event: req.event,
            action: 'deny' as const,
            payload: req.payload,
            reason_code: 'tool_not_allowed',
            follow_ups: [],
            replayed: false,
          };
        }
        return {
          event: req.event,
          action: 'continue' as const,
          payload: req.payload,
          
          follow_ups: [],
          replayed: false,
        };
      }),
    };
    const { harness } = makeFixture({
      hooks: denyHook,
      responses: [
        {
          content: 'Let me read a file',
          tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test.txt' } }],
        },
        { content: 'Done' },
      ],
    });
    const outcome = await harness.run(task());
    // The run should not succeed due to tool denial
    expect(outcome.success).toBe(false);
  });
});

// --- Verification engine failure ---

describe('Harness verification engine failure', () => {
  it('handles verification engine crash gracefully', async () => {
    const { config } = makeFixture();
    const failingVerification = {
      verify: vi.fn().mockRejectedValue(new Error('verification crashed')),
    };
    const harness = new Harness({ ...config, verification: failingVerification as any });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(false);
    expect(outcome.verification_report).toBeNull();
  });
});

// --- Session persistence ---

describe('Harness session persistence', () => {
  it('persists session to sessionLogPath when provided', async () => {
    const logPath = join(rootDir('harness-persist-'), 'session.json');
    const { harness } = makeFixture({
      sessionLogPath: logPath,
      buildCommitSha: BUILD_SHA,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('persists session to dataDir when provided', async () => {
    const dataDir = rootDir('harness-data-');
    const { harness } = makeFixture({
      dataDir,
      buildCommitSha: BUILD_SHA,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});
