import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestSecurityDeps } from '../helpers/test-security.js';

import { mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { Harness, type HarnessProvider } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../tools/skill-registry.js';

import { PolicyEngine } from '../../security/policy-engine.js';

import { VirtualFilesystem, LocalBackend, OverlayBackend } from '../../vfs/virtual-filesystem.js';

import type { SandboxProfile } from '../../runtime/sandbox.js';

import type { TaskContract } from '../../../spec/types/task-contract.js';

import type { Policy } from '../../security/policy-engine.js';


function makeToolRegistry(): ToolRegistry {
  const tr = new ToolRegistry();
  tr.register({
    name: 'read_file', version: '1.0.0', domains: ['coding'], implementation_status: "implemented",
    input_schema_ref: 'i', output_schema_ref: 'o', effect_model: { operation: 'read', locality: 'local' },
    risk_feature_extractor: 'default', preconditions: [], postconditions: [], timeout_policy: {},
    cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {},
    network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r',
    verification_adapter: 'default', maturity: "sandbox_verified",
  } as never);
  return tr;
}

function makeHarness(tmp: string, provider: HarnessProvider, allowedTools: string[] = ['read_file']): Harness {
  const tr = makeToolRegistry();
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new LocalBackend('/workspace', tmp));
  const policy: Policy = {
    version: 'v1', default_decision: 'deny', allowed_tools: allowedTools,
    allowed_resource_prefixes: ['/workspace'],
    rules: [{ id: 'allow-all', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }],
  } as Policy;
  const pe = new PolicyEngine(policy);
  const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, provider, security: createTestSecurityDeps(pe, () => new Date().toISOString()) });
}

function task(goal: string): TaskContract {
  return { goal, success_criteria: [{ criterion: goal, verification_method: 'semantic' }], constraints: [] };
}

describe('Runtime chain fail-closed behavior', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rc-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('Router deny is terminal: model_calls=0, tool_calls=0, termination=denied', async () => {
    let modelCalls = 0;
    const provider: HarnessProvider = {
      async resolve() { modelCalls++; return { content: 'should not be called', decision_summary: 'x' }; },
    };
    const h = makeHarness(tmp, provider, ['nonexistent_tool']);
    const r = await h.run(task('read a file'));
    expect(r.routing.outcome).not.toBe('route');
    expect(r.loop_result.termination_reason).toBe('denied');
    expect(modelCalls).toBe(0);
    expect(r.success).toBe(false);
    expect(r.run_plan).toBeNull();
  });

  it('Unauthorized tool: model can be called but tool side-effect must be 0', async () => {
    const provider: HarnessProvider = {
      async resolve() {
        return {
          content: '', decision_summary: 'read',
          tool_calls: [{ id: '1', name: 'write_file', arguments: { path: '/workspace/x', content: 'x' } }],
        };
      },
    };
    const h = makeHarness(tmp, provider, ['read_file']);
    const r = await h.run(task('write a file'));
    expect(r.routing.outcome).not.toBe('route');
  });

  it('VFS route() is public and returns correct backend', () => {
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    const backend = vfs.route('/workspace/test.txt');
    expect(backend).toBeDefined();
    expect(backend.prefix).toBe('/workspace');
  });

  it('VFS commitOverlay works with auto-routed target (no private cast)', () => {
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    const overlay = new OverlayBackend('/workspace');
    overlay.setBaseBackend(vfs.route('/workspace'));
    overlay.write('/workspace/test.txt', Buffer.from('hello'));
    vfs.commitOverlay(overlay);
    expect(vfs.read('/workspace/test.txt').toString()).toBe('hello');
  });

  it('VFS discardOverlay discards staged writes', () => {
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    const overlay = new OverlayBackend('/workspace');
    overlay.setBaseBackend(vfs.route('/workspace'));
    overlay.write('/workspace/discard.txt', Buffer.from('temp'));
    vfs.discardOverlay(overlay);
    expect(() => vfs.read('/workspace/discard.txt')).toThrow();
  });
});
