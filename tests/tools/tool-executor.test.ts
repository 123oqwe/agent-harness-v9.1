import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutor } from '../../tools/tool-executor.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { DurableSession } from '../../session/durable-session.js';
import { readFile } from '../../tools/read-file.js';
import type { ToolSpec } from '../../../spec/types/tool-spec.js';

function toolSpec(name: string): ToolSpec {
  return { name, version: '1.0.0', domains: ['coding'], implementation_status: 'implemented', input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: {}, risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r.json', verification_adapter: 'v', maturity: 'draft' } as ToolSpec;
}

describe('ToolExecutor unified pipeline', () => {
  let tmp: string, vfs: VirtualFilesystem, executor: ToolExecutor;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tex-'));
    const tr = new ToolRegistry();
    tr.register(toolSpec('read_file'));
    tr.register(toolSpec('write_file'));
    const snap = tr.freezeSnapshot();
    vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'allow-read', priority: 1, effect: 'allow', tools: ['read_file'], resource_prefixes: ['/workspace'] }] } as Policy);
    const session = new DurableSession('s1');
    session.acquireWriter();
    executor = new ToolExecutor({ toolRegistry: tr, snapshot: snap, vfs, policyEngine: pe, session });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('executes through the pipeline: snapshot check → policy → session audit → receipt', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello');
    const { result, receipt } = await executor.execute('read_file', { path: '/workspace/f.txt' }, async (deps) => {
      return readFile(deps.vfs, { path: '/workspace/f.txt' });
    });
    expect(result.content).toBe('hello');
    expect(receipt.tool_name).toBe('read_file');
    expect(receipt.success).toBe(true);
    expect(receipt.input_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects tool not in frozen snapshot', async () => {
    await expect(executor.execute('evil_tool', {}, async () => 'x')).rejects.toThrow();
  });

  it('rejects tool not in policy allowed list', async () => {
    await expect(executor.execute('write_file', {}, async () => 'x')).rejects.toThrow(/policy denied/);
  });

  it('records tool_call and tool_result in session event log', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'data');
    await executor.execute('read_file', { path: '/workspace/f.txt' }, async (deps) => readFile(deps.vfs, { path: '/workspace/f.txt' }));
    const events = executor['deps'].session.getEvents();
    expect(events.some(e => e.type === 'tool_call')).toBe(true);
    expect(events.some(e => e.type === 'tool_result')).toBe(true);
  });
});
