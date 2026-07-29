import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDefaultExecutionContext } from '../../harness.js';
import { createTestSecurityDeps, createScriptedGateway, createTestVerificationEngine } from '../helpers/test-security.js';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { Harness } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../skills/skill-registry.js';

import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';

import { PolicyEngine, type Policy } from '../../security/policy-engine.js';

import type { SandboxProfile } from '../../sandbox/process-sandbox.js';

import type { ToolSpec } from '../../contracts/index.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

import { CodingWorkspaceController } from '../../ui/ah_ui_coding_001.js';


function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}

describe('AH-UI-CODING-001 coding workspace (via Harness)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'uic-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('runFix delegates to Harness', async () => {
    writeFileSync(join(tmp, 'f.ts'), 'BUG');
    const tr = new ToolRegistry();
    ['read_file', 'write_file', 'edit_file', 'execute_command'].forEach(n => tr.register(toolSpec(n)));
    const sr = new SkillRegistry(); sr.loadBaseSkills();
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp));
    const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'workspace', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
    const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
    const gw = createScriptedGateway([
      { content: '', tool_calls: [{ id: 'read', name: 'read_file', arguments: { path: '/workspace/f.ts' } }] },
      { content: '', tool_calls: [{ id: 'edit', name: 'edit_file', arguments: { path: '/workspace/f.ts', find: 'BUG', replace: 'FIXED' } }] },
      { content: '', tool_calls: [{ id: 'test', name: 'execute_command', arguments: { argv: ['/bin/echo', 'ok'], cwd: '/workspace' } }] },
      { content: 'ready for independent verification' },
    ]);
    const h = new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, security: createTestSecurityDeps(pe, () => new Date().toISOString()), verification: createTestVerificationEngine(), executionContext: createDefaultExecutionContext('test-run') });
    const c = new CodingWorkspaceController(h);
    const r = await c.runFix({ repo_path: '/workspace', bug_file: '/workspace/f.ts', test_command: ['/bin/echo', 'ok'] });
    expect(r.state).toBe('success');
  });
});
