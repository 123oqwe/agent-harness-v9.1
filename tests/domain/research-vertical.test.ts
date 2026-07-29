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

import { runResearchVertical } from '../../domains/research/ah_research_vertical_001.js';


function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}
function makeHarness(tmp: string): Harness {
  const tr = new ToolRegistry(); ['read_file', 'search_files', 'parse_document'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'search_files', 'parse_document'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'read', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const gw = createScriptedGateway([
    { content: '', tool_calls: [{ id: 'read', name: 'read_file', arguments: { path: '/workspace/a.txt' } }] },
    { content: 'Research report citing only the observed source' },
  ]);
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, security: _sec, verification: createTestVerificationEngine(), executionContext: createDefaultExecutionContext('test-run', _sec.clock) });
}

describe('AH-RESEARCH-VERTICAL-001 research vertical (thin adapter)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'res-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });
  it('delegates to Harness for research report', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'The sky is blue');
    const h = makeHarness(tmp);
    const r = await runResearchVertical(h, { sources: ['/workspace/a.txt'], query: 'sky' });
    expect(r.evidence).toHaveLength(1);
    expect(r.citations).toEqual(['/workspace/a.txt']);
    expect(r.evidence[0]!.excerpt).toContain('sky');
  });
});
