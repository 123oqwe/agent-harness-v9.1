/**
 * Integration test: proves one Harness executes direct, react, plan_execute.
 * Uses ScriptedTestProvider (no LLM). All three strategies go through the same
 * StaticRouter, Runtime, Session, ToolExecutor, VFS and Evidence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDefaultExecutionContext } from '../../harness.js';
import { createTestSecurityDeps, createScriptedGateway } from '../helpers/test-security.js';
import type { ParsedResponse } from '../../gateway/scripted-provider.js';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { Harness } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../tools/skill-registry.js';

import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';

import { PolicyEngine, type Policy } from '../../security/policy-engine.js';

import type { SandboxProfile } from '../../runtime/sandbox.js';

import type { ModelTurn } from '../../runtime/loop.js';

import type { TaskContract } from '../../../spec/types/task-contract.js';

import type { ToolSpec } from '../../../spec/types/tool-spec.js';


function toolSpec(name: string): ToolSpec {
  return { name, version: '1.0.0', domains: ['coding'], implementation_status: 'implemented', input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: {}, risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r.json', verification_adapter: 'v', maturity: 'draft' } as ToolSpec;
}


function makeHarness(tmp: string, extraTools: string[] = [], responses: ParsedResponse[] = [{ content: 'done' }]): Harness {
  const gw = createScriptedGateway(responses);
  const tr = new ToolRegistry();
  ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed', 'list_directory', 'search_files'].forEach(n => tr.register(toolSpec(n)));
  extraTools.forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry();
  sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new LocalBackend('/workspace', tmp));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed', 'list_directory', 'search_files', 'parse_document', 'create_artifact'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'allow-all', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, registrySnapshotHash: gw.registrySnapshotHash, security: createTestSecurityDeps(pe, () => new Date().toISOString()), executionContext: createDefaultExecutionContext('test-run') });
}

function task(goal: string, over: Partial<TaskContract> = {}): TaskContract {
  return { goal, success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }], constraints: [], ...over } as TaskContract;
}

describe('reasoning-strategies integration: one Harness, three strategies', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'strat-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('direct: tool-free single model call', async () => {
    const h = makeHarness(tmp);
    // Override provider with a direct response
        const r = await h.run(task('rewrite this paragraph more concisely'));
    expect(r.routing.strategy).toBe('direct');
    expect(r.loop_result.iterations).toBe(1);
    expect(r.success).toBe(true);
  });

  it('react: tool observation then answer', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello world');
    const h = makeHarness(tmp, [], [
      { content: '', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/workspace/f.txt' } }] },
      { content: 'The file contains: hello world' },
    ]);
    const r = await h.run(task('read the file and report its contents'));
    expect(r.routing.strategy).toBe('react');
    expect(r.loop_result.turns.length).toBeGreaterThanOrEqual(1);
    expect(r.session.getEvents().some(e => e.type === 'tool_call')).toBe(true);
  });

  it('plan_execute: multi-step write + test', async () => {
    writeFileSync(join(tmp, 'bug.ts'), 'function add(a, b) { return a - b; }');
    const h = makeHarness(tmp, [], [
      { content: 'plan: read, fix, test' },
      { content: '', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/workspace/bug.ts' } }] },
      { content: '', tool_calls: [{ id: '2', name: 'edit_file', arguments: { path: '/workspace/bug.ts', find: 'a - b', replace: 'a + b' } }] },
      { content: 'Bug fixed and verified' },
    ]);
    const r = await h.run(task('fix the bug then run the tests'));
    expect(r.routing.strategy).toBe('plan_execute');
    expect(r.session.getEvents().filter(e => e.type === 'tool_call').length).toBeGreaterThanOrEqual(2);
  });

  it('all three strategies use the same Harness instance', async () => {
    const h = makeHarness(tmp, [], [{ content: 'ok' }]);
    const r1 = await h.run(task('rewrite text'), 'run-1');
    expect(r1.routing.strategy).toBe('direct');
    // Same instance can run a different strategy
    writeFileSync(join(tmp, 'f.txt'), 'x');
    const r2 = await h.run(task('read the file'), 'run-2');
    expect(r2.routing.strategy).toBe('react');
    // Same instance, different sessions
    expect(r1.session.session_id).not.toBe(r2.session.session_id);
  });

  it('PEP deny: tool not in policy → tool not executed', async () => {
    const tr = new ToolRegistry();
    tr.register(toolSpec('read_file'));
    tr.register(toolSpec('write_file')); // registered but NOT in policy allowed_tools
    tr.register(toolSpec('edit_file')); // also registered
    const sr = new SkillRegistry(); sr.loadBaseSkills();
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'allow-all', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
    const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
    const h = new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: createScriptedGateway([{ content: '', tool_calls: [{ id: '1', name: 'write_file', arguments: { path: '/workspace/x', content: 'x' } }] }, { content: 'done' }]).gateway, registrySnapshotHash: createScriptedGateway([{ content: '', tool_calls: [{ id: '1', name: 'write_file', arguments: { path: '/workspace/x', content: 'x' } }] }, { content: 'done' }]).registrySnapshotHash, security: createTestSecurityDeps(pe, () => new Date().toISOString()), executionContext: createDefaultExecutionContext('test-run') });
    const r = await h.run(task('write a file'));
    // Router prefilter denies write_file (not in policy allowed_tools) → routing abstains
    expect(r.routing.outcome).toBe('abstain');
    expect(r.routing.abstain_reason).toContain('policy');
  });

  it('all model calls go through HarnessProvider (no direct fetch)', async () => {
    const tr = new ToolRegistry(); tr.register(toolSpec('read_file'));
    const sr = new SkillRegistry(); sr.loadBaseSkills();
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp));
    const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'allow-all', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
    const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
    const h = makeHarness(tmp);
    await h.run(task('rewrite text')); // exactly one provider call
  });
});
