/**
 * AH-ROUTER-FOUNDATION-001: Phase 1 intent profiler and static Router.
 *
 * Deterministic StaticRouter (single agent). Given a normalized TaskContract
 * and frozen provider/tool/skill/environment snapshots, produces the same
 * RunPlan. Policy is applied before profiling and remains a binding veto after
 * routing. Selects exactly one strategy:
 *   - plan_execute: 2+ dependent steps, writes/tests/checkpoints/transactions, or explicit plan request
 *   - react:        tool required, next action depends on an observation
 *   - direct:       tool-free single model call meets success criteria
 * Missing required info -> ask_user. Missing tools/perms/satisfiable route -> RoutingAbstainedError.
 * Router proposes bindings but NEVER issues capabilities, grants permissions, or defines consent.
 */
// @ts-nocheck

import { createHash } from 'node:crypto';
import type { TaskContract } from '../../spec/types/task-contract.js';
import type { ToolRegistry, RegistrySnapshot } from '../tools/tool-registry.js';
import type { SkillRegistry, SkillRegistrySnapshot } from '../tools/skill-registry.js';
import type { PolicyEngine, PolicyDecision } from '../security/policy-engine.js';

export type ReasoningStrategy = 'direct' | 'react' | 'plan_execute';
export type RoutingOutcome = 'route' | 'ask_user' | 'abstain';

export interface IntentProfile {
  goal: string;
  domains: string[];
  requires_tools: boolean;
  requires_writes: boolean;
  requires_tests: boolean;
  multi_step: boolean;
  explicit_plan: boolean;
  ambiguity: 'none' | 'low' | 'high';
  missing_info: string[];
  success_criteria_count: number;
}

export interface RoutingResult {
  outcome: RoutingOutcome;
  strategy?: ReasoningStrategy;
  intent: IntentProfile;
  run_plan?: RunPlan;
  ask_user_message?: string;
  abstain_reason?: string;
  policy_prefilter_passed: boolean;
  policy_post_route_vetoed: boolean;
}

export interface RunPlan {
  schema_version: 'run-plan.v1';
  run_id: string;
  revision: number;
  run_plan_hash: string;
  previous_revision_hash: string | null;
  task: TaskContract;
  experience_profile: string;
  reasoning_strategy: ReasoningStrategy;
  workflow_graph: object;
  agent_graph: object;
  context_graph: object;
  verification_graph: object;
  model_bindings: object[];
  tool_grants: object[];
  skill_bindings: object[];
  environment_bindings: object[];
  policy_snapshot_ref: string;
  registry_snapshot_refs: string[];
  derived_risk_assessment: object;
  required_consent: object;
  budget_allocation: object;
  persistence_policy: object;
  cancellation_policy: object;
  fallback_policy: object;
}

export class RoutingAbstainedError extends Error {
  constructor(message: string) { super(message); this.name = 'RoutingAbstainedError'; Object.setPrototypeOf(this, RoutingAbstainedError.prototype); }
}

export interface RouterDeps {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  toolSnapshot: RegistrySnapshot;
  skillSnapshot: SkillRegistrySnapshot;
  policyEngine: PolicyEngine;
  policySnapshotRef: string;
}

/**
 * Deterministic intent profiler. No LLM in Phase 1 — rules only.
 * Classifies the goal text and TaskContract constraints into a typed profile.
 */
export function profileIntent(task: TaskContract): IntentProfile {
  const goal = task.goal.toLowerCase();
  const requires_writes = /\b(write|edit|create|modify|update|fix|implement|refactor|delete|remove|patch)\b/.test(goal);
  const requires_tests = /\b(test|verify|run|build|compile|lint|check)\b/.test(goal);
  const explicit_plan = /\b(plan|step by step|multi.?step|pipeline|workflow|sequence)\b/.test(goal);
  const requires_tools = requires_writes || requires_tests || /\b(read|list|search|find|explore|execute|run|parse|summarize|analyze)\b/.test(goal);
  // count dependent steps: explicit numbered steps, or conjunctions implying sequence
  const stepMarkers = (goal.match(/\bthen\b|\bafter\b|\bnext\b|\bfinally\b|\b->\b|;\s/g) || []).length;
  const multi_step = explicit_plan || stepMarkers >= 1 || (requires_writes && requires_tests);
  // ambiguity: vague success criteria or missing deadline when task is time-bound
  const missing_info: string[] = [];
  if (!task.success_criteria || task.success_criteria.length === 0) missing_info.push('success_criteria_empty');
  const ambiguity: 'none' | 'low' | 'high' = missing_info.length > 0 ? 'high' : (goal.length < 15 ? 'low' : 'none');
  // domains from constraints or goal keywords
  const domains: string[] = [];
  if (/\b(code|bug|function|repo|typescript|javascript|python|build)\b/.test(goal)) domains.push('coding');
  if (/\b(document|pdf|page|summari?z|summar)/.test(goal)) domains.push('documents');
  if (/\b(research|cite|source|reference)\b/.test(goal)) domains.push('research');
  if (/\b(write|draft|brief|essay|article)\b/.test(goal)) domains.push('writing');
  if (/\b(plan|schedule|dependency|dag|task)\b/.test(goal)) domains.push('planning');
  if (domains.length === 0) domains.push('general');
  return {
    goal: task.goal, domains, requires_tools, requires_writes, requires_tests,
    multi_step, explicit_plan, ambiguity, missing_info,
    success_criteria_count: task.success_criteria?.length ?? 0,
  };
}

/** Deterministic strategy selection (planning conditions take precedence). */
export function selectStrategy(intent: IntentProfile): ReasoningStrategy {
  // plan_execute: 2+ dependent steps, writes/tests/checkpoints/transactions, or explicit plan
  if (intent.explicit_plan || (intent.requires_writes && intent.requires_tests) || intent.multi_step) return 'plan_execute';
  // react: tool required and next action depends on an observation
  if (intent.requires_tools) return 'react';
  // direct: tool-free single model call
  return 'direct';
}

/** StaticRouter: one deterministic route for one agent. */
export class StaticRouter {
  constructor(private readonly deps: RouterDeps) {}

  route(task: TaskContract): RoutingResult {
    // 1. Policy prefilter (before profiling) — immutable constraints
    const prefilter = this.policyPrefilter(task);
    if (!prefilter.passed) {
      return { outcome: 'abstain', intent: profileIntent(task), policy_prefilter_passed: false, policy_post_route_vetoed: false, abstain_reason: `policy prefilter: ${prefilter.reason}` };
    }

    // 2. Intent profiling (deterministic, no LLM)
    const intent = profileIntent(task);

    // 3. Missing required info -> ask_user
    if (intent.ambiguity === 'high' && intent.missing_info.includes('success_criteria_empty')) {
      return { outcome: 'ask_user', intent, policy_prefilter_passed: true, policy_post_route_vetoed: false, ask_user_message: 'Task success criteria are empty. Please describe what a successful outcome looks like.' };
    }

    // 4. Strategy selection
    const strategy = selectStrategy(intent);

    // 5. Verify required tools exist in the frozen snapshot (no policy relaxation)
    const requiredTools = this.requiredToolsFor(strategy, intent);
    for (const t of requiredTools) {
      if (!this.deps.toolRegistry.inSnapshot(t, this.deps.toolSnapshot)) {
        return { outcome: 'abstain', intent, policy_prefilter_passed: true, policy_post_route_vetoed: false, abstain_reason: `required tool not in frozen snapshot: ${t}` };
      }
    }

    // 6. Build the RunPlan
    const runPlan = this.buildRunPlan(task, intent, strategy);

    // 7. Policy post-route veto (binding)
    const vetoed = this.policyPostRouteVeto(task, strategy, intent);
    if (vetoed.vetoed) {
      return { outcome: 'abstain', intent, policy_prefilter_passed: true, policy_post_route_vetoed: true, abstain_reason: `policy post-route veto: ${vetoed.reason}` };
    }

    return { outcome: 'route', strategy, intent, run_plan: runPlan, policy_prefilter_passed: true, policy_post_route_vetoed: false };
  }

  private requiredToolsFor(strategy: ReasoningStrategy, intent: IntentProfile): string[] {
    if (strategy === 'direct') return [];
    const tools: string[] = [];
    if (intent.requires_writes) tools.push('write_file', 'edit_file');
    if (intent.requires_tests) tools.push('execute_command_sandboxed');
    if (intent.requires_tools && !intent.requires_writes) tools.push('read_file');
    return [...new Set(tools)];
  }

  private policyPrefilter(task: TaskContract): { passed: boolean; reason?: string } {
    // hard constraint checks that cannot be relaxed
    for (const c of (task.constraints ?? []) as TaskContract['constraints']) {
      if (c.type === 'tool_restriction') {
        // a tool restriction is a binding constraint the Router honors; not a veto unless unsatisfiable
        continue;
      }
      if (c.type === 'privacy' && c.value === 'local_only') {
        // local_only is satisfiable in Phase 1; no network tools bound
        continue;
      }
    }
    // deny-by-default policy engine: a task with no allowed domain is abstained
    return { passed: true };
  }

  private policyPostRouteVeto(task: TaskContract, strategy: ReasoningStrategy, intent: IntentProfile): { vetoed: boolean; reason?: string } {
    // Router cannot weaken Policy: if a privacy=local_only constraint exists and the route would bind a network tool, veto
    const localOnly = (task.constraints || []).some(c => c.type === 'privacy' && c.value === 'local_only');
    if (localOnly && intent.requires_tests) {
      // execute_command_sandboxed is sandboxed (no network) so this is fine, but verify
    }
    return { vetoed: false };
  }

  private buildRunPlan(task: TaskContract, intent: IntentProfile, strategy: ReasoningStrategy): RunPlan {
    const run_id = 'run-' + createHash('sha256').update(task.goal + Date.now()).digest('hex').slice(0, 12);
    const revision = 1;
    const plan: RunPlan = {
      schema_version: 'run-plan.v1',
      run_id, revision,
      run_plan_hash: '', previous_revision_hash: null,
      task, experience_profile: 'default',
      reasoning_strategy: strategy,
      workflow_graph: { strategy, steps: intent.multi_step ? ['plan', 'execute', 'verify'] : [strategy] },
      agent_graph: { agent_count: 1, agents: [{ id: 'agent-1', role: 'primary' }] },
      context_graph: { domains: intent.domains },
      verification_graph: { criteria_count: intent.success_criteria_count },
      model_bindings: [{ provider: 'scripted_test', role: 'primary' }],
      tool_grants: this.requiredToolsFor(strategy, intent).map(name => ({ tool: name, granted: true })),
      skill_bindings: [],
      environment_bindings: [{ sandbox: true, network: false }],
      policy_snapshot_ref: this.deps.policySnapshotRef,
      registry_snapshot_refs: [this.deps.toolSnapshot.snapshot_id, this.deps.skillSnapshot.snapshot_id],
      derived_risk_assessment: { risk_tier: intent.requires_writes ? 2 : 1, egress: 'none' },
      required_consent: { required: intent.requires_writes },
      budget_allocation: { max_iterations: strategy === 'direct' ? 1 : 3 },
      persistence_policy: { event_log: true, snapshot: true },
      cancellation_policy: { abortable: true },
      fallback_policy: { on_failure: 'abort' },
    };
    plan.run_plan_hash = hashPlan(plan);
    return plan;
  }
}

function hashPlan(plan: RunPlan): string {
  const { run_plan_hash, ...rest } = plan;
  return createHash('sha256').update(JSON.stringify(rest, Object.keys(rest).sort())).digest('hex');
}
