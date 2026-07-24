import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDefaultExecutionContext } from '../../harness.js';
import { createTestSecurityDeps, createScriptedGateway } from '../helpers/test-security.js';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { Harness } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../tools/skill-registry.js';

import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';

import { PolicyEngine, type Policy } from '../../security/policy-engine.js';

import type { SandboxProfile } from '../../runtime/sandbox.js';

import type { ToolSpec } from '../../../spec/types/tool-spec.js';

import { runDocVertical } from '../../ingestion/ah_doc_vertical_001.js';


function toolSpec(name: string): ToolSpec {
  return { name, version: '1.0.0', domains: ['documents'], implementation_status: 'implemented', input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: {}, risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r.json', verification_adapter: 'v', maturity: 'draft' } as ToolSpec;
}
function makeHarness(tmp: string): Harness {
  const tr = new ToolRegistry(); ['read_file', 'parse_document'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'parse_document'], allowed_resource_prefixes: ['/workspace'], rules: [] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const gw = createScriptedGateway([{ content: 'Summary of the document' }]);
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, registrySnapshotHash: gw.registrySnapshotHash, security: _sec, executionContext: createDefaultExecutionContext('test-run', _sec.clock) });
}

describe('AH-DOC-VERTICAL-001 documents vertical (thin adapter)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'doc-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });
  it('delegates to Harness for document summary', async () => {
    writeFileSync(join(tmp, 'doc.txt'), 'Page 1 content\fPage 2 content');
    const h = makeHarness(tmp);
    const r = await runDocVertical(h, { path: '/workspace/doc.txt' });
    expect(r.outcome.routing.strategy).toBeDefined();
    expect(r.outcome.session.eventCount()).toBeGreaterThan(0);
  });
});
