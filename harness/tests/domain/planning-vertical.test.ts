import { describe, it, expect } from 'vitest';
import { Harness, type HarnessProvider } from '../../harness.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../tools/skill-registry.js';
import { VirtualFilesystem, StoreBackend } from '../../vfs/virtual-filesystem.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import type { SandboxProfile } from '../../runtime/sandbox.js';
import type { ToolSpec } from '../../../spec/types/tool-spec.js';
import { runPlanningVertical } from '../../planning/ah_planning_vertical_001.js';

function toolSpec(name: string): ToolSpec {
  return { name, version: '1.0.0', domains: ['planning'], implementation_status: 'implemented', input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: {}, risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r.json', verification_adapter: 'v', maturity: 'draft' } as ToolSpec;
}
function makeHarness(): Harness {
  const tr = new ToolRegistry(); ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed', 'search_files'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new StoreBackend('/workspace'));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed', 'search_files'], allowed_resource_prefixes: ['/workspace'], rules: [] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: '/tmp', allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const provider: HarnessProvider = { async resolve() { return { content: 'Plan: build, test, deploy', decision_summary: 'I created the plan' }; } };
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, provider });
}

describe('AH-PLANNING-VERTICAL-001 planning vertical (thin adapter)', () => {
  it('delegates to Harness for planning', async () => {
    const h = makeHarness();
    const r = await runPlanningVertical(h, { goal: 'deploy app', tasks: [{ id: 'build', depends_on: [] }, { id: 'test', depends_on: ['build'] }] });
    expect(r.outcome.routing.outcome).toBe('route');
  });
  it('plan_execute strategy for multi-step', async () => {
    const h = makeHarness();
    const r = await runPlanningVertical(h, { goal: 'plan step by step', tasks: [{ id: 'a', depends_on: [] }, { id: 'b', depends_on: ['a'] }] });
    expect(r.outcome.routing.strategy).toBe('plan_execute');
  });
});
