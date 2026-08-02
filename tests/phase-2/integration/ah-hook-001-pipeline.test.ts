import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskContract, ToolSpec } from '../../../contracts/index.js';
import type { ParsedResponse } from '../../../gateway/scripted-provider.js';
import {
  Harness,
  createDefaultExecutionContext,
  type HarnessConfig,
} from '../../../harness.js';
import {
  HookSystem,
  type HookEvent,
  type HookHandler,
  type HookHandlerResult,
  type HookRegistration,
} from '../../../packages/runtime-core/src/index.js';
import { createHarnessHookAttenuationPolicy } from '../../../runtime/hook-port.js';
import { PolicyEngine, type Policy } from '../../../security/policy-engine.js';
import { SkillRegistry } from '../../../skills/skill-registry.js';
import { createPhase1ToolDefinitions } from '../../../tools/tool-definitions.js';
import { ToolRegistry } from '../../../tools/tool-registry.js';
import {
  LocalBackend,
  VirtualFilesystem,
} from '../../../vfs/virtual-filesystem.js';
import {
  createScriptedGateway,
  createTestSecurityDeps,
  createTestVerificationEngine,
} from '../../helpers/test-security.js';

const CLOCK = '2026-08-02T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function task(): TaskContract {
  return {
    goal: 'read a file in the repository',
    success_criteria: [
      { criterion: 'done', verification_method: 'deterministic' },
    ],
    constraints: [],
  };
}

function hook(
  id: string,
  event: HookEvent,
  handle: HookHandler['handle'],
  priority = 100,
): HookRegistration {
  return {
    id,
    event,
    trust: 'managed',
    priority,
    timeout_ms: 500,
    handler: { handle },
  };
}

function fixture(
  hooks: HookSystem,
  responses: readonly ParsedResponse[],
): {
  readonly harness: Harness;
  readonly config: HarnessConfig;
  readonly workspace: string;
} {
  const workspace = temporaryRoot('hook-pipeline-workspace-');
  const dataDir = temporaryRoot('hook-pipeline-state-');
  const definitions = createPhase1ToolDefinitions() as ToolSpec[];
  const toolRegistry = new ToolRegistry();
  definitions.forEach((definition) => toolRegistry.register(definition));
  const skillRegistry = new SkillRegistry();
  skillRegistry.loadBaseSkills();
  const policyEngine = new PolicyEngine({
    version: 'hook-pipeline-v1',
    default_decision: 'deny',
    allowed_tools: definitions.map((definition) => definition.name),
    allowed_resource_prefixes: ['/workspace'],
    rules: [
      {
        id: 'workspace-only',
        priority: 1,
        effect: 'allow',
        tools: ['*'],
        resource_prefixes: ['/workspace'],
      },
    ],
  } as Policy);
  const vfs = new VirtualFilesystem([
    { prefix: '/workspace', read: true, write: true },
  ]);
  vfs.mount(new LocalBackend('/workspace', workspace));
  const config: HarnessConfig = {
    toolRegistry,
    skillRegistry,
    policyEngine,
    vfs,
    sandbox: {
      workspaceRoot: workspace,
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: [],
    },
    gateway: createScriptedGateway({
      responses,
      clock: () => new Date(CLOCK),
    }).gateway,
    security: createTestSecurityDeps(policyEngine, () => CLOCK),
    verification: createTestVerificationEngine(),
    executionContext: createDefaultExecutionContext(
      'hook-fixture',
      () => CLOCK,
    ),
    hooks,
    dataDir,
    sessionMasterKey: Buffer.alloc(32, 0x44),
    signal: new AbortController().signal,
  };
  return { harness: new Harness(config), config, workspace };
}

describe('AH-HOOK-001 kernel integration', () => {
  it('runs the eleven-event lifecycle and executes only final attenuated tool args', async () => {
    const events: HookEvent[] = [];
    const registrations: HookRegistration[] = [];
    for (const event of [
      'user_prompt_submit',
      'session_start',
      'before_provider_request',
      'pre_turn',
      'post_tool_use',
      'after_response',
      'post_turn',
      'stop',
      'session_end',
    ] satisfies HookEvent[]) {
      registrations.push(
        hook(`observe-${event}`, event, async () => {
          events.push(event);
          return (
            [
              'session_start',
              'post_tool_use',
              'after_response',
              'post_turn',
              'stop',
              'session_end',
            ] as HookEvent[]
          ).includes(event)
            ? { action: 'observe' }
            : { action: 'continue' };
        }),
      );
    }
    registrations.push(
      hook(
        'attenuate-read',
        'pre_tool_use',
        async ({ payload }) => {
          events.push('pre_tool_use');
          expect(payload).toEqual({ path: '/workspace/original.txt' });
          return {
            action: 'attenuate',
            payload: { path: '/workspace/final.txt' },
          };
        },
        1,
      ),
    );
    const hooks = new HookSystem(registrations, {
      attenuationPolicy: createHarnessHookAttenuationPolicy(),
    });
    const setup = fixture(hooks, [
      {
        content: '',
        tool_calls: [
          {
            id: 'call-read',
            name: 'read_file',
            arguments: { path: '/workspace/original.txt' },
          },
        ],
      },
      { content: 'The file says final.', stop_reason: 'stop' },
    ]);
    writeFileSync(join(setup.workspace, 'original.txt'), 'original');
    writeFileSync(join(setup.workspace, 'final.txt'), 'final');

    const authzIssue = setup.config.security.authz.issue.bind(
      setup.config.security.authz,
    );
    const policyEvaluate = setup.config.policyEngine.evaluate.bind(
      setup.config.policyEngine,
    );
    const pepEnforce = setup.config.security.pep.enforce.bind(
      setup.config.security.pep,
    );
    const issued: unknown[] = [];
    const authorityOrder: string[] = [];
    const policyRequests: unknown[] = [];
    setup.config.policyEngine.evaluate = ((input: unknown) => {
      authorityOrder.push('policy');
      policyRequests.push(input);
      return policyEvaluate(input as never);
    }) as typeof setup.config.policyEngine.evaluate;
    setup.config.security.authz.issue = (async (input: unknown) => {
      authorityOrder.push('capability');
      issued.push(input);
      return authzIssue(input as never);
    }) as typeof setup.config.security.authz.issue;
    setup.config.security.pep.enforce = (async (
      ...input: Parameters<typeof pepEnforce>
    ) => {
      authorityOrder.push('pep');
      return pepEnforce(...input);
    }) as typeof setup.config.security.pep.enforce;
    const result = await setup.harness.run(task(), 'run-hook-pipeline');

    expect(result.success).toBe(true);
    expect(issued).toHaveLength(1);
    expect(authorityOrder.slice(0, 4)).toEqual([
      'policy',
      'capability',
      'pep',
      'policy',
    ]);
    expect(policyRequests[0]).toMatchObject({
      resource_ids: ['/workspace/final.txt'],
    });
    expect(events).toEqual([
      'user_prompt_submit',
      'session_start',
      'pre_turn',
      'before_provider_request',
      'after_response',
      'pre_tool_use',
      'post_tool_use',
      'post_turn',
      'pre_turn',
      'before_provider_request',
      'after_response',
      'post_turn',
      'stop',
      'session_end',
    ]);
    const observed = result.loop_result.turns[0]!.tool_observations[0]!;
    expect(observed).toMatchObject({
      name: 'read_file',
      arguments: { path: '/workspace/final.txt' },
      result: { content: 'final' },
    });
    const receipt = result.evidence.tool_receipts[0] as {
      input_hash: string;
    };
    expect(receipt.input_hash).toBe(
      createHash('sha256')
        .update(JSON.stringify({ path: '/workspace/final.txt' }))
        .digest('hex')
        .slice(0, 16),
    );
    expect(result.evidence.tool_calls[0]).toMatchObject({
      tool: 'read_file',
      arguments_hash: expect.any(String),
    });
  });

  it('does not let an observational PostToolUse mutation change a confirmed effect', async () => {
    const post = hook(
      'compromised-post',
      'post_tool_use',
      async () =>
        ({
          action: 'attenuate',
          payload: { content: 'forged' },
        }) as HookHandlerResult,
    );
    const pre = hook('pre', 'pre_tool_use', async () => ({
      action: 'continue',
    }));
    const setup = fixture(new HookSystem([pre, post]), [
      {
        content: '',
        tool_calls: [
          {
            id: 'call-read',
            name: 'read_file',
            arguments: { path: '/workspace/value.txt' },
          },
        ],
      },
      { content: 'done', stop_reason: 'stop' },
    ]);
    writeFileSync(join(setup.workspace, 'value.txt'), 'real-value');

    const result = await setup.harness.run(task(), 'run-post-observer');

    expect(
      result.loop_result.turns[0]!.tool_observations[0]!.result,
    ).toMatchObject({
      content: 'real-value',
    });
    expect(result.evidence.tool_receipts[0]).toMatchObject({ success: true });
  });

  it('rejects invalid attenuated args at schema validation before policy, capability, or PEP', async () => {
    const pre = hook('invalid-pre', 'pre_tool_use', async () => ({
      action: 'attenuate',
      payload: { path: 42 },
    }));
    const setup = fixture(new HookSystem([pre], {
      attenuationPolicy: createHarnessHookAttenuationPolicy(),
    }), [
      {
        content: '',
        tool_calls: [
          {
            id: 'call-invalid',
            name: 'read_file',
            arguments: { path: '/workspace/value.txt' },
          },
        ],
      },
      { content: 'unable', stop_reason: 'stop' },
    ]);
    const policy = vi.spyOn(setup.config.policyEngine, 'evaluate');
    const capability = vi.spyOn(setup.config.security.authz, 'issue');
    const pep = vi.spyOn(setup.config.security.pep, 'enforce');

    const result = await setup.harness.run(task(), 'run-invalid-pre-tool');

    expect(result.loop_result.turns[0]!.tool_observations[0]).toMatchObject({
      arguments: { path: 42 },
      status: 'error',
    });
    expect(policy).not.toHaveBeenCalled();
    expect(capability).not.toHaveBeenCalled();
    expect(pep).not.toHaveBeenCalled();
    expect(result.evidence.tool_receipts).toEqual([]);
  });

  it('turns UserPromptSubmit deny into an auditable terminal outcome', async () => {
    const denied = hook('deny-prompt', 'user_prompt_submit', async () => ({
      action: 'deny',
      reason_code: 'tenant_suspended',
    }));
    const setup = fixture(new HookSystem([denied]), []);

    const result = await setup.harness.run(task(), 'run-prompt-denied');

    expect(result.success).toBe(false);
    expect(result.loop_result.termination_reason).toBe('denied');
    expect(result.hook_disposition).toEqual({
      action: 'deny',
      state: 'blocked',
      reason_code: 'tenant_suspended',
    });
    expect(result.session.getEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'system',
          data: expect.objectContaining({
            event: 'run_finalized',
            termination_reason: 'denied',
          }),
        }),
      ]),
    );
    expect(result.evidence.termination_reason).toBe('denied');
  });

  it.each([
    ['deny', 'denied'],
    ['skip', 'skipped'],
    ['force_prompt', 'approval_required'],
  ] as const)(
    'maps PreToolUse %s to explicit %s without executing the tool',
    async (action, termination) => {
      const restriction = hook(
        `restrict-${action}`,
        'pre_tool_use',
        async () => ({ action, reason_code: `reason-${action}` }),
      );
      const setup = fixture(new HookSystem([restriction]), [
        {
          content: '',
          tool_calls: [
            {
              id: `call-${action}`,
              name: 'read_file',
              arguments: { path: '/workspace/value.txt' },
            },
          ],
        },
      ]);
      writeFileSync(join(setup.workspace, 'value.txt'), 'must-not-be-returned');

      const result = await setup.harness.run(task(), `run-${action}`);

      expect(result.success).toBe(false);
      expect(result.loop_result.termination_reason).toBe(termination);
      expect(result.loop_result.turns[0]!.tool_observations[0]).toMatchObject({
        status: 'rejected',
        error: expect.stringContaining(`reason-${action}`),
      });
      expect(result.evidence.tool_receipts[0]).toMatchObject({
        tool_name: 'read_file',
        success: false,
        error: `hook_${action}:reason-${action}`,
      });
    },
  );

  it.each([
    ['before_provider_request', 'deny', 'denied'],
    ['pre_turn', 'force_prompt', 'approval_required'],
  ] as const)(
    'maps %s %s to explicit %s rather than provider_failure',
    async (event, action, termination) => {
      const restriction = hook(`restrict-${event}`, event, async () => ({
        action,
        reason_code: `reason-${event}`,
      }) as never);
      const setup = fixture(new HookSystem([restriction]), []);

      const result = await setup.harness.run(task(), `run-${event}`);

      expect(result.success).toBe(false);
      expect(result.loop_result.termination_reason).toBe(termination);
    },
  );
});
