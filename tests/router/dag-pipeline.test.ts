import { describe, it, expect } from 'vitest';
import { routeDag, PIPELINE_STAGE_NAMES } from '../../router/pipeline.js';
import { ProviderResolutionError, type ModelGateway } from '../../gateway/model-gateway.js';
import { validateFixture } from '../helpers/schema-validator.js';
import { setupDeps, DEFAULT_IDENTITY, task, gatewayProxy } from './pipeline-setup.js';

describe('AH-ROUTER-DAG-001 Router DAG pipeline', () => {
  it('routes a simple task to a static_dag RunPlan through all 14 stages', async () => {
    const deps = setupDeps();
    const r = await routeDag(task('rewrite this text more concisely'), DEFAULT_IDENTITY, deps);
    expect(r.outcome).toBe('route');
    expect(r.strategy).toBe('direct');
    expect(r.stages_executed).toEqual(PIPELINE_STAGE_NAMES);
    expect(r.run_plan!.agent_graph.execution_mode).toBe('static_dag');
    expect(r.run_plan!.agent_graph.routing_slip).toBeUndefined();
  });

  it('emits derived_risk_assessment (not risk_policy) and required_consent (not consent_policy)', async () => {
    const deps = setupDeps();
    const r = await routeDag(task('rewrite this text'), DEFAULT_IDENTITY, deps);
    expect(r.run_plan!.derived_risk_assessment).toEqual({ risk_tier: 1, egress: 'none' });
    expect(r.run_plan!.required_consent).toEqual({ required: false });
    expect((r.run_plan as unknown as { risk_policy?: unknown }).risk_policy).toBeUndefined();
    expect((r.run_plan as unknown as { consent_policy?: unknown }).consent_policy).toBeUndefined();
  });

  it('write tasks require consent and raise the derived risk tier', async () => {
    const deps = setupDeps();
    const r = await routeDag(task('write report.md with a summary of the market'), DEFAULT_IDENTITY, deps);
    expect(r.outcome).toBe('route');
    expect(r.run_plan!.required_consent).toEqual({ required: true });
    expect(r.run_plan!.derived_risk_assessment).toEqual({ risk_tier: 2, egress: 'none' });
  });

  it('open-ended missions route as routing_slip with an itinerary', async () => {
    const deps = setupDeps();
    const r = await routeDag(
      task('research the zero-person company space and explore market opportunities'),
      DEFAULT_IDENTITY,
      deps,
    );
    expect(r.outcome).toBe('route');
    expect(r.run_plan!.agent_graph.execution_mode).toBe('routing_slip');
    expect(r.run_plan!.agent_graph.routing_slip).toBeDefined();
    expect(r.run_plan!.agent_graph.routing_slip!.itinerary).toEqual([]);
    expect(r.run_plan!.agent_graph.nodes).toHaveLength(1);
  });

  it('dozens+ fan-out routes as workflow_script with a parallel fork/join script', async () => {
    const criteria = Array.from({ length: 12 }, (_, i) => ({
      criterion: `criterion ${i}`,
      verification_method: 'deterministic' as const,
    }));
    const deps = setupDeps();
    const r = await routeDag(
      task('run a fan-out across all 12 regions in parallel and aggregate the results', { success_criteria: criteria }),
      DEFAULT_IDENTITY,
      deps,
    );
    expect(r.outcome).toBe('route');
    expect(r.run_plan!.agent_graph.execution_mode).toBe('workflow_script');
    const stepIds = r.run_plan!.workflow_graph.nodes.map((n) => n.step_id);
    expect(stepIds).toContain('step-fork');
    expect(stepIds).toContain('step-join');
    expect(r.run_plan!.workflow_graph.nodes.some((n) => n.step_type === 'parallel_join')).toBe(true);
    expect(r.run_plan!.agent_graph.nodes.length).toBeGreaterThanOrEqual(12);
    // every agent step references an existing agent in the graph
    const agentIds = new Set(r.run_plan!.agent_graph.nodes.map((a) => a.agent_id));
    for (const n of r.run_plan!.workflow_graph.nodes) {
      if (n.agent_id_ref) expect(agentIds.has(n.agent_id_ref)).toBe(true);
    }
  });

  it('emits schedule_binding only when the task carries scheduling intent', async () => {
    const deps = setupDeps();
    const plain = await routeDag(task('rewrite this text'), DEFAULT_IDENTITY, deps);
    expect(plain.run_plan!.schedule_binding).toBeUndefined();

    const scheduled = await routeDag(
      task('rewrite this text', { priority: 'high', deadline: '2026-08-30' }),
      DEFAULT_IDENTITY,
      deps,
    );
    expect(scheduled.run_plan!.schedule_binding).toEqual({ deadline: '2026-08-30', priority: 'high' });
  });

  it('asks the user when success criteria are empty, after exactly 2 stages', async () => {
    const deps = setupDeps();
    const r = await routeDag(task('figure something out', { success_criteria: [] }), DEFAULT_IDENTITY, deps);
    expect(r.outcome).toBe('ask_user');
    expect(r.stages_executed).toEqual(['Identity/Policy', 'Profiler']);
  });

  it('prefilter veto: a write under a read_only ceiling aborts with no run_plan', async () => {
    const deps = setupDeps();
    const r = await routeDag(
      task('write notes.txt then clean up', { constraints: [{ type: 'risk_ceiling', value: 'read_only' }] }),
      DEFAULT_IDENTITY,
      deps,
    );
    expect(r.outcome).toBe('abstain');
    expect(r.policy_prefilter_passed).toBe(false);
    expect(r.policy_post_route_vetoed).toBe(false);
    expect(r.abstain_reason).toContain('read_only');
    expect(r.abstain_reason).toContain('Context/Capability');
    expect(r.run_plan).toBeUndefined();
  });

  it('post-route veto: a bound remote provider for a local_only task abstains', async () => {
    const base = setupDeps();
    const remote: ModelGateway = gatewayProxy(base.gateway, {
      describeResolved: () => ({
        provider_id: 'remote-provider',
        provider_type: 'deepseek',
        execution: 'remote',
        metadata_hash: 'x',
      }),
    });
    const deps = setupDeps({ gateway: remote });
    const r = await routeDag(
      task('list the directory', { constraints: [{ type: 'privacy', value: 'local_only' }] }),
      DEFAULT_IDENTITY,
      deps,
    );
    expect(r.outcome).toBe('abstain');
    expect(r.policy_prefilter_passed).toBe(true);
    expect(r.policy_post_route_vetoed).toBe(true);
    expect(r.abstain_reason).toContain('local_only');
  });

  it('converts a provider resolution failure into a post-route abstain', async () => {
    const base = setupDeps();
    const failing: ModelGateway = gatewayProxy(base.gateway, {
      resolve: () => {
        throw new ProviderResolutionError('no_compatible_provider', 'no provider is compatible');
      },
    });
    const deps = setupDeps({ gateway: failing });
    const r = await routeDag(task('fix the bug and run the tests'), DEFAULT_IDENTITY, deps);
    expect(r.outcome).toBe('abstain');
    expect(r.policy_prefilter_passed).toBe(true);
    expect(r.policy_post_route_vetoed).toBe(true);
    expect(r.abstain_reason).toContain('no_compatible_provider');
  });

  it('rejects a missing principal before any stage runs', async () => {
    const deps = setupDeps();
    const stages: string[] = [];
    await expect(
      routeDag(task('rewrite this text'), { principal: '', delegation_depth: 0, role: 'root', authorization_scope: 'test' }, deps, {
        observer: { onStageComplete: (stage) => stages.push(stage) },
      }),
    ).rejects.toThrow('principal');
    expect(stages).toEqual([]);
  });

  it('respects runIdOverride and stays deterministic', async () => {
    const deps = setupDeps();
    const r1 = await routeDag(task('rewrite this text'), DEFAULT_IDENTITY, deps, { runIdOverride: 'fixed-run-1' });
    const r2 = await routeDag(task('rewrite this text'), DEFAULT_IDENTITY, deps, { runIdOverride: 'fixed-run-1' });
    expect(r1.run_plan!.run_id).toBe('fixed-run-1');
    expect(r2.run_plan!.run_plan_hash).toBe(r1.run_plan!.run_plan_hash);
  });

  it('produced RunPlan passes the full run-plan schema', async () => {
    const deps = setupDeps();
    const r = await routeDag(task('fix the bug then run the tests then verify'), DEFAULT_IDENTITY, deps);
    const result = validateFixture('run-plan.schema.json', r.run_plan);
    if (!result.valid) console.error('run-plan schema errors:', result.errors);
    expect(result.valid).toBe(true);
  });
});
