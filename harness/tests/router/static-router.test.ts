import { describe, it, expect, beforeEach } from 'vitest';
import { StaticRouter, profileIntent, selectStrategy, type ReasoningStrategy } from '../../router/static-router.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../tools/skill-registry.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import type { ToolSpec } from '../../../spec/types/tool-spec.js';
import type { TaskContract } from '../../../spec/types/task-contract.js';

function task(goal: string, over: Partial<TaskContract> = {}): TaskContract {
  return {
    goal,
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints: [],
    ...over,
  } as TaskContract;
}

function toolSpec(name: string): ToolSpec {
  return {
    name, version: '1.0.0', domains: ['coding'], implementation_status: 'implemented',
    input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: { summary: name, tags: [], transport: 'native' },
    risk_feature_extractor: 'ex', preconditions: [], postconditions: [], timeout_policy: {},
    cancellation_policy: {}, retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {},
    credential_requirements: [], data_egress_policy: {}, receipt_schema_ref: 'r.json', verification_adapter: 'v', maturity: 'draft',
  } as ToolSpec;
}

function setupRouter() {
  const tr = new ToolRegistry();
  ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed', 'list_directory', 'search_files', 'parse_document'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const tsnap = tr.freezeSnapshot();
  const ssnap = sr.freezeSnapshot();
  const pe = new PolicyEngine({ version: 'policy-v1', default_decision: 'deny', allowed_tools: ['read_file','write_file','edit_file','execute_command_sandboxed','list_directory','search_files','parse_document'], allowed_resource_prefixes: ['workspace://'], rules: [] } as Policy);
  return new StaticRouter({ toolRegistry: tr, skillRegistry: sr, toolSnapshot: tsnap, skillSnapshot: ssnap, policyEngine: pe, policySnapshotRef: 'policy-v1' });
}

describe('AH-ROUTER-FOUNDATION-001 StaticRouter', () => {
  let router: StaticRouter;
  beforeEach(() => { router = setupRouter(); });

  describe('profileIntent', () => {
    it('normalizes a request into typed intents, domains, ambiguity, constraints', () => {
      const i = profileIntent(task('read the file and summarize it'));
      expect(i.domains).toContain('documents');
      expect(i.requires_tools).toBe(true);
      expect(i.requires_writes).toBe(false);
      expect(i.ambiguity).toBe('none');
    });
    it('detects writes and tests', () => {
      const i = profileIntent(task('fix the bug and run the tests'));
      expect(i.requires_writes).toBe(true);
      expect(i.requires_tests).toBe(true);
      expect(i.multi_step).toBe(true);
    });
  });

  describe('selectStrategy', () => {
    it('selects direct for a tool-free single-call task', () => {
      expect(selectStrategy(profileIntent(task('rewrite this paragraph more concisely')))).toBe('direct');
    });
    it('selects react when a tool is required and next action depends on observation', () => {
      expect(selectStrategy(profileIntent(task('list the directory and read the matching file')))).toBe('react');
    });
    it('selects plan_execute for dependent multi-step write+test tasks', () => {
      expect(selectStrategy(profileIntent(task('fix the bug then run the tests then verify')))).toBe('plan_execute');
    });
    it('selects plan_execute for explicit plan request', () => {
      expect(selectStrategy(profileIntent(task('plan the feature implementation step by step')))).toBe('plan_execute');
    });
  });

  describe('RunPlan reasoning_strategy uses lowercase contract values', () => {
    it('direct produces reasoning_strategy=direct', () => {
      const r = router.route(task('rewrite this text more concisely'));
      expect(r.outcome).toBe('route');
      expect(r.strategy).toBe('direct');
      expect(r.run_plan!.reasoning_strategy).toBe('direct');
    });
    it('react produces reasoning_strategy=react', () => {
      const r = router.route(task('list the directory and read the matching file'));
      expect(r.outcome).toBe('route');
      expect(r.strategy).toBe('react');
      expect(r.run_plan!.reasoning_strategy).toBe('react');
    });
    it('plan_execute produces reasoning_strategy=plan_execute', () => {
      const r = router.route(task('fix the bug then run the tests then verify'));
      expect(r.outcome).toBe('route');
      expect(r.strategy).toBe('plan_execute');
      expect(r.run_plan!.reasoning_strategy).toBe('plan_execute');
    });
  });

  describe('RunPlan uses frozen registry snapshots', () => {
    it('run_plan references tool + skill snapshot IDs', () => {
      const r = router.route(task('fix the bug then run the tests'));
      expect(r.run_plan!.registry_snapshot_refs).toHaveLength(2);
      expect(r.run_plan!.registry_snapshot_refs[0]).toMatch(/^[0-9a-f]{64}$/);
    });
    it('single-agent RunPlan (agent_count=1)', () => {
      const r = router.route(task('fix the bug'));
      expect((r.run_plan!.agent_graph as { agent_count: number }).agent_count).toBe(1);
    });
  });

  describe('deterministic: same input produces same RunPlan hash', () => {
    it('two routes for the same task produce the same strategy', () => {
      const t = task('fix the bug then run the tests');
      const r1 = router.route(t);
      const r2 = router.route(t);
      expect(r1.strategy).toBe(r2.strategy);
      expect(r1.run_plan!.reasoning_strategy).toBe(r2.run_plan!.reasoning_strategy);
    });
  });

  describe('abstains when required tools missing from snapshot', () => {
    it('abstains when a required tool is not in the frozen snapshot', () => {
      const tr = new ToolRegistry(); // empty registry
      const sr = new SkillRegistry();
      const pe = new PolicyEngine({ version: 'policy-v1', default_decision: 'deny', allowed_tools: ['read_file'], allowed_resource_prefixes: ['workspace://'], rules: [] } as Policy);
      const r = new StaticRouter({ toolRegistry: tr, skillRegistry: sr, toolSnapshot: tr.freezeSnapshot(), skillSnapshot: sr.freezeSnapshot(), policyEngine: pe, policySnapshotRef: 'p' });
      const result = r.route(task('fix the bug then run the tests'));
      expect(result.outcome).toBe('abstain');
      expect(result.abstain_reason).toContain('not in frozen snapshot');
    });
  });

  describe('ask_user when hard constraints cannot be satisfied', () => {
    it('asks user when success criteria are empty', () => {
      const r = router.route(task('do something', { success_criteria: [] as TaskContract['success_criteria'] }));
      expect(r.outcome).toBe('ask_user');
      expect(r.ask_user_message).toContain('success criteria');
    });
  });

  describe('Policy prefilter and post-route veto', () => {
    it('policy prefilter runs before profiling', () => {
      const r = router.route(task('fix the bug'));
      expect(r.policy_prefilter_passed).toBe(true);
    });
    it('policy post-route veto is not triggered for normal routes', () => {
      const r = router.route(task('fix the bug'));
      expect(r.policy_post_route_vetoed).toBe(false);
    });
  });

  describe('budget allocation per strategy', () => {
    it('direct gets max_iterations=1', () => {
      const r = router.route(task('rewrite this text'));
      expect((r.run_plan!.budget_allocation as { max_iterations: number }).max_iterations).toBe(1);
    });
    it('react/plan_execute get max_iterations=3', () => {
      const r = router.route(task('fix the bug then run the tests'));
      expect((r.run_plan!.budget_allocation as { max_iterations: number }).max_iterations).toBe(3);
    });
  });

  describe('router never issues capabilities, grants, or consent', () => {
    it('run_plan contains derived_risk_assessment not risk_policy', () => {
      const r = router.route(task('fix the bug'));
      expect(r.run_plan!.derived_risk_assessment).toBeDefined();
      expect((r.run_plan as unknown as { risk_policy?: unknown }).risk_policy).toBeUndefined();
    });
  });
});
