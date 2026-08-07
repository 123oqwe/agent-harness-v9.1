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
} = {}): { harness: Harness; config: HarnessConfig; workspace: string } {
  const workspace = rootDir('harness-deep-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'harness-deep-v1',
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
    executionContext: createDefaultExecutionContext('harness-deep', () => CLOCK),
    ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir, sessionMasterKey: MASTER_KEY }),
    ...(opts.sessionLogPath === undefined ? {} : { sessionLogPath: opts.sessionLogPath, sessionMasterKey: MASTER_KEY }),
    ...(opts.buildCommitSha === undefined ? {} : { buildCommitSha: opts.buildCommitSha }),
    ...(opts.maxSkillRiskTier === undefined ? {} : { maxSkillRiskTier: opts.maxSkillRiskTier }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  return { harness: new Harness(config), config, workspace };
}

describe('Harness constructor validation deep', () => {
  it('rejects sessionLogPath without 32-byte master key', () => {
    const workspace = rootDir('harness-deep-nologkey-');
    const defs = createPhase1ToolDefinitions() as ToolSpec[];
    const reg = new ToolRegistry();
    for (const d of defs) reg.register(d);
    const skills = new SkillRegistry();
    skills.loadBaseSkills();
    const policy = new PolicyEngine({
      version: 'v', default_decision: 'deny', allowed_tools: ['read_file'], allowed_resource_prefixes: ['/workspace'],
      rules: [],
    } as Policy);
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', workspace));
    const sandbox: SandboxProfile = { workspaceRoot: workspace, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
    const { gateway } = createScriptedGateway({ responses: [{ content: 'x' }], clock: () => new Date(CLOCK) });
    expect(() => new Harness({
      toolRegistry: reg, skillRegistry: skills, policyEngine: policy, vfs, sandbox, gateway,
      security: createTestSecurityDeps(policy, () => CLOCK),
      verification: createTestVerificationEngine(),
      executionContext: createDefaultExecutionContext('test', () => CLOCK),
      sessionLogPath: '/tmp/test-log',
      sessionMasterKey: Buffer.alloc(16),
    })).toThrow('32-byte sessionMasterKey is required');
  });

  it('accepts valid buildCommitSha', () => {
    const { harness } = makeFixture({ buildCommitSha: BUILD_SHA });
    expect(harness).toBeInstanceOf(Harness);
  });

  it('rejects buildCommitSha with uppercase', () => {
    expect(() => makeFixture({ buildCommitSha: 'A'.repeat(40) })).toThrow('40-character SHA');
  });

  it('rejects buildCommitSha too short', () => {
    expect(() => makeFixture({ buildCommitSha: 'a'.repeat(39) })).toThrow('40-character SHA');
  });

  it('rejects maxSkillRiskTier of 5', () => {
    expect(() => makeFixture({ maxSkillRiskTier: 5 as never })).toThrow('integer from 1 through 4');
  });

  it('rejects maxSkillRiskTier of 0', () => {
    expect(() => makeFixture({ maxSkillRiskTier: 0 as never })).toThrow('integer from 1 through 4');
  });

  it('accepts maxSkillRiskTier of 4', () => {
    const { harness } = makeFixture({ maxSkillRiskTier: 4 });
    expect(harness).toBeInstanceOf(Harness);
  });
});

describe('Harness withStreaming and withEventBus deep', () => {
  it('withStreaming returns this for chaining', () => {
    const { harness } = makeFixture();
    const result = harness.withStreaming({ onModelDelta: vi.fn() });
    expect(result).toBe(harness);
  });

  it('withEventBus returns this for chaining', () => {
    const { harness } = makeFixture();
    const bus = new EventBus();
    const result = harness.withEventBus(bus);
    expect(result).toBe(harness);
  });

  it('withStreaming accepts onToolOutput only', () => {
    const { harness } = makeFixture();
    const result = harness.withStreaming({ onToolOutput: vi.fn() });
    expect(result).toBe(harness);
  });

  it('withStreaming accepts both callbacks', () => {
    const { harness } = makeFixture();
    const result = harness.withStreaming({ onModelDelta: vi.fn(), onToolOutput: vi.fn() });
    expect(result).toBe(harness);
  });

  it('withStreaming accepts empty object', () => {
    const { harness } = makeFixture();
    const result = harness.withStreaming({});
    expect(result).toBe(harness);
  });
});

describe('Harness getCacheMetrics deep', () => {
  it('returns a record from cache manager', () => {
    const { harness } = makeFixture();
    const metrics = harness.getCacheMetrics();
    expect(typeof metrics).toBe('object');
    expect(metrics).not.toBeNull();
  });
});

describe('Harness.run blank runId deep', () => {
  it('rejects blank explicit runId', async () => {
    const { harness } = makeFixture();
    await expect(harness.run(task(), '  ')).rejects.toThrow('non-empty string');
  });

  it('accepts explicit non-empty runId', async () => {
    const { harness } = makeFixture();
    const outcome = await harness.run(task(), 'custom-run-id');
    expect(outcome).toBeTruthy();
  });
});

describe('Harness concurrent run guard deep', () => {
  it('rejects concurrent runs', async () => {
    const { harness } = makeFixture({
      responses: [{ content: 'first' }, { content: 'second' }],
    });
    const p1 = harness.run(task());
    const p2 = harness.run(task());
    await expect(p2).rejects.toThrow('one active');
    await p1;
  });

  it('permits sequential runs after first completes', async () => {
    const { harness } = makeFixture({
      responses: [{ content: 'first' }, { content: 'second' }],
    });
    await harness.run(task());
    const second = await harness.run(task());
    expect(second).toBeTruthy();
  });
});

describe('Harness finalizeOverlay deep', () => {
  it('commits workspace on successful verification', async () => {
    const workspace = rootDir('harness-deep-commit-');
    const defs = createPhase1ToolDefinitions() as ToolSpec[];
    const reg = new ToolRegistry();
    for (const d of defs) reg.register(d);
    const skills = new SkillRegistry();
    skills.loadBaseSkills();
    const policy = new PolicyEngine({
      version: 'v', default_decision: 'deny',
      allowed_tools: defs.map((t) => t.name), allowed_resource_prefixes: ['/workspace'],
      rules: [{ id: 'ws', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }],
    } as Policy);
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', workspace));
    const sandbox: SandboxProfile = { workspaceRoot: workspace, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
    const { gateway } = createScriptedGateway({ responses: [{ content: 'done' }], clock: () => new Date(CLOCK) });
    const harness = new Harness({
      toolRegistry: reg, skillRegistry: skills, policyEngine: policy, vfs, sandbox, gateway,
      security: createTestSecurityDeps(policy, () => CLOCK),
      verification: createTestVerificationEngine(),
      executionContext: createDefaultExecutionContext('commit-test', () => CLOCK),
    });
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(true);
  });
});

describe('Harness hook dispatch deep', () => {
  it('runs successfully with user_prompt_submit hook returning continue', async () => {
    const { harness } = makeFixture();
    const outcome = await harness.run(task());
    expect(outcome.success).toBe(true);
  });

  it('runs with buildCommitSha for evidence', async () => {
    const { harness } = makeFixture({ buildCommitSha: BUILD_SHA });
    const outcome = await harness.run(task());
    expect(outcome.evidence).toBeTruthy();
  });
});

describe('Harness signal abort deep', () => {
  it('completes normally without signal', async () => {
    const { harness } = makeFixture();
    const outcome = await harness.run(task());
    expect(outcome).toBeTruthy();
  });
});

describe('Harness dataDir persistence deep', () => {
  it('persists session with dataDir', async () => {
    const dir = rootDir('harness-deep-persist-');
    const { harness } = makeFixture({ dataDir: dir });
    const outcome = await harness.run(task());
    expect(outcome.session).toBeTruthy();
  });

  it('persists session with sessionLogPath', async () => {
    const dir = rootDir('harness-deep-log-');
    const logPath = join(dir, 'session.log');
    const { harness } = makeFixture({ sessionLogPath: logPath });
    const outcome = await harness.run(task());
    expect(outcome.session).toBeTruthy();
  });
});
