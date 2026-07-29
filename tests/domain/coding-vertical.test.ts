/**
 * AH-CODING-VERTICAL-001 test — proves the coding vertical delegates to
 * the unified Harness, not its own mini agent loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDefaultExecutionContext } from '../../harness.js';
import { createTestSecurityDeps, createScriptedGateway, createTestVerificationEngine } from '../helpers/test-security.js';
import type { ParsedResponse } from '../../gateway/scripted-provider.js';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { Harness } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../skills/skill-registry.js';

import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';

import { PolicyEngine, type Policy } from '../../security/policy-engine.js';

import type { SandboxProfile } from '../../sandbox/process-sandbox.js';

import type { ModelTurn } from '../../runtime/loop.js';

import type { ToolSpec } from '../../contracts/index.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

import { runCodingVertical } from '../../domains/coding/ah_coding_vertical_001.js';


function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}

function makeHarness(tmp: string, responses: ParsedResponse[]): Harness {
  const gw = createScriptedGateway(responses);
  const tr = new ToolRegistry();
  ['read_file', 'write_file', 'edit_file', 'execute_command', 'list_directory', 'search_files'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new LocalBackend('/workspace', tmp));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command', 'list_directory', 'search_files'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'allow-all', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, security: _sec, verification: createTestVerificationEngine(), executionContext: createDefaultExecutionContext('test-run', _sec.clock) });
}

describe('AH-CODING-VERTICAL-001 coding vertical (thin adapter)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cod-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('delegates to Harness: reads, fixes, tests via unified pipeline', async () => {
    writeFileSync(join(tmp, 'bug.ts'), 'function add(a, b) { return a - b; }');
    const h = makeHarness(tmp, [
      { content: '', tool_calls: [{ id: 'read', name: 'read_file', arguments: { path: '/workspace/bug.ts' } }] },
      { content: '', tool_calls: [{ id: 'edit', name: 'edit_file', arguments: { path: '/workspace/bug.ts', find: 'a - b', replace: 'a + b' } }] },
      { content: '', tool_calls: [{ id: 'test', name: 'execute_command', arguments: { argv: ['/usr/bin/true'], cwd: '/workspace' } }] },
      { content: 'ready for independent verification' },
    ]);
    const r = await runCodingVertical(h, { repo_path: '/workspace', bug_file: '/workspace/bug.ts', test_command: ['/usr/bin/true'] });
    expect(r.outcome.routing.strategy).toBe('plan_execute');
    expect(r.read_ok).toBe(true);
    expect(r.bug_located).toBe(true);
    expect(r.fix_applied).toBe(true);
    expect(r.test_exit_code).toBe(0);
    expect(r.diff_before).toMatch(/^[0-9a-f]{64}$/u);
    expect(r.diff_after).toMatch(/^[0-9a-f]{64}$/u);
    expect(r.diff_after).not.toBe(r.diff_before);
    expect(readFileSync(join(tmp, 'bug.ts'), 'utf8')).toContain('a + b');
  });

  it('does not call Provider/Tool/VFS directly — all through Harness', async () => {
    writeFileSync(join(tmp, 'bug.ts'), 'x');
    const h = makeHarness(tmp, [{ content: 'done' }]);
    const r = await runCodingVertical(h, { repo_path: '/workspace', bug_file: '/workspace/bug.ts', test_command: ['/bin/echo', 'ok'] });
    // The vertical itself has no modelCall, vfs, or sandbox params
    expect(r.outcome.loop_result.strategy).toBeDefined();
    // All session events come from the Harness, not the vertical
    expect(r.outcome.session.eventCount()).toBeGreaterThan(0);
    expect(r.fix_applied).toBe(false);
  });
});
