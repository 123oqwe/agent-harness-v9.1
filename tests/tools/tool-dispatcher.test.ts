import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolDispatcher,
  ToolDispatcherError,
  type ToolImplementation,
} from '../../tools/tool-dispatcher.js';
import { ToolExecutor } from '../../tools/tool-executor.js';
import { AuthorizationService } from '../../security/authorization-service.js';
import { InMemoryCapabilityStateStore } from '../../security/capability.js';
import { PolicyEnforcementPoint } from '../../security/pep.js';
import { generateKeyPairSync } from 'node:crypto';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { DurableSession } from '../../session/durable-session.js';
import { readFile } from '../../tools/read-file.js';
import type { ToolSpec } from '../../contracts/index.js';

function toolSpec(name: string): ToolSpec {
  return { name, version: '1.0.0', domains: ['coding'], implementation_status: 'implemented', input_schema_ref: 'schemas/read-file-input.json', output_schema_ref: 'schemas/read-file-output.json', effect_model: { operation: 'read' }, risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'schemas/receipt.json', verification_adapter: 'v', maturity: 'draft' } as ToolSpec;
}

describe('ToolDispatcher', () => {
  let tmp: string, vfs: VirtualFilesystem, executor: ToolExecutor;
  let tr: ToolRegistry, snap: ReturnType<ToolRegistry['freezeSnapshot']>, pe: PolicyEngine, session: DurableSession;
  let dispatcher: ToolDispatcher;
  let authz: AuthorizationService, pep: PolicyEnforcementPoint, stateStore: InMemoryCapabilityStateStore;
  const fixedNow = '2026-01-01T00:00:00.000Z';
  const execCtx = { tenant_id: 't', user_id: 'u', run_id: 'r', plan_id: 'p', step_id: 's', attempt_id: 'a', operation_id: 'o', idempotency_key: 'i', confirmation_key_thumbprint: 'th' };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'td-'));
    tr = new ToolRegistry();
    tr.register(toolSpec('read_file'));
    snap = tr.freezeSnapshot();
    vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'a', priority: 1, effect: 'allow', tools: ['read_file'], resource_prefixes: ['/workspace'] }] } as Policy);
    session = new DurableSession('s1');
    session.acquireWriter();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    stateStore = new InMemoryCapabilityStateStore();
    authz = new AuthorizationService({ private_key: privateKey, public_key: publicKey, state_store: stateStore, now: () => fixedNow });
    const consumed = new Set<string>();
    pep = new PolicyEnforcementPoint({ policy_engine: pe, capability_authority: { verify_signature: async (t) => { try { return !!(await stateStore.read(t.token_id)); } catch { return false; } }, consume: async (id) => { if (consumed.has(id)) return false; consumed.add(id); return true; } }, audit_sink: { write: async () => {} }, now: () => fixedNow });
    executor = new ToolExecutor({ toolRegistry: tr, snapshot: snap, vfs, policyEngine: pe, session }, { authz, pep, stateStore, now: () => fixedNow, execCtx });
    const implementations = new Map<string, ToolImplementation>([
      [
        'read_file',
        async (dependencies, input) =>
          readFile(dependencies.vfs, input as { path: string }),
      ],
    ]);
    dispatcher = new ToolDispatcher(tr, snap, executor, implementations);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('dispatches a valid tool call and returns success', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello');
    const r = await dispatcher.dispatch({ tool_name: 'read_file', input: { path: '/workspace/f.txt' } });
    expect(r.success).toBe(true);
    expect(r.result).toBeDefined();
    expect(r.receipt.success).toBe(true);
    expect(r.receipt.tool_name).toBe('read_file');
    expect(r.receipt.input_hash).toBeDefined();
    expect(r.receipt.duration_ms).toBeGreaterThanOrEqual(1);
  });

  it('throws ToolDispatcherError for tool not in frozen snapshot', async () => {
    await expect(dispatcher.dispatch({ tool_name: 'nonexistent', input: {} })).rejects.toThrow(ToolDispatcherError);
    await expect(dispatcher.dispatch({ tool_name: 'nonexistent', input: {} })).rejects.toThrow('not in frozen snapshot');
  });

  it('throws ToolDispatcherError for null input', async () => {
    const result = await dispatcher.dispatch({ tool_name: 'read_file', input: null });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('input is null') });
  });

  it('throws ToolDispatcherError for undefined input', async () => {
    const result = await dispatcher.dispatch({ tool_name: 'read_file', input: undefined });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('input is undefined') });
  });

  it('returns failure with receipt when executor throws', async () => {
    const r = await dispatcher.dispatch({ tool_name: 'read_file', input: { path: '/workspace/nonexistent.txt' } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ENOENT|file not found/);
    expect(r.receipt.success).toBe(false);
    expect(r.receipt.error).toMatch(/ENOENT|file not found/);
    expect(r.receipt.tool_name).toBe('read_file');
    expect(r.receipt.duration_ms).toBeGreaterThanOrEqual(1);
    expect(r.receipt.input_hash).toBeDefined();
  });

  it('returns failure when the frozen implementation throws', async () => {
    const failing = new ToolDispatcher(
      tr,
      snap,
      executor,
      new Map([
        ['read_file', async () => { throw new Error('custom error'); }],
      ]),
    );
    const r = await failing.dispatch({ tool_name: 'read_file', input: { path: '/workspace/f.txt' } });
    expect(r.success).toBe(false);
    expect(r.error).toContain('custom error');
    expect(r.receipt).toBeDefined();
  });

  it('receipt has correct timestamp format', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'data');
    const r = await dispatcher.dispatch({ tool_name: 'read_file', input: { path: '/workspace/f.txt' } });
    expect(r.receipt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('receipt input_hash is a 16-char hex string', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'data');
    const r = await dispatcher.dispatch({ tool_name: 'read_file', input: { path: '/workspace/f.txt' } });
    expect(r.receipt.input_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles string error in catch block', async () => {
    const failing = new ToolDispatcher(
      tr,
      snap,
      executor,
      new Map([
        ['read_file', async () => { throw 'string error' as unknown as Error; }],
      ]),
    );
    const r = await failing.dispatch({ tool_name: 'read_file', input: { path: '/workspace/f.txt' } });
    expect(r.success).toBe(false);
    expect(r.error).toBe('string error');
  });

  it('ToolDispatcherError has correct name', () => {
    const e = new ToolDispatcherError('test');
    expect(e.name).toBe('ToolDispatcherError');
    expect(e).toBeInstanceOf(Error);
  });

  it('can dispatch multiple tools sequentially', async () => {
    writeFileSync(join(tmp, 'f1.txt'), 'content1');
    writeFileSync(join(tmp, 'f2.txt'), 'content2');
    const r1 = await dispatcher.dispatch({ tool_name: 'read_file', input: { path: '/workspace/f1.txt' } });
    const r2 = await dispatcher.dispatch({ tool_name: 'read_file', input: { path: '/workspace/f2.txt' } });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.receipt.input_hash).not.toBe(r2.receipt.input_hash);
  });

  it('has no per-call implementation callback and rejects a missing frozen implementation', () => {
    expect(dispatcher.dispatch.length).toBe(1);
    expect(() => new ToolDispatcher(tr, snap, executor, new Map())).toThrow(
      'implementation not registered',
    );
  });

  it('fails closed on invalid input schema before executing an effect', async () => {
    const result = await dispatcher.dispatch({
      tool_name: 'read_file',
      input: { path: '/workspace/f.txt', unexpected: true },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('input schema validation failed');
    expect(session.getEvents().some((event) => event.type === 'tool_call')).toBe(false);
  });
});
