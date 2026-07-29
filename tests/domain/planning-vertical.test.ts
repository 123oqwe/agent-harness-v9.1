import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultExecutionContext } from '../../harness.js';
import { createTestSecurityDeps, createScriptedGateway, createTestVerificationEngine } from '../helpers/test-security.js';

import { Harness } from '../../harness.js';

import { ToolRegistry } from '../../tools/tool-registry.js';

import { SkillRegistry } from '../../skills/skill-registry.js';

import { LocalBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';

import { PolicyEngine, type Policy } from '../../security/policy-engine.js';

import type { SandboxProfile } from '../../sandbox/process-sandbox.js';

import type { ToolSpec } from '../../contracts/index.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

import {
  PlanningInputError,
  runPlanningVertical,
} from '../../domains/planning/ah_planning_vertical_001.js';


function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}
function makeHarness(workspaceRoot: string): Harness {
  const tr = new ToolRegistry(); ['read_file', 'write_file', 'edit_file', 'execute_command', 'search_files'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', workspaceRoot));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command', 'search_files'], allowed_resource_prefixes: ['/workspace'], rules: [] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const gw = createScriptedGateway([{ content: 'Plan: build, test, deploy' }]);
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, security: _sec, verification: createTestVerificationEngine(), executionContext: createDefaultExecutionContext('test-run', _sec.clock) });
}

describe('AH-PLANNING-VERTICAL-001 planning vertical (thin adapter)', () => {
  let workspaceRoot: string;
  beforeEach(() => { workspaceRoot = mkdtempSync(join(tmpdir(), 'ah-planning-')); });
  afterEach(() => { rmSync(workspaceRoot, { recursive: true, force: true }); });

  it('delegates to Harness for planning', async () => {
    const h = makeHarness(workspaceRoot);
    const r = await runPlanningVertical(h, { goal: 'deploy app', tasks: [{ id: 'build', depends_on: [] }, { id: 'test', depends_on: ['build'] }] });
    expect(r.outcome.routing.outcome).toBe('route');
  });
  it('plan_execute strategy for multi-step', async () => {
    const h = makeHarness(workspaceRoot);
    const r = await runPlanningVertical(h, { goal: 'plan step by step', tasks: [{ id: 'a', depends_on: [] }, { id: 'b', depends_on: ['a'] }] });
    expect(r.outcome.routing.strategy).toBe('plan_execute');
  });
  it('rejects unknown dependencies before dispatching Harness', async () => {
    const h = makeHarness(workspaceRoot);
    await expect(
      runPlanningVertical(h, {
        goal: 'plan',
        tasks: [{ id: 'a', depends_on: ['missing'] }],
      }),
    ).rejects.toThrow(PlanningInputError);
  });
  it('reports actual cycle members and never marks the plan feasible', async () => {
    const h = makeHarness(workspaceRoot);
    const result = await runPlanningVertical(h, {
      goal: 'plan dependency cycle',
      tasks: [
        { id: 'a', depends_on: ['b'] },
        { id: 'b', depends_on: ['a'] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.feasible).toBe(false);
    expect(result.cycles.flat()).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
