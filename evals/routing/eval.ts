/**
 * AH-ROUTER-EVAL-001: routing evaluation over the committed dataset.
 *
 * Drives the deterministic Router DAG (routeDag in router/pipeline.ts) through
 * every task in evals/routing/dataset.json and scores it against the frozen
 * exit criteria of spec/phases/phase-3.yaml:
 *
 *   hard_constraint_violation: 0
 *   routing_regret:            <= 15%
 *   unnecessary_multi_agent_rate: <= 20%
 *   forbidden route selected:  never
 *
 * Route signature is the pair (execution_mode, agent count bucket), e.g.
 * "workflow_script/multi". Hard constraints are string tokens interpreted by
 * the checker map below (dataset.hard_constraint_tokens documents them).
 */
import { readFileSync } from 'node:fs';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import type { TaskContract, ToolSpec } from '../../contracts/index.js';
import { routeDag, type IdentityContext } from '../../router/pipeline.js';
import type { RouterDeps } from '../../router/static-router.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';
import { createScriptedGateway } from '../../tests/helpers/test-security.js';

const PHASE1_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'execute_command',
  'list_directory',
  'search_files',
  'parse_document',
];

function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}

function setupDeps(): RouterDeps {
  const tr = new ToolRegistry();
  PHASE1_TOOLS.forEach((name) => tr.register(toolSpec(name)));
  const sr = new SkillRegistry();
  sr.loadBaseSkills();
  const tsnap = tr.freezeSnapshot();
  const ssnap = sr.freezeSnapshot();
  const pe = new PolicyEngine({
    version: 'policy-v1',
    default_decision: 'deny',
    allowed_tools: PHASE1_TOOLS,
    allowed_resource_prefixes: ['workspace://'],
    rules: [],
  } as Policy);
  const gateway = createScriptedGateway([{ content: 'unused' }]).gateway;
  return {
    toolRegistry: tr,
    skillRegistry: sr,
    toolSnapshot: tsnap,
    skillSnapshot: ssnap,
    policyEngine: pe,
    policySnapshotRef: 'policy-v1',
    gateway,
  };
}

const DEFAULT_IDENTITY: IdentityContext = {
  principal: 'eval-user',
  delegation_depth: 0,
  role: 'root',
  authorization_scope: 'routing-eval',
};

export interface RoutingDatasetTask {
  id: string;
  category: string;
  goal: string;
  success_criteria: TaskContract['success_criteria'];
  constraints: TaskContract['constraints'];
  allowed_routes: string[];
  forbidden_routes: string[];
  hard_constraints: string[];
  preferred_order: string[];
  single_agent_sufficient: boolean;
}

export interface RoutingDataset {
  schema: string;
  task_count: number;
  tasks: RoutingDatasetTask[];
}

export interface RoutingEvaluationTaskResult {
  id: string;
  category: string;
  outcome: string;
  emitted_route: string | null;
  hard_constraint_violations: string[];
  forbidden_route_violations: string[];
  regretful: boolean;
  unnecessary_multi_agent: boolean;
}

export interface RoutingEvaluationMetrics {
  total: number;
  routed: number;
  hard_constraint_violations: number;
  forbidden_route_selections: number;
  regretful: number;
  unnecessary_multi_agent: number;
  routing_regret_rate: number;
  unnecessary_multi_agent_rate: number;
  pass: boolean;
}

export interface RoutingEvaluationResult {
  metrics: RoutingEvaluationMetrics;
  task_results: RoutingEvaluationTaskResult[];
  errors: string[];
  releaseReady: boolean;
}

function readDataset(repositoryRoot?: string): RoutingDataset {
  const source =
    repositoryRoot !== undefined
      ? `${repositoryRoot}/evals/routing/dataset.json`
      : new URL('./dataset.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(source, 'utf8')) as RoutingDataset;
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 200) {
    throw new Error(`routing dataset missing or undersized: ${parsed.task_count}`);
  }
  return parsed;
}

function routeSignature(outcome: 'route', mode: string, agentCount: number): string {
  return `${mode}/${agentCount > 1 ? 'multi' : 'single'}`;
}

/** Interpret a hard-constraint token against the emitted route. */
function checkHardConstraint(
  token: string,
  mode: string,
  agentCount: number,
  usdMicros: string | number | null,
): string | null {
  switch (token) {
    case 'single_agent':
      return agentCount === 1 ? null : `expected single agent, got ${agentCount}`;
    case 'multi_agent':
      return agentCount > 1 ? null : `expected multi-agent, got ${agentCount}`;
    case 'execution_static_dag':
      return mode === 'static_dag' ? null : `expected static_dag, got ${mode}`;
    case 'execution_routing_slip':
      return mode === 'routing_slip' ? null : `expected routing_slip, got ${mode}`;
    case 'execution_workflow_script':
      return mode === 'workflow_script' ? null : `expected workflow_script, got ${mode}`;
    case 'no_routing_slip':
      return mode !== 'routing_slip' ? null : `routing_slip forbidden, got it`;
    case 'no_workflow_script':
      return mode !== 'workflow_script' ? null : `workflow_script forbidden, got it`;
    case 'budget_usd_micros_le_1000000': {
      const value = typeof usdMicros === 'string' ? Number.parseInt(usdMicros, 10) : usdMicros;
      if (value === null || Number.isNaN(value)) return `budget not resolved (${String(usdMicros)})`;
      return value <= 1_000_000 ? null : `budget ${value} exceeds cap 1000000`;
    }
    default:
      return `unknown hard-constraint token: ${token}`;
  }
}

export async function runRoutingEvaluations(
  options: { repositoryRoot?: string } = {},
): Promise<RoutingEvaluationResult> {
  const dataset = readDataset(options.repositoryRoot);
  const deps = setupDeps();
  const errors: string[] = [];
  const taskResults: RoutingEvaluationTaskResult[] = [];
  const identity = DEFAULT_IDENTITY;

  for (const entry of dataset.tasks) {
    const task: TaskContract = {
      goal: entry.goal,
      success_criteria: entry.success_criteria,
      constraints: entry.constraints,
    };
    const failureResult = (outcome: string) => ({
      id: entry.id,
      category: entry.category,
      outcome,
      emitted_route: null,
      hard_constraint_violations: [],
      forbidden_route_violations: [],
      regretful: false,
      unnecessary_multi_agent: false,
    });
    try {
      const result = await routeDag(task, identity, deps);
      if (result.outcome !== 'route' || result.run_plan === undefined) {
        errors.push(`${entry.id}: routed to ${result.outcome} instead of route`);
        taskResults.push(failureResult(result.outcome));
        continue;
      }
      const mode = result.run_plan.agent_graph.execution_mode ?? 'static_dag';
      const agentCount = result.run_plan.agent_graph.nodes.length;
      const budgetUsd = result.run_plan.budget_allocation?.usd_micros;
      const usdMicros =
        typeof budgetUsd === 'string' || typeof budgetUsd === 'number' ? budgetUsd : null;
      const emitted = routeSignature('route', mode, agentCount);

      const hardViolations: string[] = [];
      for (const token of entry.hard_constraints) {
        const violation = checkHardConstraint(token, mode, agentCount, usdMicros);
        if (violation !== null) hardViolations.push(`${token}: ${violation}`);
      }
      const forbiddenViolations =
        emitted !== null && entry.forbidden_routes.includes(emitted) ? [emitted] : [];
      const regretful =
        emitted !== null &&
        entry.preferred_order.length > 0 &&
        entry.allowed_routes.includes(entry.preferred_order[0]!) &&
        emitted !== entry.preferred_order[0] &&
        entry.allowed_routes.includes(emitted);
      const unnecessaryMultiAgent =
        emitted !== null && emitted.includes('/multi') && entry.single_agent_sufficient === true;

      taskResults.push({
        id: entry.id,
        category: entry.category,
        outcome: 'route',
        emitted_route: emitted,
        hard_constraint_violations: hardViolations,
        forbidden_route_violations: forbiddenViolations,
        regretful,
        unnecessary_multi_agent: unnecessaryMultiAgent,
      });
    } catch (error) {
      errors.push(`${entry.id}: routeDag threw ${error instanceof Error ? error.message : String(error)}`);
      taskResults.push(failureResult('error'));
    }
  }

  const total = dataset.task_count;
  const routed = taskResults.filter((r) => r.outcome === 'route').length;
  const hardViolations = taskResults.reduce((sum, r) => sum + r.hard_constraint_violations.length, 0);
  const forbiddenSelections = taskResults.reduce((sum, r) => sum + r.forbidden_route_violations.length, 0);
  const regretful = taskResults.filter((r) => r.regretful).length;
  const unnecessary = taskResults.filter((r) => r.unnecessary_multi_agent).length;
  const regretRate = total === 0 ? 0 : regretful / total;
  const unnecessaryRate = total === 0 ? 0 : unnecessary / total;

  const metrics: RoutingEvaluationMetrics = {
    total,
    routed,
    hard_constraint_violations: hardViolations,
    forbidden_route_selections: forbiddenSelections,
    regretful,
    unnecessary_multi_agent: unnecessary,
    routing_regret_rate: regretRate,
    unnecessary_multi_agent_rate: unnecessaryRate,
    pass:
      hardViolations === 0 &&
      forbiddenSelections === 0 &&
      regretRate <= 0.15 &&
      unnecessaryRate <= 0.2,
  };

  if (!metrics.pass) {
    errors.push(
      `routing eval failed: violations=${hardViolations} forbidden=${forbiddenSelections} regret=${(regretRate * 100).toFixed(1)}% unnecessary=${(unnecessaryRate * 100).toFixed(1)}%`,
    );
  }

  return {
    metrics,
    task_results: taskResults,
    errors,
    releaseReady: metrics.pass && errors.length === 0,
  };
}

// CLI entry point: run the eval and print results as JSON
if (import.meta.url === `file://${process.argv[1]}`) {
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const result = await runRoutingEvaluations({ repositoryRoot: repoRoot });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.releaseReady ? 0 : 1);
}
