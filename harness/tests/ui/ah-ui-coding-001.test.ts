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

import { CodingWorkspaceController } from '../../ui/ah_ui_coding_001.js';


function toolSpec(name: string): ToolSpec {
  return { name, version: '1.0.0', domains: ['coding'], implementation_status: 'implemented', input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: {}, risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r.json', verification_adapter: 'v', maturity: 'draft' } as ToolSpec;
}

describe('AH-UI-CODING-001 coding workspace (via Harness)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'uic-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('runFix delegates to Harness', async () => {
    writeFileSync(join(tmp, 'f.ts'), 'BUG');
    const tr = new ToolRegistry();
    ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed'].forEach(n => tr.register(toolSpec(n)));
    const sr = new SkillRegistry(); sr.loadBaseSkills();
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp));
    const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed'], allowed_resource_prefixes: ['/workspace'], rules: [] } as Policy);
    const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
    const provider: HarnessProvider = { async resolve() { return { content: 'done', decision_summary: 'done' }; } };
    const h = new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, provider, security: createTestSecurityDeps(pe, () => new Date().toISOString()), executionContext: createDefaultExecutionContext('test-run') });
    const c = new CodingWorkspaceController(h);
    const r = await c.runFix({ repo_path: '/workspace', bug_file: '/workspace/f.ts', test_command: ['/bin/echo', 'ok'] });
    expect(r.state).toBe('success');
  });
});
