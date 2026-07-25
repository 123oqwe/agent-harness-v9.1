import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskContract, ToolSpec } from '../../contracts/index.js';
import type { ParsedResponse } from '../../gateway/scripted-provider.js';
import {
  Harness,
  createDefaultExecutionContext,
  type ExecutionContext,
  type HarnessConfig,
  type HarnessSecurityDeps,
} from '../../harness.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { SkillRegistry } from '../../tools/skill-registry.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import {
  LocalBackend,
  VirtualFilesystem,
} from '../../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../../runtime/sandbox.js';
import type {
  VerificationEngine,
  VerificationReport,
} from '../../verification/verification-engine.js';
import { canonicalHash } from '../../runtime/harness-support.js';
import { SqliteSessionStore } from '../../session/sqlite-session-store.js';
import { TransactionalWorkspace } from '../../vfs/transactional-workspace.js';
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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function task(
  goal = 'Provide a concise answer to this well-defined question',
  constraints: TaskContract['constraints'] = [],
): TaskContract {
  return {
    goal,
    success_criteria: [
      {
        criterion: 'done',
        verification_method: 'deterministic',
      },
    ],
    constraints,
  };
}

interface FixtureOptions {
  responses?: readonly ParsedResponse[];
  allowedTools?: readonly string[];
  dataDir?: string;
  sessionLogPath?: string;
  buildCommitSha?: string;
  executionContext?: ExecutionContext;
  verification?: VerificationEngine;
  onDispatch?: (request: unknown) => void;
  onResolve?: (request: unknown) => void;
  onGatewayDispatch?: (
    resolved: unknown,
    request: unknown,
    context: unknown,
  ) => void;
  vfs?: VirtualFilesystem;
  sandbox?: SandboxProfile;
  maxSkillRiskTier?: 1 | 2 | 3 | 4;
  signal?: AbortSignal;
  credentialedRead?: boolean;
  credentialBroker?: HarnessSecurityDeps['credentialBroker'];
}

function fixture(options: FixtureOptions = {}): {
  harness: Harness;
  config: HarnessConfig;
  workspace: string;
  vfs: VirtualFilesystem;
} {
  const workspace = root('harness-authority-');
  const definitions = createPhase1ToolDefinitions().map((definition) =>
    definition.name === 'read_file' && options.credentialedRead
      ? {
          ...definition,
          credential_requirements: [{ name: 'repository-read-token' }],
        }
      : definition,
  ) as ToolSpec[];
  const registry = new ToolRegistry();
  for (const definition of definitions) registry.register(definition);
  const skills = new SkillRegistry();
  skills.loadBaseSkills();
  const allowedTools = [...(options.allowedTools ?? definitions.map((tool) => tool.name))];
  const policy = new PolicyEngine({
    version: 'harness-authority-v1',
    default_decision: 'deny',
    allowed_tools: allowedTools,
    allowed_resource_prefixes: ['/workspace'],
    rules: [
      {
        id: 'workspace',
        priority: 1,
        effect: 'allow',
        tools: ['*'],
        resource_prefixes: ['/workspace'],
      },
    ],
  } as Policy);
  const vfs =
    options.vfs ??
    new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]);
  if (options.vfs === undefined) {
    vfs.mount(new LocalBackend('/workspace', workspace));
  }
  const sandbox =
    options.sandbox ??
    ({
      workspaceRoot: workspace,
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: [],
    } satisfies SandboxProfile);
  const concreteGateway = createScriptedGateway({
    responses: options.responses ?? [{ content: 'done' }],
    clock: () => new Date(CLOCK),
    ...(options.onDispatch === undefined
      ? {}
      : { onDispatch: options.onDispatch }),
  }).gateway;
  const gateway =
    options.onResolve === undefined &&
    options.onGatewayDispatch === undefined
      ? concreteGateway
      : new Proxy(concreteGateway, {
          get(target, property) {
            if (property === 'resolve') {
              return (request: unknown) => {
                options.onResolve!(request);
                return target.resolve(request as never);
              };
            }
            if (property === 'dispatch') {
              return (
                resolved: unknown,
                request: unknown,
                context: unknown,
              ) => {
                options.onGatewayDispatch?.(
                  resolved,
                  request,
                  context,
                );
                return target.dispatch(
                  resolved as never,
                  request as never,
                  context as never,
                );
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
  const security = {
    ...createTestSecurityDeps(policy, () => CLOCK),
    ...(options.credentialBroker === undefined
      ? {}
      : { credentialBroker: options.credentialBroker }),
  };
  const config: HarnessConfig = {
    toolRegistry: registry,
    skillRegistry: skills,
    policyEngine: policy,
    vfs,
    sandbox,
    gateway,
    security,
    verification: options.verification ?? createTestVerificationEngine(),
    executionContext:
      options.executionContext ??
      createDefaultExecutionContext('fixture-run', () => CLOCK),
    ...(options.dataDir === undefined
      ? {}
      : { dataDir: options.dataDir, sessionMasterKey: MASTER_KEY }),
    ...(options.sessionLogPath === undefined
      ? {}
      : {
          sessionLogPath: options.sessionLogPath,
          sessionMasterKey: MASTER_KEY,
        }),
    ...(options.buildCommitSha === undefined
      ? {}
      : { buildCommitSha: options.buildCommitSha }),
    ...(options.maxSkillRiskTier === undefined
      ? {}
      : { maxSkillRiskTier: options.maxSkillRiskTier }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return { harness: new Harness(config), config, workspace, vfs };
}

function spec(name: string): ToolSpec {
  const value = createPhase1ToolDefinitions().find(
    (definition) => definition.name === name,
  );
  if (value === undefined) throw new Error(`missing fixture tool ${name}`);
  return value;
}

describe('Harness composition-root authority', () => {
  it('creates an exact deterministic test execution context', () => {
    expect(createDefaultExecutionContext('run-1', () => CLOCK)).toEqual({
      tenant_id: 'default-tenant',
      user_id: 'default-user',
      session_id: 'run-1',
      run_id: 'run-1',
      plan_id: 'plan-run-1',
      step_id: 'step-001',
      attempt_id: 'attempt-001',
      operation_id: 'op-run-1',
      idempotency_key: 'idem-run-1',
      policy_snapshot: 'policy-v1',
      tool_snapshot: 'tool-v1',
      budget: { token_limit: 100_000, usd_micros: 5_000_000 },
      risk_level: 2,
      confirmation_key_thumbprint: 'test-thumbprint',
      clock: expect.any(Function),
    });
  });

  it('requires caller-custodied persistence keys and a valid build revision', () => {
    const base = fixture().config;
    expect(() =>
      new Harness({ ...base, dataDir: root('missing-key-') }),
    ).toThrow(
      '32-byte sessionMasterKey is required when session persistence is configured',
    );
    expect(() =>
      new Harness({
        ...base,
        sessionLogPath: join(root('short-key-'), 'session.log'),
        sessionMasterKey: Buffer.alloc(31),
      }),
    ).toThrow(
      '32-byte sessionMasterKey is required when session persistence is configured',
    );
    expect(() => new Harness({ ...base, buildCommitSha: 'ABC' })).toThrow(
      'buildCommitSha must be a lowercase 40-character SHA',
    );
    for (const invalid of [
      `x${'a'.repeat(40)}`,
      `${'a'.repeat(40)}x`,
      'A'.repeat(40),
      'a'.repeat(39),
      'a'.repeat(41),
    ]) {
      expect(() =>
        new Harness({ ...base, buildCommitSha: invalid }),
      ).toThrow('buildCommitSha must be a lowercase 40-character SHA');
    }
    expect(() =>
      new Harness({ ...base, buildCommitSha: BUILD_SHA }),
    ).not.toThrow();
    expect(() =>
      new Harness({ ...base, maxSkillRiskTier: 0 as never }),
    ).toThrow('maxSkillRiskTier must be an integer from 1 through 4');
    expect(() =>
      new Harness({ ...base, maxSkillRiskTier: 4 }),
    ).not.toThrow();
  });

  it.each([
    'tenant_id',
    'user_id',
    'session_id',
    'run_id',
    'plan_id',
    'step_id',
    'attempt_id',
    'operation_id',
    'idempotency_key',
    'policy_snapshot',
    'tool_snapshot',
    'confirmation_key_thumbprint',
  ] as const)('rejects an empty execution identity field: %s', (field) => {
    const base = fixture().config;
    expect(() =>
      new Harness({
        ...base,
        executionContext: { ...base.executionContext, [field]: ' ' },
      }),
    ).toThrow(`executionContext.${field} is required`);
  });

  it('rejects invalid execution budgets, risk, and clock', () => {
    const base = fixture().config;
    expect(() =>
      new Harness({
        ...base,
        executionContext: {
          ...base.executionContext,
          budget: { ...base.executionContext.budget, token_limit: -1 },
        },
      }),
    ).toThrow(
      'executionContext.budget.token_limit must be a non-negative safe integer',
    );
    expect(() =>
      new Harness({
        ...base,
        executionContext: {
          ...base.executionContext,
          budget: { ...base.executionContext.budget, usd_micros: 1.5 },
        },
      }),
    ).toThrow(
      'executionContext.budget.usd_micros must be a non-negative safe integer',
    );
    expect(() =>
      new Harness({
        ...base,
        executionContext: { ...base.executionContext, risk_level: -1 },
      }),
    ).toThrow(
      'executionContext.risk_level must be a non-negative safe integer',
    );
    expect(() =>
      new Harness({
        ...base,
        executionContext: {
          ...base.executionContext,
          clock: () => 'invalid',
        },
      }),
    ).toThrow('executionContext.clock returned an invalid timestamp');
  });

  it('rejects a clock that becomes invalid after construction', async () => {
    let calls = 0;
    const base = fixture().config;
    const harness = new Harness({
      ...base,
      executionContext: {
        ...base.executionContext,
        clock: () => (calls++ === 0 ? CLOCK : 'invalid'),
      },
    });
    await expect(harness.run(task(), 'run-invalid-clock')).rejects.toThrow(
      'execution clock returned an invalid timestamp',
    );
  });

  it('returns a complete no-model terminal record when Router asks the user', async () => {
    let dispatches = 0;
    const directory = root('ask-terminal-');
    const logPath = join(directory, 'session.log');
    const { harness } = fixture({
      dataDir: directory,
      sessionLogPath: logPath,
      buildCommitSha: BUILD_SHA,
      onDispatch: () => {
        dispatches += 1;
      },
    });
    const request = {
      goal: 'answer',
      success_criteria: [],
      constraints: [],
    };
    const result = await harness.run(request, 'run-ask-terminal');
    expect(dispatches).toBe(0);
    expect(result.routing).toMatchObject({
      outcome: 'ask_user',
      ask_user_message:
        'Task success criteria are empty. Please describe what a successful outcome looks like.',
    });
    expect(result.run_plan).toBeNull();
    expect(result.loop_result).toEqual({
      strategy: 'direct',
      iterations: 0,
      termination_reason: 'denied',
      turns: [],
      decision_summaries: [],
      context_reset_emitted: false,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      step_states: {},
    });
    expect(
      result.session.getEvents().map((event) => [
        event.type,
        (event.data as { event?: string; reason?: string }).event ??
          (event.data as { reason?: string }).reason,
      ]),
    ).toEqual([
      ['error', 'routing_requires_user_input'],
      ['system', 'run_terminated'],
      ['system', 'run_finalized'],
    ]);
    expect(result.evidence).toMatchObject({
      run_id: 'run-ask-terminal',
      commit_sha: BUILD_SHA,
      plan_hash: null,
      plan_revision: null,
      reasoning_strategy: null,
      termination_reason: 'denied',
      iterations: 0,
      turns: 0,
      decision_summaries: [],
      session_events: 3,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      tool_calls: [],
      tool_receipts: [],
      verification_records: [],
      workspace_changes: [],
    });
    expect(result.evidence.session_head_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.success).toBe(false);
    expect(result.session.getEvents()[0]!.data).toEqual({
      reason: 'routing_requires_user_input',
      outcome: 'ask_user',
      ask_user_message:
        'Task success criteria are empty. Please describe what a successful outcome looks like.',
    });
    expect(existsSync(logPath)).toBe(true);
    const restored = await harness.run(request, 'run-ask-terminal');
    expect(restored.success).toBe(false);
    expect(restored.loop_result.termination_reason).toBe('denied');
    expect(restored.session.getEvents()).toEqual(
      result.session.getEvents(),
    );
  });

  it('rejects a blank explicit run id before routing or persistence', async () => {
    let dispatches = 0;
    const { harness } = fixture({
      onDispatch: () => {
        dispatches += 1;
      },
    });
    await expect(harness.run(task(), ' \t')).rejects.toThrow(
      'runId must be a non-empty string when provided',
    );
    expect(dispatches).toBe(0);
  });

  it('uses the Router RunPlan identity when no explicit run id is supplied', async () => {
    const { harness } = fixture();
    const result = await harness.run(task());
    expect(result.run_plan?.run_id).toMatch(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
    );
    expect(result.session.session_id).toBe(result.run_plan?.run_id);
    expect(result.evidence.run_id).toBe(result.run_plan?.run_id);
  });

  it('records abstention distinctly from ask_user and never calls the model', async () => {
    let dispatches = 0;
    const { harness } = fixture({
      allowedTools: ['nonexistent_tool'],
      onDispatch: () => {
        dispatches += 1;
      },
    });
    const result = await harness.run(task('read a file in the repository'));
    expect(result.routing.outcome).toBe('abstain');
    expect(result.routing.abstain_reason).toContain('policy prefilter');
    expect(dispatches).toBe(0);
    expect(
      result.session.getEvents().find((event) => event.type === 'error')?.data,
    ).toEqual({
      reason: 'routing_abstained',
      outcome: 'abstain',
      abstain_reason: result.routing.abstain_reason,
    });
  });

  it('fails closed with a complete terminal record when skill activation exceeds the configured risk ceiling', async () => {
    let dispatches = 0;
    const directory = root('skill-denied-');
    const logPath = join(directory, 'session.log');
    const { harness } = fixture({
      dataDir: directory,
      sessionLogPath: logPath,
      maxSkillRiskTier: 1,
      buildCommitSha: BUILD_SHA,
      onDispatch: () => {
        dispatches += 1;
      },
    });
    const result = await harness.run(
      task('fix the bug in the repository file'),
      'run-skill-denied',
    );
    expect(dispatches).toBe(0);
    expect(result.routing.outcome).toBe('route');
    expect(result.run_plan?.skill_bindings).toEqual([
      expect.objectContaining({ skill_name: 'bug-fix' }),
    ]);
    expect(result.success).toBe(false);
    expect(result.loop_result).toEqual({
      strategy: 'react',
      iterations: 0,
      termination_reason: 'denied',
      turns: [],
      decision_summaries: [],
      context_reset_emitted: false,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      step_states: {},
    });
    expect(
      result.session.getEvents().map((event) => [
        event.type,
        (event.data as { event?: string; reason?: string }).event ??
          (event.data as { reason?: string }).reason,
      ]),
    ).toEqual([
      ['error', 'skill_activation_failed'],
      ['system', 'run_terminated'],
      ['system', 'run_finalized'],
    ]);
    expect(result.session.getEvents()[0]!.data).toEqual({
      reason: 'skill_activation_failed',
      skill: 'bug-fix',
      error: "skill 'bug-fix' risk ceiling medium exceeds max tier 1",
    });
    expect(result.evidence).toMatchObject({
      run_id: 'run-skill-denied',
      commit_sha: BUILD_SHA,
      reasoning_strategy: 'react',
      termination_reason: 'denied',
      iterations: 0,
      session_events: 3,
      workspace_changes: [],
    });
    expect(existsSync(logPath)).toBe(true);
  });

  it('builds an exact local-only direct Gateway request and truthful evidence', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const resolutions: Array<Record<string, unknown>> = [];
    const setup = fixture({
      responses: [
        {
          content: 'final',
          stop_reason: 'stop',
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      ],
      buildCommitSha: BUILD_SHA,
      onDispatch: (request) => {
        requests.push(request as Record<string, unknown>);
      },
      onResolve: (request) => {
        resolutions.push(request as Record<string, unknown>);
      },
    });
    const result = await setup.harness.run(
      task('Provide a concise answer to this well-defined question', [
        { type: 'privacy', value: 'local_only' },
      ]),
      'run-direct',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      messages: [
        {
          role: 'user',
          content: 'Provide a concise answer to this well-defined question',
        },
      ],
      max_tokens: 4_096,
    });
    expect(requests[0]!.tools).toBeUndefined();
    expect(resolutions.at(-1)).toMatchObject({
      estimated_input_tokens: expect.any(Number),
      required_capabilities: ['text_reasoning'],
      requires_structured_output: false,
      data_policy: {
        local_only: true,
        allowed_regions: ['local'],
        max_retention_days: 0,
        training_allowed: false,
      },
    });
    expect(result.success).toBe(true);
    expect(result.loop_result).toMatchObject({
      strategy: 'direct',
      iterations: 1,
      termination_reason: 'goal_satisfied',
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    expect(result.evidence).toMatchObject({
      run_id: 'run-direct',
      commit_sha: BUILD_SHA,
      plan_hash: result.run_plan!.run_plan_hash,
      plan_revision: 1,
      reasoning_strategy: 'direct',
      termination_reason: 'goal_satisfied',
      iterations: 1,
      turns: 1,
      decision_summaries: ['final'],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    expect(Object.isFrozen(result.evidence.registry_snapshot_refs)).toBe(true);
    expect(Object.isFrozen(result.evidence.tool_calls)).toBe(true);
    expect(Object.isFrozen(result.evidence.audit_entries)).toBe(true);
    expect(result.run_plan?.policy_snapshot_ref).toBe(
      `policy-${setup.config.policyEngine.policy_hash}`,
    );
    expect(result.session.export_().snapshot?.summary).toEqual({
      termination_reason: 'goal_satisfied',
      iterations: 1,
      last_event_seq: result.session.eventCount(),
    });
  });

  it('does not invoke independent verification for an already-cancelled loop', async () => {
    const controller = new AbortController();
    controller.abort('cancelled before start');
    const verify = vi.fn();
    const { harness } = fixture({
      signal: controller.signal,
      verification: {
        verify,
      } as unknown as VerificationEngine,
    });
    const result = await harness.run(task(), 'run-cancelled');
    expect(result.success).toBe(false);
    expect(result.loop_result.termination_reason).toBe('user_cancel');
    expect(result.verification_report).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('binds frozen tools, model call identities, cancellation signal, receipts, and effect journal across a ReAct run', async () => {
    const directory = root('react-authority-');
    const workspace = root('react-workspace-');
    writeFileSync(join(workspace, 'a.txt'), 'hello');
    const dispatchRequests: Array<Record<string, unknown>> = [];
    const resolutionRequests: Array<Record<string, unknown>> = [];
    const contexts: Array<Record<string, unknown>> = [];
    const verificationInputs: Array<{
      toolReceipts: readonly unknown[];
    }> = [];
    const controller = new AbortController();
    const base = fixture({
      dataDir: directory,
      signal: controller.signal,
      responses: [
        {
          content: '',
          tool_calls: [
            {
              id: 'call-read',
              name: 'read_file',
              arguments: { path: '/workspace/a.txt' },
            },
          ],
        },
        {
          content: 'The file says hello.',
          stop_reason: 'stop',
          usage: { input_tokens: 7, output_tokens: 5 },
        },
      ],
      onDispatch: (request) => {
        dispatchRequests.push(request as Record<string, unknown>);
      },
      onResolve: (request) => {
        resolutionRequests.push(request as Record<string, unknown>);
      },
      onGatewayDispatch: (_resolved, _request, context) => {
        contexts.push(context as Record<string, unknown>);
      },
      verification: {
        async verify(input: {
          toolReceipts: readonly unknown[];
        }): Promise<VerificationReport> {
          verificationInputs.push(input);
          return {
            plan_revision: 1,
            all_passed: true,
            records: [],
            started_at: CLOCK,
            completed_at: CLOCK,
          };
        },
      } as unknown as VerificationEngine,
    });
    const customVfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]);
    customVfs.mount(new LocalBackend('/workspace', workspace));
    const harness = new Harness({
      ...base.config,
      vfs: customVfs,
      sandbox: {
        ...base.config.sandbox,
        workspaceRoot: workspace,
      },
    });
    const result = await harness.run(
      task('read a file in the repository'),
      'run-react-authority',
    );
    expect(result.success).toBe(true);
    expect(dispatchRequests).toHaveLength(2);
    expect(resolutionRequests).toHaveLength(3);
    const firstTools = (dispatchRequests[0]!.tools as Array<{
      name: string;
    }>).map((tool) => tool.name);
    expect(firstTools).toEqual([
      'list_directory',
      'read_file',
      'search_files',
    ]);
    expect(dispatchRequests[1]!.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining(
          'Inspect the repository before proposing changes.',
        ),
      }),
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-read',
            name: 'read_file',
            arguments: { path: '/workspace/a.txt' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-read',
        content: expect.stringContaining('"content":"hello"'),
      },
    ]);
    expect(contexts).toEqual([
      {
        operation_id: 'op-fixture-run-att-1',
        attempt_id: 'attempt-001-1',
        signal: controller.signal,
      },
      {
        operation_id: 'op-fixture-run-att-2',
        attempt_id: 'attempt-001-2',
        signal: controller.signal,
      },
    ]);
    const toolEvent = result.session.getEvents().find(
      (event) =>
        event.type === 'tool_call' &&
        (event.data as { tool_call_id?: string }).tool_call_id ===
          'call-read',
    )!;
    const toolData = toolEvent.data as {
      step: string;
      arguments: Record<string, unknown>;
    };
    const identity = canonicalHash(
      {
        run_id: 'run-react-authority',
        step_id: toolData.step,
        tool_call_id: 'call-read',
        tool_name: 'read_file',
      },
      24,
    );
    const inputIdentity = canonicalHash(toolData.arguments, 24);
    const store = new SqliteSessionStore(join(directory, 'session.db'), {
      masterKey: MASTER_KEY,
    });
    try {
      expect(store.listOperations('run-react-authority')).toEqual([
        expect.objectContaining({
          operation_id: `operation-${identity}`,
          step_id: toolData.step,
          attempt_id: `attempt-${identity}-1`,
          tool_name: 'read_file',
          idempotency_key: `idempotency-${identity}-${inputIdentity}`,
          effect_state: 'EFFECT_CONFIRMED',
        }),
      ]);
    } finally {
      store.close();
    }
    expect(result.evidence.tool_calls).toEqual([
      {
        tool_call_id: 'call-read',
        step: toolData.step,
        tool: 'read_file',
        arguments_hash: canonicalHash(toolData.arguments),
      },
    ]);
    expect(result.evidence.tool_receipts).toHaveLength(1);
    expect(result.evidence.tool_receipts[0]).toMatchObject({
      budget_ceiling_hash: createHash('sha256')
        .update(
          JSON.stringify({
            token_limit: 100_000,
            usd_micros: 5_000_000,
          }),
        )
        .digest('hex'),
    });
    expect(verificationInputs).toHaveLength(1);
    expect(verificationInputs[0]!.toolReceipts).toEqual(
      result.evidence.tool_receipts,
    );
    expect(result.evidence.audit_entries).toEqual([
      expect.objectContaining({
        tool_name: 'read_file',
        verdict: 'allow',
      }),
    ]);
  });

  it('turns registered-tool schema rejection into a rejected observation with no effect', async () => {
    const { harness } = fixture({
      responses: [
        {
          content: '',
          tool_calls: [
            {
              id: 'invalid-read',
              name: 'read_file',
              arguments: {},
            },
          ],
        },
        { content: 'done' },
      ],
    });
    const result = await harness.run(
      task('read a file in the repository'),
      'run-invalid-tool-input',
    );
    const rejected = result.session.getEvents().find(
      (event) =>
        event.type === 'tool_result' &&
        (event.data as { tool_call_id?: string }).tool_call_id ===
          'invalid-read',
    );
    expect(rejected?.data).toMatchObject({
      tool_call_id: 'invalid-read',
      tool: 'read_file',
      step: 'react-1',
      status: 'error',
      observation: {
        tool_call_id: 'invalid-read',
        name: 'read_file',
        arguments: {},
        status: 'error',
        error:
          "input schema validation failed for read_file: : must have required property 'path'",
        truncated: false,
      },
    });
    expect(result.evidence.tool_receipts).toEqual([]);
    expect(result.evidence.audit_entries).toEqual([]);
  });

  it('passes credentialed tools only through the injected broker lease and clears it', async () => {
    const clear = vi.fn();
    const exchange = vi.fn(async () => ({
      values: { token: Buffer.from('leased-secret') },
      clear,
    }));
    const setup = fixture({
      credentialedRead: true,
      credentialBroker: { exchange },
      responses: [
        {
          content: '',
          tool_calls: [
            {
              id: 'credentialed-read',
              name: 'read_file',
              arguments: { path: '/workspace/secret.txt' },
            },
          ],
        },
        { content: 'done' },
      ],
    });
    writeFileSync(join(setup.workspace, 'secret.txt'), 'value');
    const result = await setup.harness.run(
      task('read a file in the repository'),
      'run-credentialed-read',
    );
    expect(result.success).toBe(true);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_name: 'read_file',
        requirements: [{ name: 'repository-read-token' }],
        operation_id: expect.stringMatching(/^operation-[0-9a-f]{24}$/u),
        token_id: expect.any(String),
      }),
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(result.session.getEvents()),
    ).not.toContain('leased-secret');
  });

  it('fails closed when independent verification throws', async () => {
    const verification = {
      async verify(): Promise<VerificationReport> {
        throw new Error('verifier unavailable');
      },
    } as unknown as VerificationEngine;
    const { harness } = fixture({ verification });
    const result = await harness.run(task(), 'run-verifier-error');
    expect(result.success).toBe(false);
    expect(result.verification_report).toBeNull();
    expect(result.loop_result.termination_reason).toBe('verification_failed');
    expect(
      result.session.getEvents().find(
        (event) =>
          event.type === 'error' &&
          (event.data as { event?: string }).event ===
            'verification_engine_failed',
      )?.data,
    ).toEqual({
      event: 'verification_engine_failed',
      message: 'verifier unavailable',
    });
  });

  it('does not finalize success when workspace commit fails', async () => {
    const setup = fixture({
      responses: [
        {
          content: '',
          tool_calls: [
            {
              id: 'write',
              name: 'write_file',
              arguments: {
                path: '/workspace/new.txt',
                content: 'new',
              },
            },
          ],
        },
        { content: 'done' },
      ],
    });
    vi.spyOn(setup.vfs, 'commitOverlay').mockImplementation(() => {
      throw new Error('commit failed');
    });
    const result = await setup.harness.run(
      task('write a file'),
      'run-commit-failure',
    );
    expect(result.success).toBe(false);
    expect(result.loop_result.termination_reason).toBe('internal_error');
    expect(existsSync(join(setup.workspace, 'new.txt'))).toBe(false);
    expect(
      result.session.getEvents().find(
        (event) =>
          event.type === 'error' &&
          (event.data as { event?: string }).event ===
            'workspace_finalize_failed',
      )?.data,
    ).toEqual({
      event: 'workspace_finalize_failed',
      message: 'commit failed',
    });
    expect(
      result.session.getEvents().filter(
        (event) =>
          event.type === 'system' &&
          (event.data as { event?: string }).event === 'run_finalized',
      ),
    ).toHaveLength(1);
  });

  it('discards the active workspace, closes persistence, and resets run ownership after an unexpected composition error', async () => {
    const directory = root('unexpected-cleanup-');
    const setup = fixture({
      dataDir: directory,
      responses: [
        {
          content: '',
          tool_calls: [
            {
              id: 'write',
              name: 'write_file',
              arguments: {
                path: '/workspace/new.txt',
                content: 'new',
              },
            },
          ],
        },
        { content: 'done' },
      ],
    });
    vi.spyOn(
      TransactionalWorkspace.prototype,
      'describeChanges',
    ).mockImplementationOnce(() => {
      throw new Error('describe failed');
    });
    await expect(
      setup.harness.run(task('write a file'), 'run-unexpected'),
    ).rejects.toThrow('describe failed');
    expect(existsSync(join(setup.workspace, 'new.txt'))).toBe(false);
    const transactionPath = join(
      directory,
      'workspace-transactions',
      createHash('sha256')
        .update('run-unexpected')
        .digest('hex')
        .slice(0, 24),
    );
    expect(existsSync(transactionPath)).toBe(false);
    const store = new SqliteSessionStore(join(directory, 'session.db'), {
      masterKey: MASTER_KEY,
    });
    expect(store.getRun('run-unexpected')).toMatchObject({
      status: expect.any(String),
    });
    store.close();
    await expect(
      setup.harness.run(task('write a file'), 'run-after-unexpected'),
    ).resolves.toMatchObject({
      success: true,
      evidence: { run_id: 'run-after-unexpected' },
    });
    expect(readFileSync(join(setup.workspace, 'new.txt'), 'utf8')).toBe(
      'new',
    );
  });

  it('rejects concurrent use of mutable Phase 1 run state and permits sequential runs', async () => {
    const setup = fixture({
      responses: [{ content: 'done' }, { content: 'done' }],
    });
    const first = setup.harness.run(task(), 'run-one');
    await expect(setup.harness.run(task(), 'run-two')).rejects.toThrow(
      'Harness supports one active Phase 1 run at a time',
    );
    expect((await first).success).toBe(true);
    await expect(setup.harness.run(task(), 'run-two')).resolves.toMatchObject({
      success: true,
      evidence: { run_id: 'run-two' },
    });
  });

  it('writes encrypted terminal session logs without plaintext task data', async () => {
    const directory = root('harness-session-log-');
    const path = join(directory, 'session.log');
    const { harness } = fixture({ sessionLogPath: path });
    const result = await harness.run(task('secret project answer'));
    expect(result.success).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.toString().split('\n')[0]).toBe('AH-SESSION-LOG:1');
    expect(bytes.includes(Buffer.from('secret project answer'))).toBe(false);
  });

  it('keeps tool registry definitions complete in the harness fixture', () => {
    for (const name of [
      'read_file',
      'write_file',
      'edit_file',
      'list_directory',
      'search_files',
      'execute_command',
      'create_artifact',
      'parse_document',
      'ask_user',
    ]) {
      expect(spec(name).name).toBe(name);
    }
  });
});
