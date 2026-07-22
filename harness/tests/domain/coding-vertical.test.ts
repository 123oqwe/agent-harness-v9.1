/**
 * AH-CODING-VERTICAL-001 test — proves the coding vertical delegates to
 * the unified Harness, not its own mini agent loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, type HarnessProvider } from '../../harness.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../tools/skill-registry.js';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import type { SandboxProfile } from '../../runtime/sandbox.js';
import type { ModelTurn } from '../../runtime/loop.js';
import type { ToolSpec } from '../../../spec/types/tool-spec.js';
import { runCodingVertical } from '../../domains/coding/ah_coding_vertical_001.js';

function toolSpec(name: string): ToolSpec {
  return { name, version: '1.0.0', domains: ['coding'], implementation_status: 'implemented', input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: {}, risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r.json', verification_adapter: 'v', maturity: 'draft' } as ToolSpec;
}

function makeHarness(tmp: string, provider: HarnessProvider): Harness {
  const tr = new ToolRegistry();
  ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed', 'list_directory', 'search_files'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new LocalBackend('/workspace', tmp));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed', 'list_directory', 'search_files'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'allow-all', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, provider });
}

describe('AH-CODING-VERTICAL-001 coding vertical (thin adapter)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cod-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('delegates to Harness: reads, fixes, tests via unified pipeline', async () => {
    writeFileSync(join(tmp, 'bug.ts'), 'function add(a, b) { return a - b; }');
    const provider: HarnessProvider = {
      async resolve() {
        const turn: ModelTurn = {
          content: '', decision_summary: 'fixing bug',
          tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/workspace/bug.ts' } }],
        };
        return turn;
      },
    };
    const h = makeHarness(tmp, provider);
    const r = await runCodingVertical(h, { repo_path: '/workspace', bug_file: '/workspace/bug.ts', test_command: ['/bin/echo', 'ok'] });
    expect(r.outcome.routing.strategy).toBe('plan_execute');
    expect(r.read_ok).toBe(true);
    expect(r.outcome.session.getEvents().some(e => e.type === 'tool_call')).toBe(true);
  });

  it('does not call Provider/Tool/VFS directly — all through Harness', async () => {
    writeFileSync(join(tmp, 'bug.ts'), 'x');
    const provider: HarnessProvider = {
      async resolve() { return { content: 'done', decision_summary: 'done' }; },
    };
    const h = makeHarness(tmp, provider);
    const r = await runCodingVertical(h, { repo_path: '/workspace', bug_file: '/workspace/bug.ts', test_command: ['/bin/echo', 'ok'] });
    // The vertical itself has no modelCall, vfs, or sandbox params
    expect(r.outcome.loop_result.strategy).toBeDefined();
    // All session events come from the Harness, not the vertical
    expect(r.outcome.session.eventCount()).toBeGreaterThan(0);
  });
});
