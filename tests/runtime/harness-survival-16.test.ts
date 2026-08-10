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

function makeFixture(opts: { responses?: readonly ParsedResponse[]; hookPort?: any } = {}): { harness: Harness } {
  const workspace = rootDir('hs16-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'hs16-v1',
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
    executionContext: createDefaultExecutionContext('hs16-ctx', () => CLOCK),
  };
  if (opts.hookPort !== undefined) config.hooks = opts.hookPort;
  return { harness: new Harness(config as unknown as HarnessConfig) };
}

describe('harness-survival-16: user_prompt_submit denial with exact session event strings', () => {
  it('deny action records exact "blocked" state and "user_prompt_hook_restricted" reason in session events', async () => {
    const hookPort = {
      dispatch: async (ctx: any) => {
        if (ctx.event === 'user_prompt_submit') {
          return {
            event: ctx.event,
            action: 'deny',
            reason_code: undefined,
            follow_ups: [],
            replayed: false,
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
    expect(result.success).toBe(false);
    expect(result.loop_result?.termination_reason).toBe('denied');
    const eventStr = JSON.stringify(result.session.getEvents());
    expect(eventStr).toContain('blocked');
    expect(eventStr).toContain('user_prompt_hook_restricted');
    expect(eventStr).toContain('denied');
  });

  it('normal run records "goal_satisfied" termination and "run_completed" event', async () => {
    const { harness } = makeFixture();
    const result = await harness.run(task());
    expect(result.success).toBe(true);
    const eventStr = JSON.stringify(result.session.getEvents());
    expect(eventStr).toContain('run_terminated');
    expect(eventStr).toContain('run_finalized');
    expect(eventStr).toContain('goal_satisfied');
  });
});
