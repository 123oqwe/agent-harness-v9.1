import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDefaultExecutionContext } from '../../harness.js';
import { createTestSecurityDeps } from '../helpers/test-security.js';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { Harness, type HarnessProvider } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../tools/skill-registry.js';

import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';

import { PolicyEngine, type Policy } from '../../security/policy-engine.js';

import type { SandboxProfile } from '../../runtime/sandbox.js';

import type { ToolSpec } from '../../../spec/types/tool-spec.js';

import { runResearchVertical } from '../../research/ah_research_vertical_001.js';


function toolSpec(name: string): ToolSpec {
  return { name, version: '1.0.0', domains: ['research'], implementation_status: 'implemented', input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: {}, risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r.json', verification_adapter: 'v', maturity: 'draft' } as ToolSpec;
}
function makeHarness(tmp: string): Harness {
  const tr = new ToolRegistry(); ['read_file', 'search_files'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'search_files'], allowed_resource_prefixes: ['/workspace'], rules: [] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const provider: HarnessProvider = { async resolve() { return { content: 'Research report', decision_summary: 'I analyzed sources' }; } };
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, provider, security: createTestSecurityDeps(pe, () => new Date().toISOString()), executionContext: createDefaultExecutionContext('test-run') });
}

describe('AH-RESEARCH-VERTICAL-001 research vertical (thin adapter)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'res-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });
  it('delegates to Harness for research report', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'The sky is blue');
    const h = makeHarness(tmp);
    const r = await runResearchVertical(h, { sources: ['/workspace/a.txt'], query: 'sky' });
    expect(r.outcome.routing.strategy).toBeDefined();
    expect(r.outcome.routing.strategy).toBeDefined();
  });
});
