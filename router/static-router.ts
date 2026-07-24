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
import {
  ProviderResolutionError,
  type ModelGateway,
  type ProviderSelectionRequest,
  type ResolvedProvider,
  type ResolvedProviderDescription,
} from '../gateway/model-gateway.js';

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
  gateway: ModelGateway;
}

/** Deterministic intent profiler. No LLM in Phase 1 — rules only. */
export function profileIntent(task: TaskContract): IntentProfile {
  const goal = task.goal.toLowerCase();
  const pureWriting = /\b(rewrite|polish|draft|essay|article|copyedit)\b|润色|改写|优化文案|写作|文章|草稿/u.test(goal);
  const codeOrFileTarget = /\b(code|bug|function|repo|repository|typescript|javascript|python|file|module|config)\b|代码|缺陷|文件|函数|仓库|模块|配置/u.test(goal);
  const mutationVerb = /\b(edit|create|modify|update|fix|implement|refactor|delete|remove|patch)\b|修复|修改|编辑|创建|更新|实现|重构|删除|移除|打补丁/u.test(goal);
  const explicitFileWrite = /\b(?:write|create)\s+(?:(?:a|the)\s+)?(?:file|code|function|module)\b|写入(?:文件|代码)|新建(?:文件|模块)/u.test(goal);
  const requires_writes = explicitFileWrite || mutationVerb && (codeOrFileTarget || !pureWriting);
  const requires_tests = /\b(test|verify|run|build|compile|lint|check)\b|测试|验证|运行|构建|编译|检查/u.test(goal);
  const explicit_plan = /\b(plan|step by step|multi.?step|pipeline|workflow|sequence)\b|计划|分步骤|多步骤|流程|工作流|依赖/u.test(goal);
  const observationTools = /\b(read|list|search|find|explore|execute|run|parse|summarize|analyze)\b|读取|列出|搜索|查找|浏览|执行|解析|总结|分析/u.test(goal);
  const requires_tools = requires_writes || requires_tests || observationTools;
  const stepMarkers = (goal.match(/\bthen\b|\bafter\b|\bnext\b|\bfinally\b|\b->\b|;\s|然后|之后|接着|再|最后/gu) || []).length;
  const multi_step = explicit_plan || stepMarkers >= 1 || (requires_writes && requires_tests);
  const missing_info: string[] = [];
  if (!task.success_criteria || task.success_criteria.length === 0) missing_info.push('success_criteria_empty');
  const ambiguity: 'none' | 'low' | 'high' = missing_info.length > 0 ? 'high' : (goal.length < 15 ? 'low' : 'none');
  const domains: string[] = [];
  if (/\b(code|bug|function|repo|typescript|javascript|python|build)\b|代码|缺陷|函数|仓库|构建|编译/u.test(goal)) domains.push('coding');
  if (/\b(document|pdf|page|file|summary|summarize|summarise)\b|文档|文件|页面|总结|摘要/u.test(goal)) domains.push('documents');
  if (/\b(research|cite|source|reference)\b|研究|引用|来源|参考/u.test(goal)) domains.push('research');
  if (pureWriting) domains.push('writing');
  if (/\b(plan|schedule|dependency|dag|task)\b|计划|排期|依赖|任务/u.test(goal)) domains.push('planning');
  if (domains.length === 0) domains.push('general');
  return { goal: task.goal, domains, requires_tools, requires_writes, requires_tests, multi_step, explicit_plan, ambiguity, missing_info, success_criteria_count: task.success_criteria?.length ?? 0 };
}

export function selectStrategy(intent: IntentProfile): ReasoningStrategy {
  if (intent.explicit_plan || (intent.requires_writes && intent.requires_tests) || intent.multi_step) return 'plan_execute';
  if (intent.requires_tools) return 'react';
  return 'direct';
}

/** Deterministic run_id: UUID v5-style (deterministic from task + snapshots, no Date.now()). */
function deterministicRunId(task: TaskContract, toolSnapId: string, skillSnapId: string, providerSnapId: string): string {
  const hash = createHash('sha256').update(JSON.stringify(task) + toolSnapId + skillSnapId + providerSnapId).digest('hex');
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

  route(task: TaskContract, runIdOverride?: string): RoutingResult {
    // 1. Intent profiling is deterministic and does not invoke a model.
    const intent = profileIntent(task);

    // 2. Missing required info -> ask_user
    if (intent.ambiguity === 'high' && intent.missing_info.includes('success_criteria_empty')) {
      return { outcome: 'ask_user', intent, policy_prefilter_passed: true, policy_post_route_vetoed: false, ask_user_message: 'Task success criteria are empty. Please describe what a successful outcome looks like.' };
    }

    // 3. Strategy selection
    const strategy = selectStrategy(intent);

    // 4. Search compact skill metadata, then load only the selected frozen skill.
    const skillName = this.skillFor(intent);
    const selectedSkill = skillName
      ? this.deps.skillRegistry
          .skill_search(skillName)
          .find((candidate) => candidate.name === skillName)
      : undefined;
    if (skillName && (!selectedSkill || !this.deps.skillRegistry.inSnapshot(skillName, this.deps.skillSnapshot))) {
      return { outcome: 'abstain', intent, policy_prefilter_passed: false, policy_post_route_vetoed: false, abstain_reason: `required skill not in frozen snapshot: ${skillName}` };
    }
    const fullSkill = selectedSkill
      ? this.deps.skillRegistry.loadFull(selectedSkill.name, this.deps.skillSnapshot)
      : undefined;

    // 5. Search compact tool metadata; selected tools must match snapshot and Policy.
    const proposedTools = this.proposedTools(strategy, intent, fullSkill?.required_tools as string[] | undefined);
    const requiredTools: string[] = [];
    for (const name of proposedTools) {
      if (!this.deps.policyEngine.snapshot.allowed_tools.includes(name)) {
        return { outcome: 'abstain', intent, policy_prefilter_passed: false, policy_post_route_vetoed: false, abstain_reason: `policy prefilter: tool ${name} not in policy allowed_tools` };
      }
      const compact = this.deps.toolRegistry
        .search(name, { availableOnly: true })
        .find((candidate) => candidate.name === name);
      if (!compact || !this.deps.toolRegistry.inSnapshot(name, this.deps.toolSnapshot)) {
        return { outcome: 'abstain', intent, policy_prefilter_passed: false, policy_post_route_vetoed: false, abstain_reason: `required tool not in frozen snapshot: ${name}` };
      }
      requiredTools.push(name);
    }
    const prefilter = this.policyPrefilter(requiredTools);
    if (!prefilter.passed) {
      return { outcome: 'abstain', intent, policy_prefilter_passed: false, policy_post_route_vetoed: false, abstain_reason: `policy prefilter: ${prefilter.reason}` };
    }

    // 6. Resolve the actual provider from the frozen Gateway snapshot.
    let resolved: ResolvedProvider;
    let provider: ResolvedProviderDescription;
    try {
      const selection = this.providerSelection(task, strategy, requiredTools);
      resolved = this.deps.gateway.resolve(selection);
      provider = this.deps.gateway.describeResolved(resolved);
    } catch (error) {
      const reason = error instanceof ProviderResolutionError ? error.code : 'provider_resolution_failed';
      return { outcome: 'abstain', intent, policy_prefilter_passed: true, policy_post_route_vetoed: true, abstain_reason: `provider policy veto: ${reason}` };
    }

    // 7. Build the RunPlan (deterministic, no Date.now())
    const runPlan = this.buildRunPlan(
      task,
      intent,
      strategy,
      requiredTools,
      fullSkill ? { name: fullSkill.name, version: fullSkill.version } : undefined,
      provider,
      runIdOverride,
    );

    // 8. Policy post-route veto.
    const vetoed = this.policyPostRouteVeto(task, strategy, intent);
    if (vetoed.vetoed) {
      return { outcome: 'abstain', intent, policy_prefilter_passed: true, policy_post_route_vetoed: true, abstain_reason: `policy post-route veto: ${vetoed.reason}` };
    }

    return { outcome: 'route', strategy, intent, run_plan: runPlan, policy_prefilter_passed: true, policy_post_route_vetoed: false };
  }

  private proposedTools(strategy: ReasoningStrategy, intent: IntentProfile, skillTools?: string[]): string[] {
    if (strategy === 'direct') return [];
    if (skillTools && skillTools.length > 0) return [...new Set(skillTools)];
    const tools: string[] = ['read_file'];
    if (intent.requires_writes) tools.push('write_file', 'edit_file');
    if (intent.requires_tests) tools.push('execute_command');
    return [...new Set(tools)];
  }

  private policyPrefilter(requiredTools: readonly string[]): { passed: boolean; reason?: string } {
    const policy = this.deps.policyEngine.snapshot;
    for (const tool of requiredTools) {
      if (!policy.allowed_tools.includes(tool)) {
        return { passed: false, reason: `tool ${tool} not in policy allowed_tools` };
      }
    }
    return { passed: true };
  }

  private policyPostRouteVeto(_task: TaskContract, _strategy: ReasoningStrategy, _intent: IntentProfile): { vetoed: boolean; reason?: string } {
    // Phase 1: all providers are local (scripted_test), so local_only is always satisfied.
    // Remote provider veto is a Phase 3 concern.
    return { vetoed: false };
  }

  private skillFor(intent: IntentProfile): string | undefined {
    const goal = intent.goal.toLowerCase();
    if (intent.domains.includes('coding') && /\b(bug|fix|patch)\b|缺陷|修复|漏洞/u.test(goal)) return 'bug-fix';
    if (intent.requires_writes) return 'feature-implementation';
    if (intent.requires_tests) return 'test-and-verify';
    if (
      intent.domains.includes('documents') &&
      /\b(document|pdf|summary|summarize|summarise)\b|文档|总结|摘要/u.test(goal)
    ) return 'document-summary';
    if (intent.domains.includes('research')) return 'research-with-citations';
    if (intent.domains.includes('writing')) return 'writing-refinement';
    if (intent.domains.includes('planning')) return 'dependency-aware-planning';
    if (intent.requires_tools) return 'repository-exploration';
    return undefined;
  }

  private providerSelection(
    task: TaskContract,
    strategy: ReasoningStrategy,
    requiredTools: readonly string[],
  ): ProviderSelectionRequest {
    const localOnly = task.constraints.some(
      (constraint) => constraint.type === 'privacy' && constraint.value === 'local_only',
    );
    const allowedProviderIds = task.constraints
      .filter((constraint) => constraint.type === 'model_restriction')
      .map((constraint) => constraint.value);
    const capabilities =
      strategy === 'direct' ? ['text_reasoning'] : ['text_reasoning', 'tool_calling'];
    return {
      registry_snapshot_hash: this.deps.gateway.registrySnapshotHash,
      request: {
        messages: [{ role: 'user', content: task.goal }],
        tools: requiredTools.map((name) =>
          this.deps.toolRegistry.loadProviderTool(name, this.deps.toolSnapshot),
        ),
      },
      estimated_input_tokens: Math.max(1, Math.ceil(task.goal.length / 4)),
      required_capabilities: capabilities,
      requires_structured_output: strategy === 'plan_execute',
      data_policy: {
        local_only: localOnly,
        allowed_regions: localOnly ? ['local'] : ['local', 'cn', 'us', 'eu'],
        max_retention_days: localOnly ? 0 : 365,
        training_allowed: false,
      },
      policy: {
        allowed_provider_ids: allowedProviderIds.length > 0 ? allowedProviderIds : undefined,
        denied_provider_ids: [],
      },
      run_plan: {
        allowed_provider_ids: allowedProviderIds.length > 0 ? allowedProviderIds : undefined,
        required_capabilities: capabilities,
      },
    };
  }

  private buildRunPlan(
    task: TaskContract,
    intent: IntentProfile,
    strategy: ReasoningStrategy,
    requiredTools: string[],
    skill: { name: string; version: string } | undefined,
    provider: ResolvedProviderDescription,
    runIdOverride?: string,
  ): RunPlan {
    const run_id =
      runIdOverride ??
      deterministicRunId(
        task,
        this.deps.toolSnapshot.snapshot_id,
        this.deps.skillSnapshot.snapshot_id,
        this.deps.gateway.registrySnapshotHash,
      );

    // The plan_execute graph separates model proposals from tool execution.
    // A tool call can therefore be consumed exactly once by its bound node.
    const workflow_nodes: RunPlan['workflow_graph']['nodes'] =
      strategy === 'plan_execute'
        ? [
            {
              step_id: 'step-plan',
              step_type: 'model_call',
              status: 'pending',
            },
            ...requiredTools.flatMap((tool, index) => [
              {
                step_id: `step-propose-${index}`,
                step_type: 'model_call' as const,
                status: 'pending' as const,
              },
              {
                step_id: `step-tool-${index}`,
                step_type: 'tool_call' as const,
                status: 'pending' as const,
                tool_name: tool,
              },
            ]),
            {
              step_id: 'step-synthesize',
              step_type: 'model_call',
              status: 'pending',
            },
            {
              step_id: 'step-verify',
              step_type: 'verification',
              status: 'pending',
            },
          ]
        : [
            {
              step_id: 'step-0',
              step_type: 'model_call',
              status: 'pending',
            },
          ];
    const workflow_edges = workflow_nodes.slice(1).map((node, index) => ({
      from_step: workflow_nodes[index]!.step_id,
      to_step: node.step_id,
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
      step_id_ref: workflow_nodes[workflow_nodes.length - 1]!.step_id,
      verification_type: c.verification_method === 'test' ? 'test_execution' as const
        : c.verification_method === 'deterministic' ? 'deterministic' as const
        : c.verification_method === 'human_review' ? 'human_review' as const
        : 'independent_verifier' as const,
      strictness: 'standard' as const,
      acceptance_criteria_refs: [String(i)],
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
        provider: provider.provider_id,
        model_id: provider.provider_id,
        modality_role: 'reasoning' as const,
        capability_match_score: 1.0,
      }],
      tool_grants: requiredTools.map(name => ({ tool: name, granted: false })),
      skill_bindings: skill ? [{ skill_name: skill.name, version: skill.version }] : [],
      environment_bindings: [{ sandbox: true, network: provider.execution === 'remote' }],
      policy_snapshot_ref: this.deps.policySnapshotRef,
      registry_snapshot_refs: {
        tool_registry: this.deps.toolSnapshot.snapshot_id,
        skill_registry: this.deps.skillSnapshot.snapshot_id,
        provider_registry: this.deps.gateway.registrySnapshotHash,
      },
      derived_risk_assessment: { risk_tier: intent.requires_writes ? 2 : 1, egress: 'none' },
      required_consent: { required: intent.requires_writes },
      budget_allocation: {
        max_iterations:
          strategy === 'direct'
            ? 1
            : strategy === 'plan_execute'
              ? Math.max(3, requiredTools.length + 2)
              : 3,
      },
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
