import { describe, it, expect } from 'vitest';
import { routeDag, PIPELINE_STAGE_NAMES } from '../../router/pipeline.js';
import { profileIntent } from '../../router/static-router.js';
import type { Policy } from '../../security/policy-engine.js';
import { setupDeps, DEFAULT_IDENTITY, task, PHASE1_TOOLS } from './pipeline-setup.js';

describe('AH-ROUTER-DAG-001 policy enters first and stays immutable', () => {
  it('freezes the Policy snapshot as the very first stage, before profiling', async () => {
    const order: string[] = [];
    const deps = setupDeps();
    await routeDag(task('rewrite this text'), DEFAULT_IDENTITY, deps, {
      observer: { onStageComplete: (stage) => order.push(stage) },
      taskProfiler: (t) => {
        // At Profiler time only Identity/Policy may have completed.
        expect(order).toEqual(['Identity/Policy']);
        return profileIntent(t);
      },
    });
    expect(order).toEqual(PIPELINE_STAGE_NAMES);
  });

  it('a write under a read_only ceiling aborts before a RunPlan is shaped', async () => {
    const deps = setupDeps();
    const r = await routeDag(
      task('write notes.txt', { constraints: [{ type: 'risk_ceiling', value: 'read_only' }] }),
      DEFAULT_IDENTITY,
      deps,
    );
    expect(r.outcome).toBe('abstain');
    expect(r.run_plan).toBeUndefined();
    expect(r.stages_executed).toEqual(PIPELINE_STAGE_NAMES.slice(0, 4));
  });

  it('a tool outside the frozen Policy is a prefilter veto even though the tool exists', async () => {
    const narrow: Policy = {
      version: 'policy-v1',
      default_decision: 'deny',
      allowed_tools: PHASE1_TOOLS.filter((name) => name !== 'write_file'),
      allowed_resource_prefixes: ['workspace://'],
      rules: [],
    };
    const deps = setupDeps({ policy: narrow });
    const r = await routeDag(task('write notes.txt'), DEFAULT_IDENTITY, deps);
    expect(r.outcome).toBe('abstain');
    expect(r.policy_prefilter_passed).toBe(false);
    expect(r.policy_post_route_vetoed).toBe(false);
    expect(r.abstain_reason).toContain('write_file');
  });

  it('a default_deny Policy still routes read-only tasks without consent', async () => {
    const denyByDefault: Policy = {
      version: 'policy-v1',
      default_decision: 'deny',
      allowed_tools: PHASE1_TOOLS,
      allowed_resource_prefixes: ['workspace://'],
      rules: [],
    };
    const deps = setupDeps({ policy: denyByDefault });
    const r = await routeDag(task('read the file and summarize it'), DEFAULT_IDENTITY, deps);
    expect(r.outcome).toBe('route');
    expect(r.run_plan!.required_consent).toEqual({ required: false });
    expect(r.run_plan!.derived_risk_assessment).toEqual({ risk_tier: 1, egress: 'none' });
  });
});
