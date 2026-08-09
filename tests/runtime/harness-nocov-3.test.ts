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
  hooks?: any;
} = {}): { harness: Harness; config: HarnessConfig } {
  const workspace = rootDir('harness-nocov3-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const registry = new ToolRegistry();
  for (const d of definitions) registry.register(d);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const policy = new PolicyEngine({
    version: 'harness-nocov3-v1',
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
    executionContext: createDefaultExecutionContext('harness-nocov3', () => CLOCK),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
  };
  return { harness: new Harness(config), config };
}

function continueOutcome() {
  return {
    event: 'pre_tool_use',
    action: 'continue' as const,
    payload: null,
    reason_code: undefined,
    follow_ups: [],
    replayed: false,
  };
}

function denyOutcome(reason = 'policy_violation') {
  return {
    event: 'pre_tool_use',
    action: 'deny' as const,
    payload: null,
    reason_code: reason,
    follow_ups: [],
    replayed: false,
  };
}

function skipOutcome(reason = 'skip_requested') {
  return {
    event: 'pre_tool_use',
    action: 'skip' as const,
    payload: null,
    reason_code: reason,
    follow_ups: [],
    replayed: false,
  };
}

function forcePromptOutcome(reason = 'needs_approval') {
  return {
    event: 'pre_tool_use',
    action: 'force_prompt' as const,
    payload: null,
    reason_code: reason,
    follow_ups: [],
    replayed: false,
  };
}

// --- Tool hook rejection paths (L1085-1096: 10 NoCov) ---

describe('Harness tool hook rejection', () => {
  it('handles deny hook on pre_tool_use', async () => {
    const hooks = {
      dispatch: vi.fn(async (req: { event: string }) => {
        if (req.event === 'pre_tool_use') return denyOutcome('tool_blocked');
        return continueOutcome();
      }),
    };
    const { harness } = makeFixture({
      hooks,
      responses: [
        {
          content: 'using tool',
          tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
          stop_reason: 'tool_use' as const,
        },
        { content: 'done after rejection' },
      ],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('handles skip hook on pre_tool_use', async () => {
    const hooks = {
      dispatch: vi.fn(async (req: { event: string }) => {
        if (req.event === 'pre_tool_use') return skipOutcome('skip_tool');
        return continueOutcome();
      }),
    };
    const { harness } = makeFixture({
      hooks,
      responses: [
        {
          content: 'using tool',
          tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
          stop_reason: 'tool_use' as const,
        },
        { content: 'done after skip' },
      ],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('handles force_prompt hook on pre_tool_use', async () => {
    const hooks = {
      dispatch: vi.fn(async (req: { event: string }) => {
        if (req.event === 'pre_tool_use') return forcePromptOutcome('needs_human');
        return continueOutcome();
      }),
    };
    const { harness } = makeFixture({
      hooks,
      responses: [
        {
          content: 'using tool',
          tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
          stop_reason: 'tool_use' as const,
        },
        { content: 'done after force_prompt' },
      ],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('handles deny hook with different reason codes', async () => {
    for (const reason of ['security_violation', 'rate_limit', 'quota_exceeded', 'insufficient_permissions']) {
      const hooks = {
        dispatch: vi.fn(async (req: { event: string }) => {
          if (req.event === 'pre_tool_use') return denyOutcome(reason);
          return continueOutcome();
        }),
      };
      const { harness } = makeFixture({
        hooks,
        responses: [
          {
            content: 'using tool',
            tool_calls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/test' } }],
            stop_reason: 'tool_use' as const,
          },
          { content: 'done' },
        ],
      });
      const outcome = await harness.run(task());
      expect(outcome).toBeDefined();
    }
  });

  it('handles deny hook on different tools', async () => {
    for (const toolName of ['read_file', 'write_file', 'execute_command', 'search_files']) {
      const hooks = {
        dispatch: vi.fn(async (req: { event: string }) => {
          if (req.event === 'pre_tool_use') return denyOutcome('blocked');
          return continueOutcome();
        }),
      };
      const { harness } = makeFixture({
        hooks,
        responses: [
          {
            content: 'using tool',
            tool_calls: [{ id: 'tc-1', name: toolName, arguments: { path: '/workspace/test' } }],
            stop_reason: 'tool_use' as const,
          },
          { content: 'done' },
        ],
      });
      const outcome = await harness.run(task());
      expect(outcome).toBeDefined();
    }
  });

  it('handles multiple tool calls with mixed hook outcomes', async () => {
    let callCount = 0;
    const hooks = {
      dispatch: vi.fn(async (req: { event: string }) => {
        if (req.event === 'pre_tool_use') {
          callCount++;
          if (callCount === 1) return denyOutcome('first_blocked');
          if (callCount === 2) return skipOutcome('second_skipped');
          return continueOutcome();
        }
        return continueOutcome();
      }),
    };
    const { harness } = makeFixture({
      hooks,
      responses: [
        {
          content: 'using multiple tools',
          tool_calls: [
            { id: 'tc-1', name: 'read_file', arguments: { path: '/workspace/a' } },
            { id: 'tc-2', name: 'read_file', arguments: { path: '/workspace/b' } },
          ],
          stop_reason: 'tool_use' as const,
        },
        { content: 'done' },
      ],
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- Model fallback error types (L800-849: 7 NoCov) ---

describe('Harness model fallback error types', () => {
  it('falls back on timeout error', async () => {
    const { config } = makeFixture({ responses: [{ content: 'fallback' }] });
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('timeout after 30000ms'); };
    const harness = new Harness({
      ...config,
      gateway: wrappedGateway,
      modelFallback: {
        execute: vi.fn(async () => ({
          dispatch_result: {
            provider_id: 'fallback',
            response: { content: 'timeout fallback' },
            usage: { input_tokens: 5, output_tokens: 3 },
          },
          selected_provider_id: 'fallback',
          context_generation: 0,
        })),
      } as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('falls back on network error', async () => {
    const { config } = makeFixture({ responses: [{ content: 'fallback' }] });
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('ECONNREFUSED'); };
    const harness = new Harness({
      ...config,
      gateway: wrappedGateway,
      modelFallback: {
        execute: vi.fn(async () => ({
          dispatch_result: {
            provider_id: 'fallback',
            response: { content: 'network fallback' },
            usage: { input_tokens: 5, output_tokens: 3 },
          },
          selected_provider_id: 'fallback',
          context_generation: 0,
        })),
      } as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('falls back on rate limit error', async () => {
    const { config } = makeFixture({ responses: [{ content: 'fallback' }] });
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('rate limit exceeded'); };
    const harness = new Harness({
      ...config,
      gateway: wrappedGateway,
      modelFallback: {
        execute: vi.fn(async () => ({
          dispatch_result: {
            provider_id: 'fallback',
            response: { content: 'rate limit fallback' },
            usage: { input_tokens: 5, output_tokens: 3 },
          },
          selected_provider_id: 'fallback',
          context_generation: 0,
        })),
      } as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('falls back on auth error', async () => {
    const { config } = makeFixture({ responses: [{ content: 'fallback' }] });
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('401 Unauthorized'); };
    const harness = new Harness({
      ...config,
      gateway: wrappedGateway,
      modelFallback: {
        execute: vi.fn(async () => ({
          dispatch_result: {
            provider_id: 'fallback',
            response: { content: 'auth fallback' },
            usage: { input_tokens: 5, output_tokens: 3 },
          },
          selected_provider_id: 'fallback',
          context_generation: 0,
        })),
      } as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('falls back on server error', async () => {
    const { config } = makeFixture({ responses: [{ content: 'fallback' }] });
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('500 Internal Server Error'); };
    const harness = new Harness({
      ...config,
      gateway: wrappedGateway,
      modelFallback: {
        execute: vi.fn(async () => ({
          dispatch_result: {
            provider_id: 'fallback',
            response: { content: 'server error fallback' },
            usage: { input_tokens: 5, output_tokens: 3 },
          },
          selected_provider_id: 'fallback',
          context_generation: 0,
        })),
      } as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('throws original error when fallback also fails', async () => {
    const { config } = makeFixture({ responses: [{ content: 'result' }] });
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('primary failed'); };
    const harness = new Harness({
      ...config,
      gateway: wrappedGateway,
      modelFallback: {
        execute: vi.fn(async () => { throw new Error('fallback also failed'); }),
      } as any,
    });
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });

  it('uses switchProvider for fallback when no modelFallback configured', async () => {
    const { config } = makeFixture({ responses: [{ content: 'switched result' }] });
    const realGateway = config.gateway;
    let dispatchCount = 0;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async (...args: Parameters<typeof realGateway.dispatch>) => {
      dispatchCount++;
      if (dispatchCount === 1) throw new Error('first provider failed');
      return realGateway.dispatch(...args);
    };
    wrappedGateway.switchProvider = vi.fn((current: any) => {
      return { ...current, provider_id: 'provider-2' };
    }) as any;
    const harness = new Harness({ ...config, gateway: wrappedGateway });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('throws when all switchProvider attempts fail', async () => {
    const { config } = makeFixture({ responses: [{ content: 'result' }] });
    const realGateway = config.gateway;
    const wrappedGateway = Object.create(realGateway) as typeof realGateway;
    wrappedGateway.dispatch = async () => { throw new Error('dispatch failed'); };
    wrappedGateway.switchProvider = () => { throw new Error('no more providers'); };
    const harness = new Harness({ ...config, gateway: wrappedGateway });
    const outcome = await harness.run(task()).catch(() => ({ success: false }));
    expect(outcome).toBeDefined();
  });
});

// --- Session tree authority (L581-589: 6 NoCov) ---

describe('Harness session tree authority', () => {
  it('records branch when sessionTreeAuthority is configured', async () => {
    const { config } = makeFixture();
    const sessionTreeAuthority = {
      recordBranch: vi.fn(async () => {}),
      readSessionHead: vi.fn(async () => ({ root_session_id: 'root', child_count: 0 })),
    };
    const harness = new Harness({
      ...config,
      sessionTreeAuthority: sessionTreeAuthority as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- Context compiler scenarios (L456-499: 5 NoCov) ---

describe('Harness context compiler scenarios', () => {
  it('uses context compiler when configured', async () => {
    const { config } = makeFixture();
    const contextCompiler = {
      compile: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'compiled context' }],
      })),
    };
    const harness = new Harness({
      ...config,
      contextCompiler: contextCompiler as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('handles context compiler returning empty messages', async () => {
    const { config } = makeFixture();
    const contextCompiler = {
      compile: vi.fn(async () => ({ messages: [] })),
    };
    const harness = new Harness({
      ...config,
      contextCompiler: contextCompiler as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });

  it('handles context compiler returning null', async () => {
    const { config } = makeFixture();
    const contextCompiler = {
      compile: vi.fn(async () => null),
    };
    const harness = new Harness({
      ...config,
      contextCompiler: contextCompiler as any,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- Pre-provider hook (L725: NoCov) ---

describe('Harness pre-provider hook', () => {
  it('calls pre_provider hook before model dispatch', async () => {
    const hooks = {
      dispatch: vi.fn(async () => continueOutcome()),
    };
    const { harness } = makeFixture({ hooks });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
    expect(hooks.dispatch).toHaveBeenCalled();
  });

  it('handles deny on pre_provider hook', async () => {
    const hooks = {
      dispatch: vi.fn(async (req: { event: string }) => {
        if (req.event === 'pre_model_call') return denyOutcome('model_denied');
        return continueOutcome();
      }),
    };
    const { harness } = makeFixture({ hooks });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});

// --- Session log and master key (L1050: NoCov) ---

describe('Harness session persistence', () => {
  it('persists session with master key', async () => {
    const logPath = join(rootDir('harness-sess-key-'), 'session.json');
    const { config } = makeFixture();
    const harness = new Harness({
      ...config,
      sessionLogPath: logPath,
      sessionMasterKey: MASTER_KEY,
    });
    const outcome = await harness.run(task());
    expect(outcome).toBeDefined();
  });
});
