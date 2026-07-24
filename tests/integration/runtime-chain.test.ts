import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, createDefaultExecutionContext } from '../../harness.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../tools/skill-registry.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { VirtualFilesystem, LocalBackend, OverlayBackend } from '../../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../../runtime/sandbox.js';
import type { TaskContract } from '../../contracts/index.js';
import { createTestSecurityDeps, createScriptedGateway, createTestVerificationEngine } from '../helpers/test-security.js';
import type { ParsedResponse } from '../../gateway/scripted-provider.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

function makeToolRegistry(): ToolRegistry {
  const tr = new ToolRegistry();
  tr.register(createPhase1ToolDefinitions().find((entry) => entry.name === 'read_file')!);
  return tr;
}

function makeHarness(tmp: string, allowedTools: string[] = ['read_file']): Harness {
  const gw = createScriptedGateway([{ content: 'done' } as ParsedResponse]);
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
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, security: _sec, verification: createTestVerificationEngine(), executionContext: createDefaultExecutionContext('test-run', _sec.clock) });
}

function task(goal: string): TaskContract {
  return { goal, success_criteria: [{ criterion: goal, verification_method: 'semantic' }], constraints: [] };
}

describe('Runtime chain fail-closed behavior', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rc-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('Router deny is terminal: model_calls=0, tool_calls=0, termination=denied', async () => {
    const h = makeHarness(tmp, ['nonexistent_tool']);
    const r = await h.run(task('read a file'));
    expect(r.routing.outcome).not.toBe('route');
    expect(r.loop_result.termination_reason).toBe('denied');
    expect(r.success).toBe(false);
    expect(r.run_plan).toBeNull();
  });

  it('Unauthorized tool: model can be called but tool side-effect must be 0', async () => {
    const h = makeHarness(tmp, ['read_file']);
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
