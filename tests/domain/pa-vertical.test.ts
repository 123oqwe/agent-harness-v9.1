import { describe, it, expect } from 'vitest';
import { createDefaultExecutionContext } from '../../harness.js';
import { createTestSecurityDeps, createScriptedGateway } from '../helpers/test-security.js';

import { Harness } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../tools/skill-registry.js';

import { VirtualFilesystem, StoreBackend } from '../../vfs/virtual-filesystem.js';

import { PolicyEngine, type Policy } from '../../security/policy-engine.js';

import type { SandboxProfile } from '../../runtime/sandbox.js';

import type { ToolSpec } from '../../contracts/index.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

import { runPAVertical } from '../../personal_assistant/ah_pa_vertical_001.js';


function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}
function makeHarness(): Harness {
  const tr = new ToolRegistry(); ['read_file', 'search_files'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new StoreBackend('/workspace'));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'search_files'], allowed_resource_prefixes: ['/workspace'], rules: [] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: '/tmp', allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const gw = createScriptedGateway([{ content: 'Daily plan: T1, T3, T2, T5, T4' }]);
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, security: _sec, executionContext: createDefaultExecutionContext('test-run', _sec.clock) });
}

describe('AH-PA-VERTICAL-001 personal assistant vertical (thin adapter)', () => {
  it('delegates to Harness, no external actions proven by session audit', async () => {
    const h = makeHarness();
    const r = await runPAVertical(h, { tasks: [{ id: 'T1', title: 'meeting', priority: 'high', duration_min: 30 }], available_minutes: 60 });
    expect(r.no_external_actions).toBe(true);
    expect(r.outcome.session.eventCount()).toBeGreaterThan(0);
  });
});
