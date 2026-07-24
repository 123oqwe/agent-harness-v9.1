import { describe, expect, it, vi } from 'vitest';

import type { ActionManifest } from '../../../spec/types/action-manifest.js';
import type { CapabilityToken } from '../../../spec/types/capability-token.js';
import type { EffectRisk } from '../../../spec/types/effect-risk.js';
import { PolicyEngine, type Policy, type PolicyContext } from '../../security/policy-engine.js';
import {
  PolicyEnforcementPoint,
  type AuditEvent,
  type PepDeniedError,
  type PepExecutionContext,
} from '../../security/pep.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const TOKEN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-01-01T00:00:00.000Z';

function risk(overrides: Partial<EffectRisk> = {}): EffectRisk {
  return {
    locality: 'local',
    operation: 'read',
    reversibility: 'guaranteed',
    data_egress: 'none',
    network_access: false,
    credential_access: false,
    blast_radius: 'single_resource',
    financial_impact_usd_micros: '0',
    human_impact: 'none',
    external_visibility: 'private',
    regulatory_sensitivity: [],
    ...overrides,
  };
}

function allowPolicy(): Policy {
  return {
    version: 'policy-v1',
    default_decision: 'deny',
    allowed_tools: ['read_file'],
    allowed_resource_prefixes: ['workspace://project/'],
    rules: [
      {
        id: 'allow-project-read',
        priority: 10,
        effect: 'allow',
        tools: ['read_file'],
        resource_prefixes: ['workspace://project/'],
        maximum_risk_tier: 2,
      },
    ],
  };
}

function manifest(overrides: Partial<ActionManifest> = {}): ActionManifest {
  return {
    task_id: 'task-1',
    plan_id: 'plan-1',
    step_id: 'step-1',
    tool_name: 'read_file',
    tool_version: '1.0.0',
    schema_hash: HASH_A,
    canonical_args: { path: 'workspace://project/private-name.txt', secret: 'must-not-log' },
    resource_ids: ['workspace://project/private-name.txt'],
    resource_versions: {},
    preconditions: {},
    expected_postconditions: {},
    reads: ['workspace://project/private-name.txt'],
    writes: [],
    external_effects: [],
    side_effect_class: 'read_only',
    credential_scope: [],
    max_attempts: 1,
    max_cost: { token_limit: 100, usd_micros: '0', currency: 'USD' },
    expires_at: '2026-01-01T00:01:00.000Z',
    compensation_plan: null,
    policy_version: 'policy-v1',
    manifest_hash: HASH_B,
    ...overrides,
  };
}

function policyContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    run_phase: 'agent',
    trust_level: 'trusted',
    now: NOW,
    ...overrides,
  };
}

function executionContext(
  engine: PolicyEngine,
  overrides: Partial<PepExecutionContext> = {},
): PepExecutionContext {
  return {
    ...policyContext(),
    operation_id: 'operation-1',
    attempt_id: 'attempt-1',
    audience: 'harness-tool-host',
    subject_workload: 'single-agent-runtime',
    execution_epoch: 'epoch-1',
    policy_hash: engine.policy_hash,
    tool_effect_contract_hash: HASH_C,
    tool_grant_hash: HASH_D,
    resource_grant_hash: HASH_E,
    budget_ceiling_hash: HASH_F,
    confirmation_key_thumbprint: 'confirmation-key-1',
    ...overrides,
  };
}

function tokenFor(
  engine: PolicyEngine,
  action = manifest(),
  actionRisk = risk(),
  ctx = executionContext(engine),
  overrides: Partial<CapabilityToken> = {},
): CapabilityToken {
  const decision = engine.evaluate({
    tool_name: action.tool_name,
    resource_ids: action.resource_ids,
    risk: actionRisk,
    context: ctx,
  });
  if (!decision.allowed) throw new Error(`fixture policy denied: ${decision.reason_code}`);
  return {
    token_id: TOKEN_ID,
    operation_id: ctx.operation_id,
    attempt_id: ctx.attempt_id,
    manifest_hash: action.manifest_hash,
    policy_decision_hash: decision.decision_hash,
    tool_effect_contract_hash: ctx.tool_effect_contract_hash,
    subject_workload: ctx.subject_workload,
    tenant_id: ctx.tenant_id,
    audience: ctx.audience,
    tool_grant_hash: ctx.tool_grant_hash,
    resource_grant_hash: ctx.resource_grant_hash,
    budget_ceiling_hash: ctx.budget_ceiling_hash,
    issued_at: '2025-12-31T23:59:00.000Z',
    not_before: NOW,
    expires_at: '2026-01-01T00:01:00.000Z',
    execution_epoch: ctx.execution_epoch,
    use_limit: 1,
    confirmation_key_thumbprint: ctx.confirmation_key_thumbprint,
    ...overrides,
  };
}

function setup(options: {
  engine?: PolicyEngine;
  verify_signature?: (token: CapabilityToken) => Promise<boolean>;
  consume?: (tokenId: string) => Promise<boolean>;
  now?: () => string;
} = {}) {
  const engine = options.engine ?? new PolicyEngine(allowPolicy());
  const events: AuditEvent[] = [];
  const verifySignature = vi.fn(options.verify_signature ?? (async () => true));
  const consume = vi.fn(options.consume ?? (async () => true));
  const pep = new PolicyEnforcementPoint({
    policy_engine: engine,
    capability_authority: {
      verify_signature: verifySignature,
      consume,
    },
    audit_sink: {
      write: async (event) => {
        events.push(event);
      },
    },
    now: options.now ?? (() => NOW),
  });
  return { engine, events, verifySignature, consume, pep };
}

async function expectDenied(promise: Promise<unknown>, reasonCode: string) {
  await expect(promise).rejects.toMatchObject({
    name: 'PepDeniedError',
    reason_code: reasonCode,
  });
}

describe('AH-POLICY-ENGINE-001: PEP is mandatory at every action', () => {
  it('re-evaluates the current policy before capability validation and tool execution', async () => {
    const priorEngine = new PolicyEngine(allowPolicy());
    const deniedEngine = new PolicyEngine({ ...allowPolicy(), rules: [] });
    const { pep, verifySignature, consume } = setup({ engine: deniedEngine });
    const execute = vi.fn(async () => 'must-not-run');
    const action = manifest();
    const ctx = executionContext(deniedEngine);
    const priorContext = executionContext(priorEngine, { policy_hash: priorEngine.policy_hash });
    const staleToken = tokenFor(priorEngine, action, risk(), priorContext);

    await expectDenied(
      pep.enforce({ manifest: action, risk: risk(), token: staleToken, context: ctx }, execute),
      'policy_denied',
    );

    expect(verifySignature).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes exactly once only after policy, capability and consumption checks pass', async () => {
    const { engine, pep, verifySignature, consume } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    const token = tokenFor(engine, action, risk(), ctx);
    const execute = vi.fn(async () => ({ ok: true }));

    await expect(pep.enforce({ manifest: action, risk: risk(), token, context: ctx }, execute)).resolves.toEqual(
      { ok: true },
    );

    expect(verifySignature).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledWith(TOKEN_ID);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('accepts a token minted for the same semantic decision at an earlier instant', async () => {
    const engine = new PolicyEngine(allowPolicy());
    const { pep } = setup({
      engine,
      now: () => '2026-01-01T00:00:30.000Z',
    });
    const action = manifest();
    const mintContext = executionContext(engine);
    const token = tokenFor(engine, action, risk(), mintContext);

    await expect(
      pep.enforce(
        { manifest: action, risk: risk(), token, context: mintContext },
        async () => 'executed',
      ),
    ).resolves.toBe('executed');
  });

  it('rejects an invalid signature through the injected Authorization Service boundary', async () => {
    const { engine, pep, consume } = setup({ verify_signature: async () => false });
    const action = manifest();
    const ctx = executionContext(engine);
    const execute = vi.fn();

    await expectDenied(
      pep.enforce({ manifest: action, risk: risk(), token: tokenFor(engine, action, risk(), ctx), context: ctx }, execute),
      'invalid_signature',
    );
    expect(consume).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an already consumed capability atomically', async () => {
    const { engine, pep } = setup({ consume: async () => false });
    const action = manifest();
    const ctx = executionContext(engine);
    const execute = vi.fn();

    await expectDenied(
      pep.enforce({ manifest: action, risk: risk(), token: tokenFor(engine, action, risk(), ctx), context: ctx }, execute),
      'capability_used',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not expose a method that executes without an enforcement request', () => {
    const { pep } = setup();

    expect(pep).not.toHaveProperty('executeUnchecked');
    expect(pep).not.toHaveProperty('bypass');
  });

  it('rejects a network destination through the effective egress policy before token consumption', async () => {
    const { engine, pep, consume } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    const networkRisk = risk({
      locality: 'remote',
      network_access: true,
      egress_policy: {
        mode: 'allowlist',
        domain_rules: [{ action: 'allow', host: 'api.example.com' }],
      },
    });
    const execute = vi.fn();

    await expectDenied(
      pep.enforce(
        {
          manifest: action,
          risk: networkRisk,
          token: tokenFor(engine, action, networkRisk, ctx),
          context: ctx,
          egress: {
            destination: 'https://evil.example.net/data',
            resolve_host: async () => ['203.0.113.10'],
          },
        },
        execute,
      ),
      'egress_host_not_allowed',
    );

    expect(consume).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes a network action only after destination and DNS binding validation', async () => {
    const { engine, pep } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    const networkRisk = risk({
      locality: 'remote',
      network_access: true,
      egress_policy: {
        mode: 'allowlist',
        domain_rules: [{ action: 'allow', host: 'api.example.com' }],
      },
    });

    const execute = vi.fn(async (authorization: unknown) => authorization);
    await expect(
      pep.enforce(
        {
          manifest: action,
          risk: networkRisk,
          token: tokenFor(engine, action, networkRisk, ctx),
          context: ctx,
          egress: {
            destination: 'https://api.example.com/data',
            pinned_addresses: ['203.0.113.10'],
            resolve_host: async () => ['203.0.113.10'],
          },
        },
        execute,
      ),
    ).resolves.toMatchObject({
      policy_decision_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      egress: {
        canonical_host: 'api.example.com',
        resolved_addresses: ['203.0.113.10'],
      },
    });
    expect(Object.isFrozen(execute.mock.calls[0]![0])).toBe(true);
  });
});

describe('AH-POLICY-ENGINE-001: token time validation', () => {
  it('rejects malformed date-time strings', async () => {
    const { engine, pep } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    const execute = vi.fn();

    for (const field of ['issued_at', 'not_before', 'expires_at'] as const) {
      const token = tokenFor(engine, action, risk(), ctx, { [field]: 'not-a-date' });
      await expectDenied(pep.enforce({ manifest: action, risk: risk(), token, context: ctx }, execute), 'invalid_time');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a token before not_before and permits the exact not_before boundary', async () => {
    const { engine, pep } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    const future = tokenFor(engine, action, risk(), ctx, { not_before: '2026-01-01T00:00:00.001Z' });

    await expectDenied(
      pep.enforce({ manifest: action, risk: risk(), token: future, context: ctx }, vi.fn()),
      'not_yet_valid',
    );
    await expect(
      pep.enforce(
        { manifest: action, risk: risk(), token: tokenFor(engine, action, risk(), ctx), context: ctx },
        async () => 'ok',
      ),
    ).resolves.toBe('ok');
  });

  it('treats expires_at as an exclusive boundary', async () => {
    const { engine, pep } = setup();
    const action = manifest();
    const ctx = executionContext(engine);

    await expectDenied(
      pep.enforce(
        {
          manifest: action,
          risk: risk(),
          token: tokenFor(engine, action, risk(), ctx, {
            not_before: '2025-12-31T23:59:30.000Z',
            expires_at: NOW,
          }),
          context: ctx,
        },
        vi.fn(),
      ),
      'expired',
    );
  });

  it('rejects an expired ActionManifest even when the capability token is still valid', async () => {
    const { engine, pep } = setup();
    const action = manifest({ expires_at: NOW });
    const ctx = executionContext(engine);

    await expectDenied(
      pep.enforce(
        { manifest: action, risk: risk(), token: tokenFor(engine, action, risk(), ctx), context: ctx },
        vi.fn(),
      ),
      'manifest_expired',
    );
  });

  it('rejects invalid temporal ordering', async () => {
    const { engine, pep } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    const invalid = tokenFor(engine, action, risk(), ctx, {
     issued_at: '2026-01-01T00:00:30.000Z',
     not_before: '2026-01-01T00:00:15.000Z',
    });

    await expectDenied(
      pep.enforce({ manifest: action, risk: risk(), token: invalid, context: ctx }, vi.fn()),
      'invalid_time_order',
    );
  });
});

describe('AH-POLICY-ENGINE-001: PEP binds every authorization dimension', () => {
  const mismatchCases: Array<{
    name: string;
    reason: string;
    token?: Partial<CapabilityToken>;
    context?: (engine: PolicyEngine) => Partial<PepExecutionContext>;
    action?: Partial<ActionManifest>;
  }> = [
    { name: 'tenant', reason: 'wrong_tenant', token: { tenant_id: 'tenant-2' } },
    { name: 'audience', reason: 'wrong_audience', token: { audience: 'another-host' } },
    { name: 'workload', reason: 'wrong_workload', token: { subject_workload: 'another-runtime' } },
    { name: 'operation', reason: 'wrong_operation', token: { operation_id: 'operation-2' } },
    { name: 'attempt', reason: 'wrong_attempt', token: { attempt_id: 'attempt-2' } },
    { name: 'execution epoch', reason: 'wrong_execution_epoch', token: { execution_epoch: 'epoch-2' } },
    { name: 'manifest hash', reason: 'wrong_manifest_hash', token: { manifest_hash: HASH_A } },
    { name: 'tool grant', reason: 'wrong_tool_grant', token: { tool_grant_hash: HASH_A } },
    { name: 'resource grant', reason: 'wrong_resource_grant', token: { resource_grant_hash: HASH_A } },
    { name: 'budget ceiling', reason: 'wrong_budget_ceiling', token: { budget_ceiling_hash: HASH_A } },
    { name: 'tool effect contract', reason: 'wrong_tool_effect_contract', token: { tool_effect_contract_hash: HASH_A } },
    { name: 'confirmation key', reason: 'wrong_confirmation_key', token: { confirmation_key_thumbprint: 'other-key' } },
    {
      name: 'policy hash',
      reason: 'wrong_policy_hash',
      context: () => ({ policy_hash: HASH_A }),
    },
    {
      name: 'policy version',
      reason: 'wrong_policy_version',
      action: { policy_version: 'policy-v0' },
    },
  ];

  for (const mismatch of mismatchCases) {
    it(`rejects a mismatched ${mismatch.name}`, async () => {
      const { engine, pep } = setup();
      const action = manifest(mismatch.action);
      const ctx = executionContext(engine, mismatch.context?.(engine));
      const token = tokenFor(engine, manifest(), risk(), executionContext(engine), mismatch.token);
      const execute = vi.fn();

      await expectDenied(pep.enforce({ manifest: action, risk: risk(), token, context: ctx }, execute), mismatch.reason);
      expect(execute).not.toHaveBeenCalled();
    });
  }

  it('rejects a policy decision hash produced for different action data', async () => {
    const { engine, pep } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    const token = tokenFor(engine, action, risk(), ctx, { policy_decision_hash: HASH_A });

    await expectDenied(
      pep.enforce({ manifest: action, risk: risk(), token, context: ctx }, vi.fn()),
      'wrong_policy_decision',
    );
  });

  it('requires use_limit to remain exactly one', async () => {
    const { engine, pep } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    const malformed = { ...tokenFor(engine, action, risk(), ctx), use_limit: 2 } as unknown as CapabilityToken;

    await expectDenied(
      pep.enforce({ manifest: action, risk: risk(), token: malformed, context: ctx }, vi.fn()),
      'invalid_use_limit',
    );
  });
});

describe('AH-POLICY-ENGINE-001: every allow and deny is audit logged without sensitive input', () => {
  it('writes an immutable allow audit event', async () => {
    const { engine, events, pep } = setup();
    const action = manifest();
    const ctx = executionContext(engine);
    await pep.enforce(
      { manifest: action, risk: risk(), token: tokenFor(engine, action, risk(), ctx), context: ctx },
      async () => 'ok',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'allow',
      reason_code: 'authorized',
      policy_hash: engine.policy_hash,
      token_id: TOKEN_ID,
      manifest_hash: HASH_B,
    });
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(JSON.stringify(events[0])).not.toContain('must-not-log');
    expect(JSON.stringify(events[0])).not.toContain('private-name.txt');
  });

  it('writes one immutable deny audit event when policy rejects the action', async () => {
    const deniedEngine = new PolicyEngine({ ...allowPolicy(), rules: [] });
    const { events, pep } = setup({ engine: deniedEngine });
    const action = manifest();
    const ctx = executionContext(deniedEngine);
    const token = { ...tokenFor(new PolicyEngine(allowPolicy())), tenant_id: ctx.tenant_id };

    await expectDenied(
      pep.enforce({ manifest: action, risk: risk(), token, context: ctx }, vi.fn()),
      'policy_denied',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'deny', reason_code: 'policy_denied' });
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it('fails closed when the audit sink cannot record the authorization decision', async () => {
    const engine = new PolicyEngine(allowPolicy());
    const pep = new PolicyEnforcementPoint({
      policy_engine: engine,
      capability_authority: { verify_signature: async () => true, consume: async () => true },
      audit_sink: { write: async () => Promise.reject(new Error('disk detail')) },
      now: () => NOW,
    });
    const action = manifest();
    const ctx = executionContext(engine);
    const execute = vi.fn();

    await expect(pep.enforce({ manifest: action, risk: risk(), token: tokenFor(engine, action, risk(), ctx), context: ctx }, execute)).rejects.toMatchObject({
      name: 'PepDeniedError',
      reason_code: 'audit_failed',
    } satisfies Partial<PepDeniedError>);
    expect(execute).not.toHaveBeenCalled();
  });
});
