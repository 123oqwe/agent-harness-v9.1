import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  ActionExecutor,
  DeclaredPostconditionVerifier,
} from '../../security/action-executor.js';
import { AuditSink } from '../../security/audit-sink.js';
import { AuthorizationService } from '../../security/authorization-service.js';
import { InMemoryCapabilityStateStore } from '../../security/capability.js';
import { ConsentService, deriveConsentLevel } from '../../security/consent.js';
import { PolicyEnforcementPoint } from '../../security/pep.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { DurableSession } from '../../session/durable-session.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';
import {
  type ToolCredentialBrokerPort,
  type EffectJournalPort,
  type EffectJournalRecord,
  type ToolExecutorDeps,
} from '../../tools/tool-executor.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import type { ToolSpec } from '../../contracts/index.js';

const now = new Date().toISOString();

function build(options?: {
  consent?: ConsentService;
  tool?: ToolSpec;
  broker?: ToolCredentialBrokerPort;
  journal?: EffectJournalPort;
  postconditionValid?: boolean;
}) {
  const tool =
    options?.tool ??
    createPhase1ToolDefinitions().find((entry) => entry.name === 'write_file')!;
  const registry = new ToolRegistry();
  registry.register(tool);
  const snapshot = registry.freezeSnapshot();
  const policy = new PolicyEngine({
    version: 'v1',
    default_decision: 'deny',
    allowed_tools: [tool.name],
    allowed_resource_prefixes: ['/workspace'],
    minimum_risk_tier: 3,
    rules: [
      {
        id: 'allow',
        priority: 1,
        effect: 'allow',
        tools: [tool.name],
        resource_prefixes: ['/workspace'],
      },
    ],
  } as Policy);
  const stateStore = new InMemoryCapabilityStateStore();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const authz = new AuthorizationService({
    private_key: privateKey,
    public_key: publicKey,
    state_store: stateStore,
    now: () => now,
  });
  const consumed = new Set<string>();
  const pep = new PolicyEnforcementPoint({
    policy_engine: policy,
    capability_authority: {
      verify_signature: async (token) => {
        try {
          return Boolean(await stateStore.read(token.token_id));
        } catch {
          return false;
        }
      },
      consume: async (tokenId) => {
        if (consumed.has(tokenId)) return false;
        consumed.add(tokenId);
        return true;
      },
    },
    audit_sink: { write: async () => undefined },
    now: () => now,
  });
  const session = new DurableSession('session');
  session.acquireWriter();
  const auditSink = new AuditSink();
  const consent =
    options?.consent ??
    new ConsentService(async (request) => ({
      granted: true,
      level: deriveConsentLevel(request.risk_tier),
      timestamp: now,
    }));
  const deps: ToolExecutorDeps = {
    toolRegistry: registry,
    snapshot,
    vfs: new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]),
    policyEngine: policy,
    session,
  };
  const executor = new ActionExecutor(deps, {
    authz,
    pep,
    stateStore,
    now: () => now,
    consent,
    auditSink,
    postconditionVerifier:
      options?.postconditionValid === undefined
        ? new DeclaredPostconditionVerifier()
        : {
            verify: async () => ({
              valid: options.postconditionValid!,
              ...(options.postconditionValid
                ? {}
                : { reason: 'verification adapter rejected output' }),
            }),
          },
    ...(options?.broker === undefined
      ? {}
      : { credentialBroker: options.broker }),
    ...(options?.journal === undefined
      ? {}
      : { effectJournal: options.journal }),
    execCtx: {
      tenant_id: 'tenant',
      user_id: 'user',
      run_id: 'run',
      plan_id: 'plan',
      step_id: 'step',
      attempt_id: 'attempt',
      operation_id: 'operation',
      idempotency_key: 'idempotency',
      confirmation_key_thumbprint: 'thumbprint',
    },
  });
  return { executor, authz, auditSink, session };
}

describe('ActionExecutor production authority', () => {
  it('denies consent before capability issuance and before the effect', async () => {
    const consent = new ConsentService(async (request) => ({
      granted: false,
      level: deriveConsentLevel(request.risk_tier),
      reason: 'user denied',
      timestamp: now,
    }));
    const { executor, authz, auditSink } = build({ consent });
    const issue = vi.spyOn(authz, 'issue');
    const effect = vi.fn(async () => ({ bytes_written: 1 }));

    await expect(
      executor.execute(
        'write_file',
        { path: '/workspace/a', content: 'x' },
        effect,
      ),
    ).rejects.toThrow('consent denied');
    expect(issue).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    expect(auditSink.getDenied()).toHaveLength(1);
  });

  it('exchanges scoped credentials only inside PEP and clears the lease', async () => {
    const secret = new Uint8Array([11, 22, 33]);
    const order: string[] = [];
    const broker: ToolCredentialBrokerPort = {
      exchange: async () => {
        order.push('exchange');
        return {
          values: { API_TOKEN: secret },
          clear: () => {
            secret.fill(0);
            order.push('clear');
          },
        };
      },
    };
    const base = createPhase1ToolDefinitions().find(
      (entry) => entry.name === 'read_file',
    )!;
    const tool: ToolSpec = {
      ...base,
      effect_model: { ...base.effect_model, credential_access: true },
      credential_requirements: [{ name: 'API_TOKEN' }],
    };
    const { executor, auditSink } = build({ tool, broker });

    const outcome = await executor.execute(
      'read_file',
      { path: '/workspace/a' },
      async (deps) => {
        order.push('effect');
        expect(deps.credentials?.API_TOKEN).toEqual(
          new Uint8Array([11, 22, 33]),
        );
        return { content: 'ok', encoding: 'utf8', size: 2 };
      },
    );

    expect(outcome.receipt.success).toBe(true);
    expect(order).toEqual(['exchange', 'effect', 'clear']);
    expect(secret).toEqual(new Uint8Array([0, 0, 0]));
    expect(auditSink.getAllowed()).toHaveLength(1);
  });

  it('turns postcondition rejection into a failed action audit', async () => {
    const { executor, auditSink, session } = build({
      postconditionValid: false,
    });

    await expect(
      executor.execute(
        'write_file',
        { path: '/workspace/a', content: 'x' },
        async () => ({ bytes_written: 1 }),
      ),
    ).rejects.toThrow('postcondition verification failed');
    expect(auditSink.getAllowed()).toHaveLength(0);
    expect(auditSink.getDenied()[0]?.reason).toContain(
      'verification adapter rejected output',
    );
    expect(
      session
        .getEvents()
        .some(
          (event) =>
            event.type === 'error' &&
            JSON.stringify(event.data).includes('postcondition verification failed'),
        ),
    ).toBe(true);
  });

  it('audits output-schema verification failure as deny, never allow', async () => {
    const { executor, auditSink } = build();

    await expect(
      executor.execute(
        'write_file',
        { path: '/workspace/a', content: 'x' },
        async () => ({ unexpected: true }),
        () => {
          throw new Error('output schema validation failed');
        },
      ),
    ).rejects.toThrow('output schema validation failed');
    expect(auditSink.getAllowed()).toHaveLength(0);
    expect(auditSink.getDenied()).toHaveLength(1);
  });

  it('returns a confirmed stored outcome without a second effect', async () => {
    const records = new Map<string, EffectJournalRecord>();
    const journal: EffectJournalPort = {
      getOperationByIdempotencyKey: (key) =>
        [...records.values()].find(
          (record) => record.idempotency_key === key,
        ) ?? null,
      recordOperation: (record) => {
        records.set(record.operation_id, Object.freeze({ ...record }));
      },
    };
    const { executor } = build({ journal });
    const effect = vi.fn(async () => ({ bytes_written: 1 }));

    const first = await executor.execute(
      'write_file',
      { path: '/workspace/a', content: 'x' },
      effect,
    );
    const replayed = await executor.execute(
      'write_file',
      { path: '/workspace/a', content: 'x' },
      effect,
    );

    expect(effect).toHaveBeenCalledTimes(1);
    expect(replayed).toEqual(first);
  });

  it('refuses to replay an in-flight or unknown effect', async () => {
    const state: EffectJournalRecord = {
      operation_id: 'operation',
      run_id: 'run',
      step_id: 'step',
      attempt_id: 'attempt',
      tool_name: 'write_file',
      idempotency_key: 'idempotency',
      effect_state: 'EFFECT_UNKNOWN',
      receipt_json: null,
    };
    const journal: EffectJournalPort = {
      getOperationByIdempotencyKey: () => state,
      recordOperation: () => undefined,
    };
    const { executor } = build({ journal });
    const effect = vi.fn(async () => ({ bytes_written: 1 }));

    await expect(
      executor.execute(
        'write_file',
        { path: '/workspace/a', content: 'x' },
        effect,
      ),
    ).rejects.toThrow('requires reconciliation');
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('DeclaredPostconditionVerifier fail-closed contracts', () => {
  const verifier = new DeclaredPostconditionVerifier();
  const base = createPhase1ToolDefinitions().find(
    (entry) => entry.name === 'write_file',
  )!;

  function withPostconditions(postconditions: unknown[]): ToolSpec {
    return {
      ...base,
      postconditions,
    } as ToolSpec;
  }

  it('rejects undefined results before inspecting declarations', async () => {
    await expect(
      verifier.verify({ tool: withPostconditions([]), result: undefined }),
    ).resolves.toEqual({
      valid: false,
      reason: 'tool returned undefined',
    });
  });

  it('accepts a declared required field only when an object owns that field', async () => {
    const tool = withPostconditions([
      { type: 'required_field', field: 'bytes_written' },
    ]);
    await expect(
      verifier.verify({ tool, result: { bytes_written: 0 } }),
    ).resolves.toEqual({ valid: true });
    for (const result of [{}, null, 'not-an-object']) {
      await expect(verifier.verify({ tool, result })).resolves.toEqual({
        valid: false,
        reason: 'required postcondition field missing: bytes_written',
      });
    }
  });

  it('rejects malformed required fields and unsupported declarations', async () => {
    await expect(
      verifier.verify({
        tool: withPostconditions([
          { type: 'required_field', field: 42 },
        ]),
        result: { 42: true },
      }),
    ).resolves.toEqual({
      valid: false,
      reason: 'required postcondition field missing: 42',
    });
    await expect(
      verifier.verify({
        tool: withPostconditions([{ type: 'self_reported_success' }]),
        result: { success: true },
      }),
    ).resolves.toEqual({
      valid: false,
      reason: 'unsupported postcondition: self_reported_success',
    });
  });
});

describe('ActionExecutor immutable audit envelope', () => {
  it('records exact allow fields with the required operation identity', async () => {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValueOnce(100).mockReturnValue(107);
    try {
      const { executor, auditSink } = build();
      const outcome = await executor.execute(
        'write_file',
        { path: '/workspace/a', content: 'x' },
        async () => ({ bytes_written: 1 }),
      );
      expect(auditSink.all).toHaveLength(1);
      expect(auditSink.all[0]).toMatchObject({
        tool_name: 'write_file',
        token_id: outcome.receipt.token_id,
        verdict: 'allow',
        risk_tier: outcome.receipt.derived_risk_tier,
        manifest_hash_match: true,
        reason: 'postconditions_verified',
        operation_id: 'operation',
        duration_ms: 7,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('normalizes non-Error failures into an exact deny audit', async () => {
    const { executor, auditSink } = build();
    await expect(
      executor.execute(
        'write_file',
        { path: '/workspace/a', content: 'x' },
        async () => {
          throw 'opaque failure';
        },
      ),
    ).rejects.toBe('opaque failure');
    expect(auditSink.getDenied()).toHaveLength(1);
    expect(auditSink.getDenied()[0]).toMatchObject({
      tool_name: 'write_file',
      verdict: 'deny',
      risk_tier: 0,
      manifest_hash_match: false,
      reason: 'opaque failure',
      operation_id: 'operation',
    });
    expect(auditSink.getDenied()[0]!.duration_ms).toBeGreaterThanOrEqual(1);
  });
});
