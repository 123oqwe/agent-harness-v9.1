/**
 * AH-ROUTER-DAG-001: Deterministic 14-stage DAG Router pipeline.
 *
 * Runs the same policy authorities as StaticRouter but as an explicit,
 * strictly-sequential pipeline. Every stage is a named function whose inputs
 * are the explicit outputs of earlier stages — no Promise.all, no hidden
 * parallelism. The frozen Policy snapshot enters at stage 1 and remains a
 * binding veto: prefilter vetoes (tool/skill not in policy or snapshot) abort
 * before a RunPlan is shaped; post-route vetoes (provider policy) fire at
 * stage 13 Policy Validation.
 *
 * The pipeline is deterministic except for the single permitted LLM call in
 * the Task Profiler, which is an injected hook (options.taskProfiler); the
 * default profiler is the rules-only profileIntent.
 *
 * Router proposes bindings but NEVER issues capabilities, grants permissions,
 * or defines consent. derived_risk_assessment and required_consent are
 * assessments/requirements the Runtime must enforce — not policy outputs.
 */
import { createHash } from 'node:crypto';
import type {
  TaskContract,
  AgentGraph,
  ContextGraph,
  VerificationGraph,
  WorkflowGraph,
  ModelBinding,
  RunPlan,
} from '../contracts/index.js';
import { ProviderResolutionError, type ResolvedProviderDescription } from '../gateway/model-gateway.js';
import {
  StaticRouter,
  profileIntent,
  selectStrategy,
  deriveRunId,
  type IntentProfile,
  type ReasoningStrategy,
  type RoutingResult,
  type RouterDeps,
} from './static-router.js';

/** Exact stage names and order mandated by AH-ROUTER-DAG-001. */
export const PIPELINE_STAGE_NAMES = [
  'Identity/Policy',
  'Profiler',
  'Domain/Experience',
  'Context/Capability',
  'Workflow',
  'Strategy',
  'Model/Tool/Skill/Env',
  'AgentGraph',
  'ContextGraph',
  'Schedule',
  'VerificationGraph',
  'Constraint Solver',
  'Policy Validation',
  'RunPlan',
] as const;

export type PipelineStageName = (typeof PIPELINE_STAGE_NAMES)[number];

/** Execution identity bound to this run by the Identity/Policy stage. */
export interface IdentityContext {
  principal: string;
  delegation_depth: number;
  role: 'root' | 'subagent';
  authorization_scope: string;
}

export interface PipelineObserver {
  onStageComplete(stage: string, startedAt: number, endedAt: number): void;
}

export interface RouteDagOptions {
  runIdOverride?: string;
  /**
   * The single permitted LLM call in the pipeline (Task Profiler). When
   * absent the deterministic rules-only profileIntent is used.
   */
  taskProfiler?: (task: TaskContract) => IntentProfile | Promise<IntentProfile>;
  observer?: PipelineObserver;
}

export interface DagRoutingResult extends RoutingResult {
  stages_executed: readonly string[];
}

/** A typed veto raised by a pipeline stage, converted to abstain by routeDag. */
export class RouterPolicyVeto extends Error {
  constructor(
    readonly stage: string,
    readonly veto_type: string,
    message: string,
    readonly phase: 'prefilter' | 'post-route',
  ) {
    super(message);
    this.name = 'RouterPolicyVeto';
  }
}

/** A malformed input the pipeline cannot route (caller error, not abstain). */
export class RouterInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'RouterInputError';
  }
}

/** Stage 1 output: the frozen Policy anchor that gates every later stage. */
export interface PolicyAnchor {
  principal: string;
  delegation_depth: number;
  snapshot_ref: string;
  default_decision: string;
  allowed_tools: ReadonlySet<string>;
}

/** Stage 4 output: how much context / consent this task needs. */
export interface ContextCapabilityProfile {
  context_scope: 'full' | 'selective' | 'isolated';
  requires_consent: boolean;
  consent_reason: string | null;
}

/** Stage 5 output: shape of the work — drives execution_mode (stage 8). */
export interface WorkflowProfile {
  requires_workflow: boolean;
  /** 1 = no fan-out; >= 12 signals a workflow_script (dozens+ fan-out). */
  fan_out: number;
  /** Open-ended mission -> routing_slip itinerary. */
  open_ended: boolean;
}

/** Stage 7 output: bindings proposed (never granted) for this run. */
export interface ResourceBindings {
  requiredTools: string[];
  workflowTools: readonly string[];
  skill: { name: string; version: string } | undefined;
  provider: ResolvedProviderDescription;
  modelBindings: ModelBinding[];
  environment: { sandbox: boolean; network: boolean };
}

/** Stage 12 output: solved budget/iteration constraints. */
export interface SolvedConstraints {
  max_iterations: number;
  usd_micros: string | null;
}

/** Stage 13 output: the bound provider passed every post-route policy check. */
export interface PolicyValidation {
  policy_ref: string;
  passed: boolean;
  provider_violation: string | null;
}

/** Stage 10 output; only emitted when the task carries scheduling intent. */
export interface ScheduleBinding {
  deadline: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  [k: string]: unknown;
}

/** execution_mode decision, single source of truth for stages 8 and 11. */
function resolveExecutionMode(workflow: WorkflowProfile): NonNullable<AgentGraph['execution_mode']> {
  if (workflow.open_ended) return 'routing_slip';
  if (workflow.fan_out >= 12) return 'workflow_script';
  return 'static_dag';
}

/** Last workflow step a verification node references, per strategy/mode. */
function lastWorkflowStep(strategy: ReasoningStrategy, workflow: WorkflowProfile): string {
  return resolveExecutionMode(workflow) === 'workflow_script' || strategy === 'plan_execute'
    ? 'step-verify'
    : 'step-0';
}

// ---------------------------------------------------------------------------
// Stage implementations (module-level, explicit parameter dependencies).
// ---------------------------------------------------------------------------

/** Stage 1 Identity/Policy: freeze the Policy snapshot that gates the run. */
function stagePolicy(identity: IdentityContext, deps: RouterDeps): PolicyAnchor {
  const snapshot = deps.policyEngine.snapshot;
  return {
    principal: identity.principal,
    delegation_depth: identity.delegation_depth,
    snapshot_ref: deps.policySnapshotRef,
    default_decision: snapshot.default_decision,
    allowed_tools: new Set(snapshot.allowed_tools),
  };
}

/** Stage 2 Profiler: the only stage permitted an LLM call (injected hook). */
function stageProfiler(
  task: TaskContract,
  options?: RouteDagOptions,
): IntentProfile | Promise<IntentProfile> {
  if (options?.taskProfiler !== undefined) return options.taskProfiler(task);
  return profileIntent(task);
}

/** Stage 3 Domain/Experience: classify domains, pick the experience profile. */
function stageDomainExperience(intent: IntentProfile): { domains: readonly string[]; experience_profile: string } {
  return { domains: intent.domains, experience_profile: 'default' };
}

/** Stage 4 Context/Capability: binding read-only ceiling + consent requirement. */
function stageContextCapability(task: TaskContract, intent: IntentProfile): ContextCapabilityProfile {
  const readOnlyCeiling = task.constraints.some(
    (constraint) => constraint.type === 'risk_ceiling' && constraint.value === 'read_only',
  );
  if (readOnlyCeiling && intent.requires_writes) {
    throw new RouterPolicyVeto(
      'Context/Capability',
      'read_only_ceiling',
      'task requests a write but the risk ceiling is read_only',
      'prefilter',
    );
  }
  return {
    context_scope: 'full',
    requires_consent: intent.requires_writes,
    consent_reason: intent.requires_writes ? 'write_access' : null,
  };
}

/**
 * Strip prohibition clauses ("do not X", "never Y", "不要…", "禁止…") so a
 * negated instruction never shapes the route — mirrors profileIntent's
 * affirmativeGoal handling. Without this, "do not use multiple agents" would
 * trip the fan-out hint and wrongly route a single-agent task to
 * workflow_script (AH-ROUTER-EVAL-001 adversarial category).
 */
function stripProhibitions(goal: string): string {
  return goal
    .toLowerCase()
    .replace(
      /\b(?:do\s+not|don't|never|without)\b.*?(?:\.(?=\s+\p{L})|[。;；]|$)/giu,
      '',
    )
    .replace(
      /(?:不要|禁止).*?(?:\.(?=\s+\p{L})|[。;；]|$)/giu,
      '',
    )
    .replace(/^\s*[;；,，]\s*/u, '')
    .replace(/[;；,，]\s*(?=[.。]?\s*$)/u, '');
}

/** Stage 5 Workflow: detect open-ended missions and dozens+ fan-out. */
function stageWorkflow(task: TaskContract, intent: IntentProfile): WorkflowProfile {
  const goal = stripProhibitions(task.goal);
  const openEnded =
    /\b(explore|discover|iterate|experiment|research|brainstorm|open[- ]ended)\b|探索|调研|研究|迭代|发散|头脑风暴/u.test(goal);
  const fanOutHint =
    /\b(fan[- ]out|parallel|concurrent(?:ly)?|multi[- ]agent|multiple agents|dozens|all\s+\d+)\b|并行|并发|多智能体|多代理|多个代理/u.test(goal);
  const largeScope = task.success_criteria.length >= 12;
  const fan_out = fanOutHint || largeScope ? Math.max(12, task.success_criteria.length) : 1;
  return {
    requires_workflow: intent.explicit_plan || intent.multi_step,
    fan_out,
    open_ended: openEnded,
  };
}

/** Stage 6 Strategy: deterministic reasoning-strategy selection. */
function stageStrategy(intent: IntentProfile): ReasoningStrategy {
  return selectStrategy(intent);
}

/** Stage 7 Model/Tool/Skill/Env: propose bindings under the frozen Policy. */
function stageResources(
  task: TaskContract,
  intent: IntentProfile,
  strategy: ReasoningStrategy,
  deps: RouterDeps,
): ResourceBindings {
  const router = new StaticRouter(deps);

  const skillName = router.skillFor(intent);
  const selectedSkill = skillName
    ? deps.skillRegistry.skill_search(skillName).find((candidate) => candidate.name === skillName)
    : undefined;
  if (skillName && (!selectedSkill || !deps.skillRegistry.inSnapshot(skillName, deps.skillSnapshot))) {
    throw new RouterPolicyVeto(
      'Model/Tool/Skill/Env',
      'skill_not_in_snapshot',
      `required skill not in frozen snapshot: ${skillName}`,
      'prefilter',
    );
  }
  const fullSkill = selectedSkill
    ? deps.skillRegistry.loadFull(selectedSkill.name, deps.skillSnapshot)
    : undefined;

  const workflowTools = router.workflowTools(task, intent, strategy);
  const proposedTools =
    strategy === 'direct'
      ? []
      : [
          ...new Set([
            ...(fullSkill?.required_tools as string[] | undefined ?? []),
            ...workflowTools,
          ]),
        ];

  const requiredTools: string[] = [];
  for (const name of proposedTools) {
    if (!deps.policyEngine.snapshot.allowed_tools.includes(name)) {
      throw new RouterPolicyVeto(
        'Model/Tool/Skill/Env',
        'tool_not_in_policy',
        `policy prefilter: tool ${name} not in policy allowed_tools`,
        'prefilter',
      );
    }
    const compact = deps.toolRegistry
      .search(name, { availableOnly: true })
      .find((candidate) => candidate.name === name);
    if (!compact || !deps.toolRegistry.inSnapshot(name, deps.toolSnapshot)) {
      throw new RouterPolicyVeto(
        'Model/Tool/Skill/Env',
        'tool_not_in_snapshot',
        `required tool not in frozen snapshot: ${name}`,
        'prefilter',
      );
    }
    requiredTools.push(name);
  }

  let provider: ResolvedProviderDescription;
  try {
    const selection = router.providerSelection(task, strategy, requiredTools);
    provider = deps.gateway.describeResolved(deps.gateway.resolve(selection));
  } catch (error) {
    const reason = error instanceof ProviderResolutionError ? error.code : 'provider_resolution_failed';
    throw new RouterPolicyVeto(
      'Model/Tool/Skill/Env',
      'provider_resolution',
      `provider policy veto: ${reason}`,
      'post-route',
    );
  }

  return {
    requiredTools,
    workflowTools,
    skill: fullSkill ? { name: fullSkill.name, version: fullSkill.version } : undefined,
    provider,
    modelBindings: [
      {
        provider: provider.provider_id,
        model_id: provider.provider_id,
        modality_role: 'reasoning',
        capability_match_score: 1.0,
      },
    ],
    environment: { sandbox: true, network: provider.execution === 'remote' },
  };
}

/** Stage 8 AgentGraph: choose execution_mode and lay out the agent topology. */
function stageAgentGraph(workflow: WorkflowProfile): AgentGraph {
  const executionMode = resolveExecutionMode(workflow);
  const agentCount = executionMode === 'workflow_script' ? Math.min(workflow.fan_out, 16) : 1;
  const nodes: AgentGraph['nodes'] = Array.from({ length: agentCount }, (_, i) => ({
    agent_id: `agent-${i + 1}`,
    role: 'worker',
    model_binding_ref: 'binding-1',
    budget_ceiling: { token_limit: '1000000', usd_micros: '5000000' },
    status: 'pending',
    delegation_depth: 0,
    isolation: 'none',
  }));
  return {
    execution_mode: executionMode,
    ...(executionMode === 'routing_slip'
      ? { routing_slip: { itinerary: [], executed: [], compensations: [], inserted_steps: 0, insert_limit: 5 } }
      : {}),
    nodes,
    edges: [],
  };
}

/** Stage 9 ContextGraph: one context node per agent, shared context scope. */
function stageContextGraph(agentGraph: AgentGraph, capability: ContextCapabilityProfile): ContextGraph {
  const nodes: ContextGraph['nodes'] = agentGraph.nodes.map((node, i) => ({
    node_id: `ctx-${i + 1}`,
    agent_id_ref: node.agent_id,
    context_scope: capability.context_scope,
  }));
  return { nodes, edges: [] };
}

/** Stage 10 Schedule: emit a schedule_binding only when the task asks for one. */
function stageSchedule(task: TaskContract): ScheduleBinding | null {
  if (task.deadline == null && task.priority == null) return null;
  return { deadline: task.deadline ?? null, priority: task.priority ?? 'normal' };
}

/** Stage 11 VerificationGraph: one verification node per success criterion. */
function stageVerificationGraph(
  task: TaskContract,
  strategy: ReasoningStrategy,
  workflow: WorkflowProfile,
): VerificationGraph {
  const lastStep = lastWorkflowStep(strategy, workflow);
  const nodes: VerificationGraph['nodes'] = task.success_criteria.map((criterion, i) => ({
    verification_id: `verify-${i}`,
    step_id_ref: lastStep,
    verification_type:
      criterion.verification_method === 'test'
        ? 'test_execution'
        : criterion.verification_method === 'deterministic'
          ? 'deterministic'
          : criterion.verification_method === 'human_review'
            ? 'human_review'
            : 'independent_verifier',
    strictness: 'standard',
    acceptance_criteria_refs: [String(i)],
  }));
  return { nodes, edges: [] };
}

/** Stage 12 Constraint Solver: budget ceiling and iteration bound. */
function stageConstraints(
  task: TaskContract,
  strategy: ReasoningStrategy,
  resources: ResourceBindings,
): SolvedConstraints {
  const budgetConstraint = task.constraints.find((constraint) => constraint.type === 'budget');
  return {
    max_iterations:
      strategy === 'direct'
        ? 1
        : strategy === 'plan_execute'
          ? (resources.workflowTools.length + 1) * 2
          : Math.min(50, Math.max(4, resources.requiredTools.length + 2)),
    usd_micros: budgetConstraint?.value ?? null,
  };
}

/** Stage 13 Policy Validation: post-route veto on the provider actually bound. */
function stagePolicyValidation(
  task: TaskContract,
  provider: ResolvedProviderDescription,
  policy: PolicyAnchor,
  deps: RouterDeps,
): PolicyValidation {
  const router = new StaticRouter(deps);
  const violation = router.policyPostRouteViolation(task, provider);
  if (violation !== undefined) {
    throw new RouterPolicyVeto(
      'Policy Validation',
      'post_route_provider',
      `policy post-route veto: ${violation}`,
      'post-route',
    );
  }
  return { policy_ref: policy.snapshot_ref, passed: true, provider_violation: null };
}

/** Stage 14 RunPlan: assemble the only normative execution contract. */
function stageRunPlan(
  task: TaskContract,
  intent: IntentProfile,
  strategy: ReasoningStrategy,
  experienceProfile: string,
  capability: ContextCapabilityProfile,
  resources: ResourceBindings,
  agentGraph: AgentGraph,
  contextGraph: ContextGraph,
  schedule: ScheduleBinding | null,
  verificationGraph: VerificationGraph,
  constraints: SolvedConstraints,
  policy: PolicyAnchor,
  deps: RouterDeps,
  runIdOverride?: string,
): RunPlan {
  const run_id =
    runIdOverride ??
    deriveRunId(
      task,
      deps.toolSnapshot.snapshot_id,
      deps.skillSnapshot.snapshot_id,
      deps.gateway.registrySnapshotHash,
    );
  const executionMode = agentGraph.execution_mode ?? 'static_dag';
  const workflowGraph = buildWorkflowGraph(strategy, resources.workflowTools, executionMode, agentGraph.nodes.length);

  const planWithoutHash: Omit<RunPlan, 'run_plan_hash'> = {
    schema_version: 'run-plan.v1',
    run_id,
    revision: 1,
    previous_revision_hash: null,
    task,
    experience_profile: experienceProfile,
    reasoning_strategy: strategy,
    workflow_graph: workflowGraph,
    agent_graph: agentGraph,
    context_graph: contextGraph,
    verification_graph: verificationGraph,
    model_bindings: resources.modelBindings,
    tool_grants: resources.requiredTools.map((name) => ({ tool: name, granted: false })),
    skill_bindings: resources.skill ? [{ skill_name: resources.skill.name, version: resources.skill.version }] : [],
    environment_bindings: [resources.environment],
    ...(schedule !== null ? { schedule_binding: schedule } : {}),
    policy_snapshot_ref: policy.snapshot_ref,
    registry_snapshot_refs: {
      tool_registry: deps.toolSnapshot.snapshot_id,
      skill_registry: deps.skillSnapshot.snapshot_id,
      provider_registry: deps.gateway.registrySnapshotHash,
    },
    derived_risk_assessment: { risk_tier: intent.requires_writes ? 2 : 1, egress: 'none' },
    required_consent: { required: capability.requires_consent },
    budget_allocation: {
      max_iterations: constraints.max_iterations,
      ...(constraints.usd_micros !== null ? { usd_micros: constraints.usd_micros } : {}),
    },
    persistence_policy: { event_log: true, snapshot: true },
    cancellation_policy: { abortable: true, auto_execute: true },
    fallback_policy: { on_failure: 'abort' },
    context_strategy: { active_plan_injection: true },
  };

  return {
    ...planWithoutHash,
    run_plan_hash: canonicalHash(planWithoutHash),
  };
}

/**
 * WorkflowGraph layout. workflow_script (dozens+ fan-out) becomes an explicit
 * parallel_fork -> N agent steps -> parallel_join -> synthesize -> verify
 * script; everything else uses the base chain (plan_execute proposal/tool
 * pairs + synthesize + verify, otherwise a single step-0).
 */
function buildWorkflowGraph(
  strategy: ReasoningStrategy,
  workflowTools: readonly string[],
  executionMode: NonNullable<AgentGraph['execution_mode']>,
  agentCount: number,
): WorkflowGraph {
  if (executionMode === 'workflow_script' && agentCount > 1) {
    const fork: WorkflowGraph['nodes'][number] = { step_id: 'step-fork', step_type: 'parallel_fork', status: 'pending' };
    const agentSteps: WorkflowGraph['nodes'][number][] = Array.from({ length: agentCount }, (_, i) => ({
      step_id: `step-agent-${i + 1}`,
      step_type: 'model_call',
      status: 'pending',
      agent_id_ref: `agent-${i + 1}`,
    }));
    const join: WorkflowGraph['nodes'][number] = { step_id: 'step-join', step_type: 'parallel_join', status: 'pending' };
    const synthesize: WorkflowGraph['nodes'][number] = { step_id: 'step-synthesize', step_type: 'model_call', status: 'pending' };
    const verify: WorkflowGraph['nodes'][number] = { step_id: 'step-verify', step_type: 'verification', status: 'pending' };
    const nodes = [fork, ...agentSteps, join, synthesize, verify];
    const edges: WorkflowGraph['edges'] = [
      ...agentSteps.map((step) => ({ from_step: fork.step_id, to_step: step.step_id, condition: null })),
      ...agentSteps.map((step) => ({ from_step: step.step_id, to_step: join.step_id, condition: null })),
      { from_step: join.step_id, to_step: synthesize.step_id, condition: null },
      { from_step: synthesize.step_id, to_step: verify.step_id, condition: null },
    ];
    return { nodes, edges };
  }

  const nodes: WorkflowGraph['nodes'] =
    strategy === 'plan_execute'
      ? [
          ...workflowTools.flatMap(
            (tool, index): [WorkflowGraph['nodes'][number], WorkflowGraph['nodes'][number]] => [
              { step_id: `step-propose-${index}`, step_type: 'model_call', status: 'pending' },
              { step_id: `step-tool-${index}`, step_type: 'tool_call', status: 'pending', tool_name: tool },
            ],
          ),
          { step_id: 'step-synthesize', step_type: 'model_call', status: 'pending' },
          { step_id: 'step-verify', step_type: 'verification', status: 'pending' },
        ]
      : [{ step_id: 'step-0', step_type: 'model_call', status: 'pending' }];
  const edges: WorkflowGraph['edges'] = nodes.slice(1).map((node, index) => ({
    from_step: nodes[index]!.step_id,
    to_step: node.step_id,
    condition: null,
  }));
  return { nodes, edges };
}

/** Recursive canonical JSON for stable hashing (mirrors static-router). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
function canonicalHash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(obj))).digest('hex');
}

/**
 * Route a task through the 14-stage DAG pipeline.
 *
 * Stages run strictly sequentially (awaited one at a time); any two-stage
 * overlap would be a spec violation and is observable via PipelineObserver.
 * The frozen Policy (stage 1) gates every later stage; a RouterPolicyVeto is
 * converted into an abstain result carrying the failing stage.
 */
export async function routeDag(
  task: TaskContract,
  identity: IdentityContext,
  deps: RouterDeps,
  options?: RouteDagOptions,
): Promise<DagRoutingResult> {
  if (!identity || typeof identity.principal !== 'string' || identity.principal.length === 0) {
    throw new RouterInputError('principal', 'IdentityContext.principal is required');
  }

  const executedStages: string[] = [];
  const observed = async <T>(stage: string, fn: () => T | Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      const out = await fn();
      executedStages.push(stage);
      options?.observer?.onStageComplete(stage, startedAt, Date.now());
      return out;
    } catch (error) {
      executedStages.push(stage);
      options?.observer?.onStageComplete(stage, startedAt, Date.now());
      throw error;
    }
  };

  let intent: IntentProfile | undefined;
  try {
    const policy = await observed('Identity/Policy', () => stagePolicy(identity, deps));
    intent = await observed('Profiler', () => stageProfiler(task, options));
    // const copy: keeps narrowing intact across the await/if control flow.
    const profiled = intent;
    if (profiled.missing_info.includes('success_criteria_empty')) {
      return {
        outcome: 'ask_user',
        intent: profiled,
        policy_prefilter_passed: true,
        policy_post_route_vetoed: false,
        ask_user_message: 'Task success criteria are empty. Please describe what a successful outcome looks like.',
        stages_executed: [...executedStages],
      };
    }

    const domainExp = await observed('Domain/Experience', () => stageDomainExperience(profiled));
    const capability = await observed('Context/Capability', () => stageContextCapability(task, profiled));
    const workflow = await observed('Workflow', () => stageWorkflow(task, profiled));
    const strategy = await observed('Strategy', () => stageStrategy(profiled));
    const resources = await observed('Model/Tool/Skill/Env', () => stageResources(task, profiled, strategy, deps));
    const agentGraph = await observed('AgentGraph', () => stageAgentGraph(workflow));
    const contextGraph = await observed('ContextGraph', () => stageContextGraph(agentGraph, capability));
    const schedule = await observed('Schedule', () => stageSchedule(task));
    const verificationGraph = await observed('VerificationGraph', () => stageVerificationGraph(task, strategy, workflow));
    const constraints = await observed('Constraint Solver', () => stageConstraints(task, strategy, resources));
    await observed('Policy Validation', () => stagePolicyValidation(task, resources.provider, policy, deps));
    const runPlan = await observed('RunPlan', () =>
      stageRunPlan(
        task,
        profiled,
        strategy,
        domainExp.experience_profile,
        capability,
        resources,
        agentGraph,
        contextGraph,
        schedule,
        verificationGraph,
        constraints,
        policy,
        deps,
        options?.runIdOverride,
      ),
    );

    return {
      outcome: 'route',
      strategy,
      intent: profiled,
      run_plan: runPlan,
      policy_prefilter_passed: true,
      policy_post_route_vetoed: false,
      stages_executed: [...executedStages],
    };
  } catch (error) {
    if (error instanceof RouterPolicyVeto) {
      return {
        outcome: 'abstain',
        intent: intent ?? profileIntent(task),
        policy_prefilter_passed: error.phase === 'prefilter' ? false : true,
        policy_post_route_vetoed: error.phase === 'post-route',
        abstain_reason: `${error.stage}: ${error.message}`,
        stages_executed: [...executedStages],
      };
    }
    throw error;
  }
}
