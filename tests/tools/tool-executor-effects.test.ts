import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ToolSpec } from '../../contracts/index.js';
import { AuthorizationService } from '../../security/authorization-service.js';
import { InMemoryCapabilityStateStore } from '../../security/capability.js';
import { PolicyEnforcementPoint } from '../../security/pep.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { DurableSession } from '../../session/durable-session.js';
import {
  ToolExecutor,
  ToolExecutorError,
  type EffectJournalPort,
  type EffectJournalRecord,
  type ToolCredentialBrokerPort,
  type ToolExecutorInjectedDeps,
} from '../../tools/tool-executor.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { VirtualFilesystem } from '../../vfs/virtual-filesystem.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CONTEXT = Object.freeze({
  tenant_id: 'tenant-1',
  user_id: 'user-1',
  run_id: 'run-1',
  plan_id: 'plan-1',
  step_id: 'step-1',
  attempt_id: 'attempt-1',
  operation_id: 'operation-1',
  idempotency_key: 'idempotency-1',
  confirmation_key_thumbprint: 'thumbprint-1',
});

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

function definition(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: 'read_file',
    version: '1.0.0',
    domains: ['coding'],
    implementation_status: 'implemented',
    input_schema_ref: 'in.json',
    output_schema_ref: 'out.json',
    effect_model: {
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
    },
    risk_feature_extractor: 'default',
    preconditions: [],
    postconditions: [],
    timeout_policy: {},
    cancellation_policy: {},
    retry_policy: {},
    idempotency_policy: {},
    sandbox_policy: {},
    network_policy: {},
    credential_requirements: [],
    data_egress_policy: {},
    receipt_schema_ref: 'receipt.json',
    verification_adapter: 'read_back',
    maturity: 'draft',
    ...overrides,
  } as ToolSpec;
}

class Journal implements EffectJournalPort {
  readonly records: EffectJournalRecord[] = [];
  readonly receipts: Array<{ operationId: string; receipt: unknown }> = [];

  constructor(readonly existing: EffectJournalRecord | null = null) {}

  getOperationByIdempotencyKey(key: string): EffectJournalRecord | null {
    expect(key).toBe(CONTEXT.idempotency_key);
    return this.existing;
  }

  recordOperation(record: EffectJournalRecord): void {
    this.records.push(record);
  }

  recordReceipt(operationId: string, receipt: unknown): void {
    this.receipts.push({ operationId, receipt });
  }
}

function makeExecutor(options: {
  spec?: ToolSpec;
  journal?: EffectJournalPort;
  consent?: ToolExecutorInjectedDeps['consent'];
  credentialBroker?: ToolCredentialBrokerPort;
  postconditionVerifier?: ToolExecutorInjectedDeps['postconditionVerifier'];
  context?: ToolExecutorInjectedDeps['execCtx'];
  pep?: PolicyEnforcementPoint;
  allowedTools?: string[];
} = {}) {
  const registry = new ToolRegistry();
  registry.register(options.spec ?? definition());
  const snapshot = registry.freezeSnapshot();
  const policyEngine = new PolicyEngine({
    version: 'policy-v1',
    default_decision: 'deny',
    allowed_tools: options.allowedTools ?? ['read_file'],
    allowed_resource_prefixes: ['/workspace'],
    rules: [
      {
        id: 'allow-read',
        priority: 1,
        effect: 'allow',
        tools: ['read_file'],
        resource_prefixes: ['/workspace'],
      },
    ],
  } as Policy);
  const session = new DurableSession(`session-${randomUUID()}`);
  session.acquireWriter();
  const stateStore = new InMemoryCapabilityStateStore();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const authz = new AuthorizationService({
    private_key: privateKey,
    public_key: publicKey,
    state_store: stateStore,
    now: () => NOW,
  });
  const consumed = new Set<string>();
  const defaultPep = new PolicyEnforcementPoint({
    policy_engine: policyEngine,
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
    audit_sink: { write: async () => {} },
    now: () => NOW,
  });
  const executor = new ToolExecutor(
    {
      toolRegistry: registry,
      snapshot,
      vfs: new VirtualFilesystem([
        { prefix: '/workspace', read: true, write: true },
      ]),
      policyEngine,
      session,
    },
    {
      authz,
      pep: options.pep ?? defaultPep,
      stateStore,
      now: () => NOW,
      execCtx: options.context === undefined ? CONTEXT : options.context,
      ...(options.journal === undefined ? {} : { effectJournal: options.journal }),
      ...(options.consent === undefined ? {} : { consent: options.consent }),
      ...(options.credentialBroker === undefined
        ? {}
        : { credentialBroker: options.credentialBroker }),
      ...(options.postconditionVerifier === undefined
        ? {}
        : { postconditionVerifier: options.postconditionVerifier }),
    },
  );
  return { executor, session };
}

function confirmedRecord(receiptJson: string | null): EffectJournalRecord {
  return {
    operation_id: CONTEXT.operation_id,
    run_id: CONTEXT.run_id,
    step_id: CONTEXT.step_id,
    attempt_id: CONTEXT.attempt_id,
    tool_name: 'read_file',
    idempotency_key: CONTEXT.idempotency_key,
    effect_state: 'EFFECT_CONFIRMED',
    receipt_json: receiptJson,
  };
}

describe('ToolExecutor durable effect contracts', () => {
  it('has stable error identity', () => {
    const error = new ToolExecutorError('reason');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ToolExecutorError');
    expect(error.message).toBe('reason');
  });

  it('fails with exact identity when execution context, snapshot, or policy is absent', async () => {
    const withoutContext = makeExecutor({ context: undefined }).executor;
    // The helper defaults undefined to the normal context, so explicitly erase
    // the injected authority to exercise the fail-closed production boundary.
    (
      withoutContext as unknown as {
        injected: { execCtx?: ToolExecutorInjectedDeps['execCtx'] };
      }
    ).injected.execCtx = undefined;
    await expect(
      withoutContext.execute('read_file', {}, async () => 'x'),
    ).rejects.toThrowError(
      'ExecutionContext is required — no default identity allowed',
    );

    const normal = makeExecutor().executor;
    await expect(
      normal.execute('outside_snapshot', {}, async () => 'x'),
    ).rejects.toThrowError('tool not in frozen snapshot: outside_snapshot');

    const denied = makeExecutor({ allowedTools: ['ask_user'] });
    await expect(
      denied.executor.execute(
        'read_file',
        { path: '/workspace/a.txt' },
        async () => 'x',
      ),
    ).rejects.toThrowError('policy denied: read_file not in allowed_tools');
    expect(denied.session.getEvents().at(-1)).toMatchObject({
      type: 'error',
      data: {
        tool: 'read_file',
        reason: 'policy denied: not in allowed_tools',
      },
    });
  });

  it('builds the exact ActionManifest from resources, conditions, and credential scopes', async () => {
    let captured:
      | {
          manifest: {
            resource_ids: string[];
            preconditions: Record<string, unknown>;
            expected_postconditions: Record<string, unknown>;
            reads: string[];
            writes: string[];
            credential_scope: string[];
            side_effect_class: string;
          };
        }
      | undefined;
    const enforce = vi.fn(async (request: unknown, effect: () => Promise<unknown>) => {
      captured = request as typeof captured;
      return effect();
    });
    const pep = { enforce } as unknown as PolicyEnforcementPoint;
    const clear = vi.fn();
    const credentialBroker: ToolCredentialBrokerPort = {
      exchange: vi.fn(async () => ({ values: {}, clear })),
    };
    const tool = definition({
      preconditions: [{ id: 'named-pre', kind: 'exists' }, { kind: 'readable' }],
      postconditions: [
        { id: 'named-post', kind: 'unchanged' },
        { kind: 'verified' },
      ],
      credential_requirements: [
        { name: 'api' },
        { scope: 'write' },
        {},
      ],
    });
    const { executor } = makeExecutor({ spec: tool, pep, credentialBroker });
    const input = {
      path: '/workspace/a.txt',
      root: '/workspace',
      cwd: '/workspace/sub',
      sources: ['/workspace/a', 42, '/workspace/b'],
      extra: true,
    };
    await executor.execute('read_file', input, async () => 'done');

    expect(enforce).toHaveBeenCalledOnce();
    expect(captured?.manifest).toMatchObject({
      resource_ids: [
        '/workspace/a.txt',
        '/workspace',
        '/workspace/sub',
        '/workspace/a',
        '/workspace/b',
      ],
      preconditions: {
        'named-pre': { id: 'named-pre', kind: 'exists' },
        '1': { kind: 'readable' },
      },
      expected_postconditions: {
        'named-post': { id: 'named-post', kind: 'unchanged' },
        '1': { kind: 'verified' },
      },
      reads: ['path', 'root', 'cwd', 'sources', 'extra'],
      writes: [],
      credential_scope: ['api', 'write', 'credential'],
      side_effect_class: 'read_only',
    });
    expect(clear).toHaveBeenCalledOnce();
  });

  it('records the exact effect lifecycle and receipt', async () => {
    const journal = new Journal();
    const { executor, session } = makeExecutor({ journal });
    const input = { path: '/workspace/a.txt' };
    const output = { content: 'hello' };
    const result = await executor.execute('read_file', input, async () => output);

    expect(result.result).toBe(output);
    expect(result.receipt).toMatchObject({
      tool_name: 'read_file',
      success: true,
      input_hash: digest(input),
      output_hash: digest(output),
      policy_decision: 'allow',
      derived_risk_tier: 1,
      side_effect_class: 'read_only',
    });
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(journal.records.map((record) => record.effect_state)).toEqual([
      'PRE_DISPATCH',
      'IN_FLIGHT',
      'EFFECT_CONFIRMED',
    ]);
    const base = {
      operation_id: CONTEXT.operation_id,
      run_id: CONTEXT.run_id,
      step_id: CONTEXT.step_id,
      attempt_id: CONTEXT.attempt_id,
      tool_name: 'read_file',
      idempotency_key: CONTEXT.idempotency_key,
      receipt_json: null,
    };
    expect(journal.records[0]).toEqual({
      ...base,
      effect_state: 'PRE_DISPATCH',
    });
    expect(journal.records[1]).toEqual({ ...base, effect_state: 'IN_FLIGHT' });
    const { receipt_json: _receiptJson, ...confirmedBase } = base;
    expect(journal.records[2]).toMatchObject({
      ...confirmedBase,
      effect_state: 'EFFECT_CONFIRMED',
      receipt_json: expect.any(String),
    });
    expect(JSON.parse(journal.records[2]!.receipt_json!)).toEqual(result);
    expect(journal.receipts).toEqual([
      {
        operationId: CONTEXT.operation_id,
        receipt: {
          tool_name: result.receipt.tool_name,
          success: true,
          input_hash: result.receipt.input_hash,
          output_hash: result.receipt.output_hash,
          duration_ms: result.receipt.duration_ms,
          timestamp: result.receipt.timestamp,
        },
      },
    ]);
    expect(session.getEvents().map((event) => event.type)).toContain('tool_call');
    expect(session.getEvents().map((event) => event.type)).toContain('tool_result');
  });

  it('replays an exactly matching confirmed effect without invoking it again', async () => {
    const input = { path: '/workspace/a.txt' };
    const stored = {
      result: { content: 'stored' },
      receipt: {
        tool_name: 'read_file',
        timestamp: NOW,
        success: true,
        duration_ms: 7,
        input_hash: digest(input),
        output_hash: digest({ content: 'stored' }),
      },
    };
    const journal = new Journal(confirmedRecord(JSON.stringify(stored)));
    const { executor, session } = makeExecutor({ journal });
    const effect = vi.fn(async () => ({ content: 'new' }));

    await expect(executor.execute('read_file', input, effect)).resolves.toEqual(
      stored,
    );
    expect(effect).not.toHaveBeenCalled();
    expect(journal.records).toEqual([]);
    expect(session.getEvents().at(-1)).toMatchObject({
      type: 'tool_result',
      data: { tool: 'read_file', receipt: stored.receipt, replayed: true },
    });
  });

  it.each([
    ['run_id', { run_id: 'other-run' }],
    ['operation_id', { operation_id: 'other-operation' }],
    ['tool_name', { tool_name: 'other-tool' }],
  ])('rejects confirmed replay with mismatched %s', async (_field, recordPatch) => {
    const input = { path: '/workspace/a.txt' };
    const stored = {
      result: 'stored',
      receipt: {
        tool_name: 'read_file',
        timestamp: NOW,
        success: true,
        duration_ms: 1,
        input_hash: digest(input),
      },
    };
    const journal = new Journal({
      ...confirmedRecord(JSON.stringify(stored)),
      ...recordPatch,
    });
    const { executor } = makeExecutor({ journal });
    await expect(
      executor.execute('read_file', input, async () => 'new'),
    ).rejects.toThrowError(
      'stored effect outcome is invalid: stored outcome does not match action identity',
    );
  });

  it.each([
    ['missing receipt', { result: 'stored' }],
    [
      'receipt tool',
      {
        result: 'stored',
        receipt: {
          tool_name: 'other',
          timestamp: NOW,
          success: true,
          duration_ms: 1,
          input_hash: digest({ path: '/workspace/a.txt' }),
        },
      },
    ],
    [
      'input hash',
      {
        result: 'stored',
        receipt: {
          tool_name: 'read_file',
          timestamp: NOW,
          success: true,
          duration_ms: 1,
          input_hash: 'wrong',
        },
      },
    ],
    [
      'unsuccessful receipt',
      {
        result: 'stored',
        receipt: {
          tool_name: 'read_file',
          timestamp: NOW,
          success: false,
          duration_ms: 1,
          input_hash: digest({ path: '/workspace/a.txt' }),
        },
      },
    ],
  ])('rejects confirmed replay with %s', async (_case, stored) => {
    const journal = new Journal(confirmedRecord(JSON.stringify(stored)));
    const { executor } = makeExecutor({ journal });
    await expect(
      executor.execute(
        'read_file',
        { path: '/workspace/a.txt' },
        async () => 'new',
      ),
    ).rejects.toThrowError(
      'stored effect outcome is invalid: stored outcome does not match action identity',
    );
  });

  it('rejects confirmed effects with no or malformed stored outcome', async () => {
    const noReceipt = makeExecutor({
      journal: new Journal(confirmedRecord(null)),
    }).executor;
    await expect(
      noReceipt.execute(
        'read_file',
        { path: '/workspace/a.txt' },
        async () => 'new',
      ),
    ).rejects.toThrowError('confirmed effect is missing its stored outcome');

    const malformed = makeExecutor({
      journal: new Journal(confirmedRecord('{bad json')),
    }).executor;
    await expect(
      malformed.execute(
        'read_file',
        { path: '/workspace/a.txt' },
        async () => 'new',
      ),
    ).rejects.toThrowError(/^stored effect outcome is invalid:/);
  });

  it.each([
    'IN_FLIGHT',
    'EFFECT_UNKNOWN',
    'RECONCILING',
    'AWAITING_HUMAN',
  ] as const)(
    'requires reconciliation for %s',
    async (effectState) => {
      const journal = new Journal({
        ...confirmedRecord(null),
        effect_state: effectState,
      });
      const { executor } = makeExecutor({ journal });
      await expect(
        executor.execute(
          'read_file',
          { path: '/workspace/a.txt' },
          async () => 'new',
        ),
      ).rejects.toThrowError(`effect requires reconciliation: ${effectState}`);
      expect(journal.records).toEqual([]);
    },
  );

  it.each([
    [
      { granted: false, level: 'explicit', reason: 'user rejected' },
      'user rejected',
    ],
    [{ granted: false, level: 'explicit' }, 'explicit'],
  ])('fails closed on denied consent', async (consent, reason) => {
    const request = vi.fn(async () => consent);
    const { executor, session } = makeExecutor({
      consent: { request } as unknown as ToolExecutorInjectedDeps['consent'],
    });
    await expect(
      executor.execute('read_file', { path: '/workspace/a.txt' }, async () => 'x'),
    ).rejects.toThrowError(`consent denied: ${reason}`);
    expect(request).toHaveBeenCalledWith({
      tool_name: 'read_file',
      risk_tier: 1,
      manifest_preview: JSON.stringify({
        tool_name: 'read_file',
        resource_ids: ['/workspace/a.txt'],
        side_effect_class: 'read_only',
      }),
    });
    expect(session.getEvents().at(-1)).toMatchObject({
      type: 'error',
      data: { tool: 'read_file', reason: `consent denied: ${reason}` },
    });
  });

  it('injects leased credentials only inside the effect and clears them', async () => {
    const secret = new Uint8Array([1, 2, 3]);
    const clear = vi.fn();
    const exchange = vi.fn(async () => ({
      values: { api: secret },
      clear,
    }));
    const { executor } = makeExecutor({
      spec: definition({
        credential_requirements: [{ name: 'api', scope: 'read' }],
      }),
      credentialBroker: { exchange },
    });
    const effect = vi.fn(async (deps) => deps.credentials?.api);
    await expect(
      executor.execute('read_file', { path: '/workspace/a.txt' }, effect),
    ).resolves.toMatchObject({ result: secret });
    expect(exchange).toHaveBeenCalledWith({
      tool_name: 'read_file',
      requirements: [{ name: 'api', scope: 'read' }],
      operation_id: CONTEXT.operation_id,
      token_id: expect.any(String),
    });
    expect(effect).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { api: secret } }),
    );
    expect(clear).toHaveBeenCalledOnce();
  });

  it('requires a broker and marks the already-started effect unknown', async () => {
    const journal = new Journal();
    const { executor } = makeExecutor({
      spec: definition({ credential_requirements: [{ scope: 'read' }] }),
      journal,
    });
    await expect(
      executor.execute('read_file', { path: '/workspace/a.txt' }, async () => 'x'),
    ).rejects.toThrowError('credential broker required for tool: read_file');
    expect(journal.records.map((record) => record.effect_state)).toEqual([
      'PRE_DISPATCH',
      'IN_FLIGHT',
      'EFFECT_UNKNOWN',
    ]);
  });

  it.each([
    [{ valid: false, reason: 'wrong bytes' }, 'wrong bytes'],
    [{ valid: false }, 'unspecified'],
  ])('rejects failed postconditions', async (verification, reason) => {
    const journal = new Journal();
    const verify = vi.fn(async () => verification);
    const { executor } = makeExecutor({
      journal,
      postconditionVerifier: { verify },
    });
    await expect(
      executor.execute('read_file', { path: '/workspace/a.txt' }, async () => ({
        content: 'x',
      })),
    ).rejects.toThrowError(`postcondition verification failed: ${reason}`);
    expect(verify).toHaveBeenCalledWith({
      tool: expect.objectContaining({ name: 'read_file' }),
      result: { content: 'x' },
    });
    expect(journal.records.at(-1)?.effect_state).toBe('EFFECT_UNKNOWN');
  });
});
