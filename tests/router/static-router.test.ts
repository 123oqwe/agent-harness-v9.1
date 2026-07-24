import { describe, it, expect, beforeEach } from 'vitest';
import { validateFixture } from '../helpers/schema-validator.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StaticRouter, profileIntent, selectStrategy } from '../../router/static-router.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../tools/skill-registry.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import type { ToolSpec } from '../../contracts/index.js';
import type { TaskContract } from '../../contracts/index.js';
import { createScriptedGateway } from '../helpers/test-security.js';
import { createGlmGateway } from '../../gateway/glm-gateway-bridge.js';
import type { ModelGateway } from '../../gateway/model-gateway.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

function task(goal: string, over: Partial<TaskContract> = {}): TaskContract {
  return {
    goal,
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints: [],
    ...over,
  } as TaskContract;
}

function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}

function setupRouter(gatewayOverride?: ModelGateway) {
  const tr = new ToolRegistry();
  ['read_file', 'write_file', 'edit_file', 'execute_command', 'list_directory', 'search_files', 'parse_document'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const tsnap = tr.freezeSnapshot();
  const ssnap = sr.freezeSnapshot();
  const pe = new PolicyEngine({ version: 'policy-v1', default_decision: 'deny', allowed_tools: ['read_file','write_file','edit_file','execute_command','list_directory','search_files','parse_document'], allowed_resource_prefixes: ['workspace://'], rules: [] } as Policy);
  const gateway =
    gatewayOverride ?? createScriptedGateway([{ content: 'unused' }]).gateway;
  return new StaticRouter({ toolRegistry: tr, skillRegistry: sr, toolSnapshot: tsnap, skillSnapshot: ssnap, policyEngine: pe, policySnapshotRef: 'policy-v1', gateway });
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
    it('profiles Chinese coding and document requests', () => {
      const coding = profileIntent(task('修复这个 TypeScript bug，然后运行测试'));
      expect(coding).toMatchObject({
        requires_writes: true,
        requires_tests: true,
        multi_step: true,
      });
      expect(coding.domains).toContain('coding');

      const document = profileIntent(task('读取这个文档并总结重点'));
      expect(document.requires_tools).toBe(true);
      expect(document.requires_writes).toBe(false);
      expect(document.domains).toContain('documents');
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
    it('selects the same strategies for equivalent Chinese tasks', () => {
      expect(selectStrategy(profileIntent(task('修复这个 TypeScript bug，然后运行测试')))).toBe(
        'plan_execute',
      );
      expect(selectStrategy(profileIntent(task('读取这个文档并总结重点')))).toBe('react');
      expect(selectStrategy(profileIntent(task('把这段文字润色得更简洁')))).toBe('direct');
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
      const refs = r.run_plan!.registry_snapshot_refs as Record<string, string>;
      expect(refs.tool_registry).toMatch(/^[0-9a-f]{64}$/);
      expect(refs.skill_registry).toMatch(/^[0-9a-f]{64}$/);
    });
    it('binds the actually selected provider, tools and matching skill', () => {
      const r = router.route(task('修复这个 TypeScript bug，然后运行测试'));
      expect(r.run_plan!.model_bindings[0]!.provider).toBe('scripted');
      expect(r.run_plan!.registry_snapshot_refs).toHaveProperty('provider_registry');
      expect(r.run_plan!.tool_grants.map((grant) => grant.tool)).toEqual([
        'read_file',
        'edit_file',
        'execute_command',
      ]);
      expect(r.run_plan!.skill_bindings).toContainEqual(
        expect.objectContaining({ skill_name: 'bug-fix', version: '1.0.0' }),
      );
    });
    it('single-agent RunPlan (agent_count=1)', () => {
      const r = router.route(task('fix the bug'));
      expect((r.run_plan!.agent_graph as { nodes: unknown[] }).nodes.length).toBe(1);
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
      const pe = new PolicyEngine({ version: 'policy-v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command'], allowed_resource_prefixes: ['workspace://'], rules: [] } as Policy);
      const { gateway } = createScriptedGateway([{ content: 'unused' }]);
      const r = new StaticRouter({ toolRegistry: tr, skillRegistry: sr, toolSnapshot: tr.freezeSnapshot(), skillSnapshot: sr.freezeSnapshot(), policyEngine: pe, policySnapshotRef: 'p', gateway });
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
    it('rejects local_only when the frozen Gateway contains only a remote provider', () => {
      const fetchImpl = (() =>
        Promise.reject(new Error('must not dispatch'))) as typeof fetch;
      const { gateway } = createGlmGateway({
        model: 'glm-5.2',
        fetch: fetchImpl,
        secretsBroker: {
          async exchangeCredential(input) {
            return {
              lease_id: 'unused',
              audience: input.audience,
              expires_at: '2030-01-01T00:00:00.000Z',
              secret: 'unused',
            };
          },
        },
        egressPolicy: { async authorize() { return { allowed: true }; } },
      });
      const remoteRouter = setupRouter(gateway);
      const result = remoteRouter.route(
        task('读取这个文档并总结', {
          constraints: [{ type: 'privacy', value: 'local_only' }],
        }),
      );

      expect(result.outcome).toBe('abstain');
      expect(result.abstain_reason).toContain('provider policy veto');
    });
  });

  describe('budget allocation per strategy', () => {
    it('direct gets max_iterations=1', () => {
      const r = router.route(task('rewrite this text'));
      expect((r.run_plan!.budget_allocation as { max_iterations: number }).max_iterations).toBe(1);
    });
    it('plan_execute budgets one proposal per bound tool plus plan and synthesis', () => {
      const r = router.route(task('fix the bug then run the tests'));
      expect((r.run_plan!.budget_allocation as { max_iterations: number }).max_iterations).toBe(
        r.run_plan!.tool_grants.length + 2,
      );
    });
  });

  describe('router never issues capabilities, grants, or consent', () => {
    it('run_plan contains derived_risk_assessment not risk_policy', () => {
      const r = router.route(task('fix the bug'));
      expect(r.run_plan!.derived_risk_assessment).toBeDefined();
      expect((r.run_plan as unknown as { risk_policy?: unknown }).risk_policy).toBeUndefined();
    });
  });


  describe('RunPlan passes full AJV schema validation', () => {
    function validateRunPlan(data: unknown) { return validateFixture('run-plan.schema.json', data); }

    it('direct strategy RunPlan passes schema', () => {
      const r = router.route(task('rewrite this text more concisely'));
      const result = validateRunPlan(r.run_plan);
      if (!result.valid) console.error('direct errors:', result.errors);
      expect(result.valid).toBe(true);
    });

    it('react strategy RunPlan passes schema', () => {
      const r = router.route(task('list the directory and read the matching file'));
      const result = validateRunPlan(r.run_plan);
      if (!result.valid) console.error('react errors:', result.errors);
      expect(result.valid).toBe(true);
    });

    it('plan_execute strategy RunPlan passes schema', () => {
      const r = router.route(task('fix the bug then run the tests then verify'));
      const result = validateRunPlan(r.run_plan);
      if (!result.valid) console.error('plan_execute errors:', result.errors);
      expect(result.valid).toBe(true);
    });

    it('run_id is UUID format', () => {
      const r = router.route(task('rewrite this text'));
      expect(r.run_plan!.run_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('registry_snapshot_refs is an object not array', () => {
      const r = router.route(task('fix the bug'));
      expect(typeof r.run_plan!.registry_snapshot_refs).toBe('object');
      expect(Array.isArray(r.run_plan!.registry_snapshot_refs)).toBe(false);
    });

    it('workflow_graph nodes use step_id/step_type/status', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const wf = r.run_plan!.workflow_graph as { nodes: Record<string, unknown>[] };
      for (const n of wf.nodes) {
        expect(n).toHaveProperty('step_id');
        expect(n).toHaveProperty('step_type');
        expect(n).toHaveProperty('status');
        expect(n).not.toHaveProperty('id');
        expect(n).not.toHaveProperty('name');
      }
    });

    it('workflow_graph edges use from_step/to_step', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const wf = r.run_plan!.workflow_graph as { edges: Record<string, unknown>[] };
      for (const e of wf.edges) {
        expect(e).toHaveProperty('from_step');
        expect(e).toHaveProperty('to_step');
        expect(e).not.toHaveProperty('source');
        expect(e).not.toHaveProperty('target');
      }
    });

    it('agent_graph node has all required fields', () => {
      const r = router.route(task('fix the bug'));
      const ag = r.run_plan!.agent_graph as { nodes: Record<string, unknown>[] };
      expect(ag.nodes).toHaveLength(1);
      const n = ag.nodes[0]!;
      expect(n).toHaveProperty('agent_id');
      expect(n).toHaveProperty('role');
      expect(n).toHaveProperty('model_binding_ref');
      expect(n).toHaveProperty('budget_ceiling');
      expect(n).toHaveProperty('status');
    });

    it('model_bindings have all required fields', () => {
      const r = router.route(task('rewrite this text'));
      const mb = r.run_plan!.model_bindings[0]!;
      expect(mb).toHaveProperty('provider');
      expect(mb).toHaveProperty('model_id');
      expect(mb).toHaveProperty('modality_role');
      expect(mb).toHaveProperty('capability_match_score');
    });

    it('context_strategy has active_plan_injection', () => {
      const r = router.route(task('fix the bug'));
      const cs = (r.run_plan as unknown as { context_strategy?: { active_plan_injection: boolean } }).context_strategy;
      expect(cs).toBeDefined();
      expect(cs!.active_plan_injection).toBe(true);
    });

    it('same input produces same hash and run_id', () => {
      const t = task('fix the bug then run the tests');
      const r1 = router.route(t);
      const r2 = router.route(t);
      expect(r1.run_plan!.run_plan_hash).toBe(r2.run_plan!.run_plan_hash);
      expect(r1.run_plan!.run_id).toBe(r2.run_plan!.run_id);
    });

    it('different constraints produce different hash', () => {
      const t1 = task('fix the bug', { constraints: [{ type: 'privacy', value: 'local_only' }] });
      const t2 = task('fix the bug', { constraints: [{ type: 'budget', value: '1000' }] });
      expect(router.route(t1).run_plan!.run_plan_hash).not.toBe(router.route(t2).run_plan!.run_plan_hash);
    });

    it('no as unknown as RunPlan in source', () => {
      const src = readFileSync(join(__dirname, '../../router/static-router.ts'), 'utf8');
      expect(src).not.toContain('as unknown as RunPlan');
    });
  });



  describe('mutation-killing: profileIntent edge cases', () => {
    it('detects "delete" as a write operation', () => {
      expect(profileIntent(task('delete the file')).requires_writes).toBe(true);
    });
    it('detects "remove" as a write operation', () => {
      expect(profileIntent(task('remove the old code')).requires_writes).toBe(true);
    });
    it('detects "modify" as a write operation', () => {
      expect(profileIntent(task('modify the function')).requires_writes).toBe(true);
    });
    it('detects "update" as a write operation', () => {
      expect(profileIntent(task('update the config')).requires_writes).toBe(true);
    });
    it('detects "implement" as a write operation', () => {
      expect(profileIntent(task('implement the feature')).requires_writes).toBe(true);
    });
    it('detects "refactor" as a write operation', () => {
      expect(profileIntent(task('refactor the module')).requires_writes).toBe(true);
    });
    it('detects "patch" as a write operation', () => {
      expect(profileIntent(task('patch the vulnerability')).requires_writes).toBe(true);
    });
    it('detects "test" as requiring tests', () => {
      expect(profileIntent(task('test the function')).requires_tests).toBe(true);
    });
    it('detects "verify" as requiring tests', () => {
      expect(profileIntent(task('verify the output')).requires_tests).toBe(true);
    });
    it('detects "build" as requiring tests', () => {
      expect(profileIntent(task('build the project')).requires_tests).toBe(true);
    });
    it('detects "compile" as requiring tests', () => {
      expect(profileIntent(task('compile the code')).requires_tests).toBe(true);
    });
    it('detects "lint" as requiring tests', () => {
      expect(profileIntent(task('lint the source')).requires_tests).toBe(true);
    });
    it('detects "check" as requiring tests', () => {
      expect(profileIntent(task('check the results')).requires_tests).toBe(true);
    });
    it('detects "run" as requiring tests', () => {
      expect(profileIntent(task('run the suite')).requires_tests).toBe(true);
    });
    it('detects "plan" as explicit plan', () => {
      expect(profileIntent(task('plan the migration')).explicit_plan).toBe(true);
    });
    it('detects "step by step" as explicit plan', () => {
      expect(profileIntent(task('do this step by step')).explicit_plan).toBe(true);
    });
    it('detects "workflow" as explicit plan', () => {
      expect(profileIntent(task('create a workflow for this')).explicit_plan).toBe(true);
    });
    it('detects "pipeline" as explicit plan', () => {
      expect(profileIntent(task('build a pipeline for data')).explicit_plan).toBe(true);
    });
    it('detects "sequence" as explicit plan', () => {
      expect(profileIntent(task('execute the sequence of steps')).explicit_plan).toBe(true);
    });
    it('detects step markers: "then"', () => {
      expect(profileIntent(task('read the file then summarize it')).multi_step).toBe(true);
    });
    it('detects step markers: "after"', () => {
      expect(profileIntent(task('read data after processing')).multi_step).toBe(true);
    });
    it('detects step markers: "next"', () => {
      expect(profileIntent(task('read the file next analyze it')).multi_step).toBe(true);
    });

    it('detects step markers: semicolons', () => {
      expect(profileIntent(task('read the file; summarize it')).multi_step).toBe(true);
    });
    it('short goal has low ambiguity', () => {
      expect(profileIntent(task('hi')).ambiguity).toBe('low');
    });
    it('no success criteria has high ambiguity', () => {
      expect(profileIntent(task('do something', { success_criteria: [] as TaskContract['success_criteria'] })).ambiguity).toBe('high');
    });
    it('detects coding domain', () => {
      expect(profileIntent(task('fix the bug in the function')).domains).toContain('coding');
    });
    it('detects documents domain', () => {
      expect(profileIntent(task('summarize the document')).domains).toContain('documents');
    });
    it('detects research domain', () => {
      expect(profileIntent(task('research the sources and cite')).domains).toContain('research');
    });
    it('detects writing domain', () => {
      expect(profileIntent(task('write a draft article')).domains).toContain('writing');
    });
    it('detects planning domain', () => {
      expect(profileIntent(task('plan the task schedule')).domains).toContain('planning');
    });
    it('requires_tools is true for write tasks', () => {
      expect(profileIntent(task('write the file')).requires_tools).toBe(true);
    });
    it('requires_tools is true for test tasks', () => {
      expect(profileIntent(task('run the tests')).requires_tools).toBe(true);
    });
    it('requires_tools is true for read tasks', () => {
      expect(profileIntent(task('read the file')).requires_tools).toBe(true);
    });
    it('requires_tools is false for pure text tasks', () => {
      expect(profileIntent(task('rewrite this paragraph')).requires_tools).toBe(false);
    });
  });

  describe('mutation-killing: selectStrategy edge cases', () => {
    it('plan_execute for write+test', () => {
      expect(selectStrategy({ goal: '', domains: [], requires_tools: true, requires_writes: true, requires_tests: true, multi_step: true, explicit_plan: false, ambiguity: 'none', missing_info: [], success_criteria_count: 1 })).toBe('plan_execute');
    });
    it('plan_execute for explicit plan', () => {
      expect(selectStrategy({ goal: '', domains: [], requires_tools: false, requires_writes: false, requires_tests: false, multi_step: false, explicit_plan: true, ambiguity: 'none', missing_info: [], success_criteria_count: 1 })).toBe('plan_execute');
    });
    it('react for tool-required non-write non-test', () => {
      expect(selectStrategy({ goal: '', domains: [], requires_tools: true, requires_writes: false, requires_tests: false, multi_step: false, explicit_plan: false, ambiguity: 'none', missing_info: [], success_criteria_count: 1 })).toBe('react');
    });
    it('direct for no tools', () => {
      expect(selectStrategy({ goal: '', domains: [], requires_tools: false, requires_writes: false, requires_tests: false, multi_step: false, explicit_plan: false, ambiguity: 'none', missing_info: [], success_criteria_count: 1 })).toBe('direct');
    });
  });



  describe('mutation-killing: RunPlan structural verification', () => {
    it('plan_execute RunPlan has multiple steps (plan, execute, execute, execute, verify)', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const wf = r.run_plan!.workflow_graph as { nodes: { step_type: string }[] };
      expect(wf.nodes.length).toBeGreaterThan(2);
      expect(wf.nodes.some(n => n.step_type === 'verification')).toBe(true);
      expect(wf.nodes.some(n => n.step_type === 'model_call')).toBe(true);
    });

    it('direct RunPlan has single step', () => {
      const r = router.route(task('rewrite this text'));
      const wf = r.run_plan!.workflow_graph as { nodes: unknown[] };
      expect(wf.nodes.length).toBe(1);
    });

    it('workflow edges have condition: null', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const wf = r.run_plan!.workflow_graph as { edges: { condition: unknown }[] };
      for (const e of wf.edges) {
        expect(e.condition).toBeNull();
      }
    });

    it('agent node has budget_ceiling with token_limit and usd_micros', () => {
      const r = router.route(task('fix the bug'));
      const ag = r.run_plan!.agent_graph as { nodes: { budget_ceiling: { token_limit: string; usd_micros: string } }[] };
      const bc = ag.nodes[0]!.budget_ceiling;
      expect(bc.token_limit).toBe('1000000');
      expect(bc.usd_micros).toBe('5000000');
    });

    it('agent node has delegation_depth 0 and isolation none', () => {
      const r = router.route(task('fix the bug'));
      const ag = r.run_plan!.agent_graph as { nodes: { delegation_depth: number; isolation: string }[] };
      expect(ag.nodes[0]!.delegation_depth).toBe(0);
      expect(ag.nodes[0]!.isolation).toBe('none');
    });

    it('model_binding has the selected frozen provider identity', () => {
      const r = router.route(task('fix the bug'));
      const mb = r.run_plan!.model_bindings[0]!;
      expect(mb.provider).toBe('scripted');
      expect(mb.model_id).toBe('scripted');
      expect(mb.modality_role).toBe('reasoning');
      expect(mb.capability_match_score).toBe(1.0);
    });

    it('environment_bindings has sandbox true and network false', () => {
      const r = router.route(task('fix the bug'));
      const eb = (r.run_plan as unknown as { environment_bindings: { sandbox: boolean; network: boolean }[] }).environment_bindings;
      expect(eb[0]!.sandbox).toBe(true);
      expect(eb[0]!.network).toBe(false);
    });

    it('derived_risk_assessment has risk_tier 2 for writes', () => {
      const r = router.route(task('fix the bug'));
      const dra = (r.run_plan as unknown as { derived_risk_assessment: { risk_tier: number; egress: string } }).derived_risk_assessment;
      expect(dra.risk_tier).toBe(2);
      expect(dra.egress).toBe('none');
    });

    it('derived_risk_assessment has risk_tier 1 for no writes', () => {
      const r = router.route(task('rewrite this text'));
      const dra = (r.run_plan as unknown as { derived_risk_assessment: { risk_tier: number } }).derived_risk_assessment;
      expect(dra.risk_tier).toBe(1);
    });

    it('required_consent required is true for writes', () => {
      const r = router.route(task('fix the bug'));
      const rc = (r.run_plan as unknown as { required_consent: { required: boolean } }).required_consent;
      expect(rc.required).toBe(true);
    });

    it('required_consent required is false for no writes', () => {
      const r = router.route(task('rewrite this text'));
      const rc = (r.run_plan as unknown as { required_consent: { required: boolean } }).required_consent;
      expect(rc.required).toBe(false);
    });

    it('registry_snapshot_refs has tool_registry and skill_registry keys', () => {
      const r = router.route(task('fix the bug'));
      const refs = r.run_plan!.registry_snapshot_refs as Record<string, string>;
      expect(refs.tool_registry).toBeDefined();
      expect(refs.skill_registry).toBeDefined();
    });

    it('budget_allocation max_iterations is 1 for direct', () => {
      const r = router.route(task('rewrite this text'));
      const ba = (r.run_plan as unknown as { budget_allocation: { max_iterations: number } }).budget_allocation;
      expect(ba.max_iterations).toBe(1);
    });

    it('budget_allocation max_iterations is 3 for react', () => {
      const r = router.route(task('read the file'));
      const ba = (r.run_plan as unknown as { budget_allocation: { max_iterations: number } }).budget_allocation;
      expect(ba.max_iterations).toBe(3);
    });

    it('persistence_policy has event_log true and snapshot true', () => {
      const r = router.route(task('fix the bug'));
      const pp = (r.run_plan as unknown as { persistence_policy: { event_log: boolean; snapshot: boolean } }).persistence_policy;
      expect(pp.event_log).toBe(true);
      expect(pp.snapshot).toBe(true);
    });

    it('cancellation_policy has abortable true', () => {
      const r = router.route(task('fix the bug'));
      const cp = (r.run_plan as unknown as { cancellation_policy: { abortable: boolean } }).cancellation_policy;
      expect(cp.abortable).toBe(true);
    });

    it('fallback_policy has on_failure abort', () => {
      const r = router.route(task('fix the bug'));
      const fp = (r.run_plan as unknown as { fallback_policy: { on_failure: string } }).fallback_policy;
      expect(fp.on_failure).toBe('abort');
    });

    it('tool_grants have granted false for all tools', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const tg = (r.run_plan as unknown as { tool_grants: { tool: string; granted: boolean }[] }).tool_grants;
      for (const g of tg) {
        expect(g.granted).toBe(false);
      }
    });
  });



  describe('mutation-killing: RunPlan exact value assertions', () => {
    it('agent_graph has exact agent_id, role, model_binding_ref values', () => {
      const r = router.route(task('fix the bug'));
      const ag = r.run_plan!.agent_graph as { nodes: Record<string, unknown>[] };
      expect(ag.nodes[0]!.agent_id).toBe('agent-1');
      expect(ag.nodes[0]!.role).toBe('worker');
      expect(ag.nodes[0]!.model_binding_ref).toBe('binding-1');
    });

    it('agent_graph budget_ceiling has exact token_limit and usd_micros', () => {
      const r = router.route(task('fix the bug'));
      const ag = r.run_plan!.agent_graph as { nodes: { budget_ceiling: { token_limit: string; usd_micros: string } }[] };
      expect(ag.nodes[0]!.budget_ceiling.token_limit).toBe('1000000');
      expect(ag.nodes[0]!.budget_ceiling.usd_micros).toBe('5000000');
    });

    it('agent_graph has status pending, delegation_depth 0, isolation none', () => {
      const r = router.route(task('fix the bug'));
      const ag = r.run_plan!.agent_graph as { nodes: Record<string, unknown>[] };
      expect(ag.nodes[0]!.status).toBe('pending');
      expect(ag.nodes[0]!.delegation_depth).toBe(0);
      expect(ag.nodes[0]!.isolation).toBe('none');
    });

    it('context_graph has exact node_id, agent_id_ref, context_scope', () => {
      const r = router.route(task('fix the bug'));
      const cg = r.run_plan!.context_graph as { nodes: Record<string, unknown>[] };
      expect(cg.nodes[0]!.node_id).toBe('ctx-1');
      expect(cg.nodes[0]!.agent_id_ref).toBe('agent-1');
      expect(cg.nodes[0]!.context_scope).toBe('full');
    });

    it('verification_graph for test criterion has verification_type test_execution', () => {
      const r = router.route(task('fix the bug', { success_criteria: [{ criterion: 'tests pass', verification_method: 'test' }] }));
      const vg = r.run_plan!.verification_graph as { nodes: Record<string, unknown>[] };
      expect(vg.nodes[0]!.verification_id).toBe('verify-0');
      expect(vg.nodes[0]!.verification_type).toBe('test_execution');
      expect(vg.nodes[0]!.strictness).toBe('standard');
    });

    it('verification_graph for deterministic criterion has verification_type deterministic', () => {
      const r = router.route(task('fix the bug', { success_criteria: [{ criterion: 'diff only modifies', verification_method: 'deterministic' }] }));
      const vg = r.run_plan!.verification_graph as { nodes: Record<string, unknown>[] };
      expect(vg.nodes[0]!.verification_type).toBe('deterministic');
    });

    it('verification_graph for human_review criterion has verification_type human_review', () => {
      const r = router.route(task('fix the bug', { success_criteria: [{ criterion: 'user approves', verification_method: 'human_review' }] }));
      const vg = r.run_plan!.verification_graph as { nodes: Record<string, unknown>[] };
      expect(vg.nodes[0]!.verification_type).toBe('human_review');
    });

    it('verification_graph for semantic criterion requires an independent verifier', () => {
      const r = router.route(task('fix the bug', { success_criteria: [{ criterion: 'good writing', verification_method: 'semantic' }] }));
      const vg = r.run_plan!.verification_graph as { nodes: Record<string, unknown>[] };
      expect(vg.nodes[0]!.verification_type).toBe('independent_verifier');
      expect(vg.nodes[0]!.acceptance_criteria_refs).toEqual(['0']);
    });

    it('verification_graph step_id_ref points to last step', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const vg = r.run_plan!.verification_graph as { nodes: { step_id_ref: string }[] };
      const wf = r.run_plan!.workflow_graph as { nodes: { step_id: string }[] };
      const lastStepId = wf.nodes[wf.nodes.length - 1]!.step_id;
      expect(vg.nodes[0]!.step_id_ref).toBe(lastStepId);
    });

    it('plan_execute binds each proposed tool to one preceding model proposal node', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const wf = r.run_plan!.workflow_graph;
      const toolNodes = wf.nodes.filter((node) => node.step_type === 'tool_call');
      expect(toolNodes.map((node) => node.tool_name)).toEqual(
        r.run_plan!.tool_grants.map((grant) => grant.tool),
      );
      for (const toolNode of toolNodes) {
        const incoming = wf.edges.filter(
          (edge) => edge.to_step === toolNode.step_id,
        );
        expect(incoming).toHaveLength(1);
        expect(
          wf.nodes.find((node) => node.step_id === incoming[0]!.from_step)!
            .step_type,
        ).toBe('model_call');
      }
    });

    it('model_bindings has exact provider, model_id, modality_role, capability_match_score', () => {
      const r = router.route(task('fix the bug'));
      const mb = r.run_plan!.model_bindings[0]!;
      expect(mb.provider).toBe('scripted');
      expect(mb.model_id).toBe('scripted');
      expect(mb.modality_role).toBe('reasoning');
      expect(mb.capability_match_score).toBe(1.0);
    });

    it('schema_version is run-plan.v1', () => {
      const r = router.route(task('fix the bug'));
      expect(r.run_plan!.schema_version).toBe('run-plan.v1');
    });

    it('revision is 1', () => {
      const r = router.route(task('fix the bug'));
      expect(r.run_plan!.revision).toBe(1);
    });

    it('previous_revision_hash is null', () => {
      const r = router.route(task('fix the bug'));
      expect(r.run_plan!.previous_revision_hash).toBeNull();
    });

    it('experience_profile is default', () => {
      const r = router.route(task('fix the bug'));
      expect(r.run_plan!.experience_profile).toBe('default');
    });

    it('policy_snapshot_ref matches input', () => {
      const r = router.route(task('fix the bug'));
      expect(r.run_plan!.policy_snapshot_ref).toBe('policy-v1');
    });

    it('fallback_policy on_failure is abort', () => {
      const r = router.route(task('fix the bug'));
      expect((r.run_plan as unknown as { fallback_policy: { on_failure: string } }).fallback_policy.on_failure).toBe('abort');
    });

    it('derived_risk_assessment egress is none', () => {
      const r = router.route(task('fix the bug'));
      expect((r.run_plan as unknown as { derived_risk_assessment: { egress: string } }).derived_risk_assessment.egress).toBe('none');
    });

    it('router abstain returns intent with goal', () => {
      const tr = new ToolRegistry();
      const sr = new SkillRegistry();
      const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file'], allowed_resource_prefixes: ['workspace://'], rules: [] } as Policy);
      const { gateway } = createScriptedGateway([{ content: 'unused' }]);
      const r = new StaticRouter({ toolRegistry: tr, skillRegistry: sr, toolSnapshot: tr.freezeSnapshot(), skillSnapshot: sr.freezeSnapshot(), policyEngine: pe, policySnapshotRef: 'p', gateway });
      const result = r.route(task('fix the bug then run the tests'));
      expect(result.outcome).toBe('abstain');
      expect(result.intent.goal).toBe('fix the bug then run the tests');
      expect(result.policy_prefilter_passed).toBe(false);
    });

    it('router ask_user returns intent with goal', () => {
      const result = router.route(task('do something', { success_criteria: [] as TaskContract['success_criteria'] }));
      expect(result.outcome).toBe('ask_user');
      expect(result.intent.goal).toBe('do something');
      expect(result.ask_user_message).toContain('success criteria');
    });

    it('bug-fix skill proposes only its required read, edit and test tools', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const tg = (r.run_plan as unknown as { tool_grants: { tool: string }[] }).tool_grants;
      expect(tg.map((grant) => grant.tool)).toEqual([
        'read_file',
        'edit_file',
        'execute_command',
      ]);
    });

    it('requiredToolsFor returns execute_command for tests', () => {
      const r = router.route(task('fix the bug then run the tests'));
      const tg = (r.run_plan as unknown as { tool_grants: { tool: string }[] }).tool_grants;
      expect(tg.some(g => g.tool === 'execute_command')).toBe(true);
    });

    it('requiredToolsFor returns read_file for read-only tasks', () => {
      const r = router.route(task('read the file and report'));
      const tg = (r.run_plan as unknown as { tool_grants: { tool: string }[] }).tool_grants;
      expect(tg.some(g => g.tool === 'read_file')).toBe(true);
    });

    it('direct strategy has no tool_grants', () => {
      const r = router.route(task('rewrite this text'));
      const tg = (r.run_plan as unknown as { tool_grants: unknown[] }).tool_grants;
      expect(tg).toHaveLength(0);
    });

    it('run_plan_hash is 64 hex chars', () => {
      const r = router.route(task('fix the bug'));
      expect(r.run_plan!.run_plan_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('context_strategy active_plan_injection is true', () => {
      const r = router.route(task('fix the bug'));
      const cs = (r.run_plan as unknown as { context_strategy: { active_plan_injection: boolean } }).context_strategy;
      expect(cs.active_plan_injection).toBe(true);
    });
  });

});
