import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultExecutionContext } from '../../harness.js';
import { createTestSecurityDeps, createScriptedGateway } from '../helpers/test-security.js';

import { Harness } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../tools/skill-registry.js';

import { LocalBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';

import { PolicyEngine, type Policy } from '../../security/policy-engine.js';

import type { SandboxProfile } from '../../runtime/sandbox.js';

import type { ToolSpec } from '../../contracts/index.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

import { runWritingVertical } from '../../writing/ah_writing_vertical_001.js';


function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}
function makeHarness(workspaceRoot: string): Harness {
  const tr = new ToolRegistry(); ['read_file', 'write_file'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', workspaceRoot));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file'], allowed_resource_prefixes: ['/workspace'], rules: [] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const gw = createScriptedGateway([{ content: 'Draft about Agent Harness with 14 modules' }]);
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, security: _sec, executionContext: createDefaultExecutionContext('test-run', _sec.clock) });
}

describe('AH-WRITING-VERTICAL-001 writing vertical (thin adapter)', () => {
  let workspaceRoot: string;
  beforeEach(() => { workspaceRoot = mkdtempSync(join(tmpdir(), 'ah-writing-')); });
  afterEach(() => { rmSync(workspaceRoot, { recursive: true, force: true }); });

  it('delegates to Harness for writing draft', async () => {
    const h = makeHarness(workspaceRoot);
    const r = await runWritingVertical(h, { brief: 'Explain Agent Harness architecture', requirements: ['title', '14 modules'] });
    expect(['direct','react','plan_execute']).toContain(r.outcome.routing.strategy);
    expect(r.draft.length).toBeGreaterThan(0);
  });
});
