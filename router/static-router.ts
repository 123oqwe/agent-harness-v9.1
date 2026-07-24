/**
 * AH-ROUTER-FOUNDATION-001: Phase 1 intent profiler and static Router.
 *
 * Deterministic StaticRouter (single agent). Given a normalized TaskContract
 * and frozen provider/tool/skill/environment snapshots, produces the same
 * RunPlan. Policy is applied before profiling and remains a binding veto after
 * routing.
 *
 * Router proposes bindings but NEVER issues capabilities, grants permissions,
 * or defines consent. tool_grants are proposed bindings, not grants.
 */
import { createHash } from 'node:crypto';
import type { TaskContract } from '../contracts/index.js';
import type { RunPlan } from '../contracts/index.js';
export type { RunPlan };
import type { ToolRegistry, RegistrySnapshot } from '../tools/tool-registry.js';
import type { SkillRegistry, SkillRegistrySnapshot } from '../tools/skill-registry.js';
import type { PolicyEngine } from '../security/policy-engine.js';

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
  ask_user_message?: string | undefined;
  abstain_reason?: string | undefined;
  policy_prefilter_passed: boolean;
  policy_post_route_vetoed: boolean;
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

/** Deterministic intent profiler. No LLM in Phase 1 — rules only. */
export function profileIntent(task: TaskContract): IntentProfile {
  const goal = task.goal.toLowerCase();
  const requires_writes = /\b(write|edit|create|modify|update|fix|implement|refactor|delete|remove|patch)\b/.test(goal);
  const requires_tests = /\b(test|verify|run|build|compile|lint|check)\b/.test(goal);
  const explicit_plan = /\b(plan|step by step|multi.?step|pipeline|workflow|sequence)\b/.test(goal);
  const requires_tools = requires_writes || requires_tests || /\b(read|list|search|find|explore|execute|run|parse|summarize|analyze)\b/.test(goal);
  const stepMarkers = (goal.match(/\bthen\b|\bafter\b|\bnext\b|\bfinally\b|\b->\b|;\s/g) || []).length;
  const multi_step = explicit_plan || stepMarkers >= 1 || (requires_writes && requires_tests);
  const missing_info: string[] = [];
  if (!task.success_criteria || task.success_criteria.length === 0) missing_info.push('success_criteria_empty');
  const ambiguity: 'none' | 'low' | 'high' = missing_info.length > 0 ? 'high' : (goal.length < 15 ? 'low' : 'none');
  const domains: string[] = [];
  if (/\b(code|bug|function|repo|typescript|javascript|python|build)\b/.test(goal)) domains.push('coding');
  if (/\b(document|pdf|page|summari?z|summar)/.test(goal)) domains.push('documents');
  if (/\b(research|cite|source|reference)\b/.test(goal)) domains.push('research');
  if (/\b(write|draft|brief|essay|article)\b/.test(goal)) domains.push('writing');
  if (/\b(plan|schedule|dependency|dag|task)\b/.test(goal)) domains.push('planning');
  if (domains.length === 0) domains.push('general');
  return { goal: task.goal, domains, requires_tools, requires_writes, requires_tests, multi_step, explicit_plan, ambiguity, missing_info, success_criteria_count: task.success_criteria?.length ?? 0 };
}

export function selectStrategy(intent: IntentProfile): ReasoningStrategy {
  if (intent.explicit_plan || (intent.requires_writes && intent.requires_tests) || intent.multi_step) return 'plan_execute';
  if (intent.requires_tools) return 'react';
  return 'direct';
}

/** Deterministic run_id: UUID v5-style (deterministic from task + snapshots, no Date.now()). */
function deterministicRunId(task: TaskContract, toolSnapId: string, skillSnapId: string): string {
  const hash = createHash('sha256').update(JSON.stringify(task) + toolSnapId + skillSnapId).digest('hex');
  // Format as UUID: 8-4-4-4-12 hex chars from the hash
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}

/** Recursive canonical JSON for stable hashing. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalize((value as Record<string, unknown>)[k])]));
  }
  return value;
}
function canonicalHash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(obj))).digest('hex');
}

export class StaticRouter {
  constructor(private readonly deps: RouterDeps) {}

  route(task: TaskContract): RoutingResult {
    // 1. Policy prefilter: check the real PolicyEngine allowed_tools
    const prefilter = this.policyPrefilter(task);
    if (!prefilter.passed) {
      return { outcome: 'abstain', intent: profileIntent(task), policy_prefilter_passed: false, policy_post_route_vetoed: false, abstain_reason: `policy prefilter: ${prefilter.reason}` };
    }

    // 2. Intent profiling (deterministic)
    const intent = profileIntent(task);

    // 3. Missing required info -> ask_user
    if (intent.ambiguity === 'high' && intent.missing_info.includes('success_criteria_empty')) {
      return { outcome: 'ask_user', intent, policy_prefilter_passed: true, policy_post_route_vetoed: false, ask_user_message: 'Task success criteria are empty. Please describe what a successful outcome looks like.' };
    }

    // 4. Strategy selection
    const strategy = selectStrategy(intent);

    // 5. Verify required tools exist in the frozen snapshot
    const requiredTools = this.requiredToolsFor(strategy, intent);
    for (const t of requiredTools) {
      if (!this.deps.toolRegistry.inSnapshot(t, this.deps.toolSnapshot)) {
        return { outcome: 'abstain', intent, policy_prefilter_passed: true, policy_post_route_vetoed: false, abstain_reason: `required tool not in frozen snapshot: ${t}` };
      }
    }

    // 6. Build the RunPlan (deterministic, no Date.now())
    const runPlan = this.buildRunPlan(task, intent, strategy);

    // 7. Policy post-route veto: check if route violates privacy constraints
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
    if (intent.requires_tests) tools.push('execute_command');
    if (intent.requires_tools && !intent.requires_writes) tools.push('read_file');
    return [...new Set(tools)];
  }

  private policyPrefilter(task: TaskContract): { passed: boolean; reason?: string } {
    // Check real Policy constraints from the PolicyEngine
    const policy = this.deps.policyEngine.snapshot;
    // If task requires tools but none are in the allowed list, abstain
    const intent = profileIntent(task);
    if (intent.requires_tools) {
      const requiredTools = this.requiredToolsFor(selectStrategy(intent), intent);
      for (const t of requiredTools) {
        if (!policy.allowed_tools.includes(t)) {
          return { passed: false, reason: `tool ${t} not in policy allowed_tools` };
        }
      }
    }
    // Phase 1: all tools are local (VFS/sandbox), so local_only is always satisfied.
    // Remote tool veto is a Phase 3 concern.
    return { passed: true };
  }

  private policyPostRouteVeto(_task: TaskContract, _strategy: ReasoningStrategy, _intent: IntentProfile): { vetoed: boolean; reason?: string } {
    // Phase 1: all providers are local (scripted_test), so local_only is always satisfied.
    // Remote provider veto is a Phase 3 concern.
    return { vetoed: false };
  }

  private buildRunPlan(task: TaskContract, intent: IntentProfile, strategy: ReasoningStrategy): RunPlan {
    const run_id = deterministicRunId(task, this.deps.toolSnapshot.snapshot_id, this.deps.skillSnapshot.snapshot_id);
    const requiredTools = this.requiredToolsFor(strategy, intent);

    // Build workflow_graph with proper Contract field names
    const steps = intent.multi_step ? ['plan', 'execute', 'execute', 'execute', 'verify'] : [strategy];
    const workflow_nodes = steps.map((s, i) => ({
      step_id: `step-${i}`,
      step_type: s === 'verify' ? 'verification' as const : s === 'plan' || s === 'execute' ? 'model_call' as const : 'model_call' as const,
      status: 'pending' as const,
    }));
    const workflow_edges = steps.slice(1).map((_, i) => ({
      from_step: `step-${i}`,
      to_step: `step-${i + 1}`,
      condition: null,
    }));

    // AgentGraph: single agent (Phase 1)
    const agent_nodes = [{
      agent_id: 'agent-1',
      role: 'worker' as const,
      model_binding_ref: 'binding-1',
      budget_ceiling: { token_limit: '1000000', usd_micros: '5000000' },
      status: 'pending' as const,
      delegation_depth: 0,
      isolation: 'none' as const,
    }];

    // ContextGraph: single context node
    const context_nodes = [{
      node_id: 'ctx-1',
      agent_id_ref: 'agent-1',
      context_scope: 'full' as const,
    }];

    // VerificationGraph: one per success criterion
    const verification_nodes = (task.success_criteria || []).map((c, i) => ({
      verification_id: `verify-${i}`,
      step_id_ref: `step-${steps.length - 1}`,
      verification_type: c.verification_method === 'test' ? 'test_execution' as const
        : c.verification_method === 'deterministic' ? 'deterministic' as const
        : c.verification_method === 'human_review' ? 'human_review' as const
        : 'schema_validation' as const,
      strictness: 'standard' as const,
    }));

    const plan: RunPlan = {
      schema_version: 'run-plan.v1',
      run_id,
      revision: 1,
      run_plan_hash: '', // computed below
      previous_revision_hash: null,
      task,
      experience_profile: 'default',
      reasoning_strategy: strategy,
      workflow_graph: { nodes: workflow_nodes, edges: workflow_edges },
      agent_graph: { nodes: agent_nodes, edges: [] },
      context_graph: { nodes: context_nodes, edges: [] },
      verification_graph: { nodes: verification_nodes, edges: [] },
      model_bindings: [{
        provider: 'scripted_test',
        model_id: 'scripted-test',
        modality_role: 'reasoning' as const,
        capability_match_score: 1.0,
      }],
      tool_grants: requiredTools.map(name => ({ tool: name, granted: false })),
      skill_bindings: [],
      environment_bindings: [{ sandbox: true, network: false }],
      policy_snapshot_ref: this.deps.policySnapshotRef,
      registry_snapshot_refs: {
        tool_registry: this.deps.toolSnapshot.snapshot_id,
        skill_registry: this.deps.skillSnapshot.snapshot_id,
      },
      derived_risk_assessment: { risk_tier: intent.requires_writes ? 2 : 1, egress: 'none' },
      required_consent: { required: intent.requires_writes },
      budget_allocation: { max_iterations: strategy === 'direct' ? 1 : 3 },
      persistence_policy: { event_log: true, snapshot: true },
      cancellation_policy: { abortable: true },
      fallback_policy: { on_failure: 'abort' },
      context_strategy: { active_plan_injection: true },
    };

    // Compute run_plan_hash deterministically (excluding the hash itself)
    const { run_plan_hash: _omit, ...rest } = plan;
    plan.run_plan_hash = canonicalHash(rest);

    return plan;
  }
}
