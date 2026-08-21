/**
 * AH-ROUTER-DAG-FAILURE-001: DAG failure matrix with blocked propagation and
 * criticality.
 *
 * Deterministic executor over a DAG of steps. Failure semantics:
 *  - A node on the critical path failing aborts the entire DAG (every pending
 *    node is marked aborted).
 *  - A non-critical node failing does NOT cascade to siblings — other ready
 *    nodes in the same wave still run; only downstream nodes that depend on
 *    the failed node are affected.
 *  - Blocked propagation: a node whose dependency failed or is blocked is
 *    marked BLOCKED (not FAILED) with the dependency_failed failure type, and
 *    the blockage propagates transitively downstream.
 *
 * Execution order is deterministic (ready nodes run in sorted node_id order,
 * wave by dependency level). This models the execution semantics the Runtime
 * must apply to a RunPlan workflow_graph; it does not execute tools.
 */
export type DAGFailureType =
  | 'node_timeout'
  | 'node_error'
  | 'node_refused'
  | 'dependency_failed'
  | 'budget_exhausted'
  | 'policy_denied'
  | 'model_refused'
  | 'tool_error'
  | 'network_error'
  | 'truncation'
  | 'oscillation';

export const DAG_FAILURE_TYPES: readonly DAGFailureType[] = [
  'node_timeout',
  'node_error',
  'node_refused',
  'dependency_failed',
  'budget_exhausted',
  'policy_denied',
  'model_refused',
  'tool_error',
  'network_error',
  'truncation',
  'oscillation',
];

export type DAGNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'aborted';

export interface DAGNode {
  node_id: string;
  /** Whether this node lies on the critical path; default false. */
  critical?: boolean;
}

export interface DAGEdge {
  from: string;
  to: string;
}

export interface DAGDefinition {
  nodes: DAGNode[];
  edges: DAGEdge[];
}

export interface NodeExecutionResult {
  node_id: string;
  ok: boolean;
  failure?: DAGFailureType;
}

export interface DAGExecutionState {
  node_id: string;
  status: DAGNodeStatus;
  failure?: DAGFailureType;
}

export interface RunDAGResult {
  states: DAGExecutionState[];
  aborted: boolean;
  critical_failure?: { node_id: string; failure: DAGFailureType };
}

export type DAGExecutor = (node_id: string) => Promise<NodeExecutionResult>;

/** Spec output: FailureClassification. */
export type FailureCategory = 'transient' | 'terminal' | 'dependency';

export interface FailureClassification {
  type: DAGFailureType;
  category: FailureCategory;
  retryable: boolean;
}

/** Spec output: CriticalityLevel. */
export type CriticalityLevel = 'critical' | 'non_critical';

/** Spec output: PropagationDecision. */
export interface PropagationDecision {
  abort_dag: boolean;
  block_downstream: boolean;
  siblings_continue: boolean;
}

const RETRYABLE_FAILURES: ReadonlySet<DAGFailureType> = new Set([
  'node_timeout',
  'node_error',
  'network_error',
  'model_refused',
]);

/** Classify a failure type into transient/terminal/dependency with retryability. */
export function classifyFailure(type: DAGFailureType): FailureClassification {
  const retryable = RETRYABLE_FAILURES.has(type);
  const category: FailureCategory = type === 'dependency_failed' ? 'dependency' : retryable ? 'transient' : 'terminal';
  return { type, category, retryable };
}

/**
 * Decide how a failed node propagates, given whether it lies on the critical
 * path. Critical failures abort the whole DAG; non-critical failures leave
 * siblings running and block only downstream dependents.
 */
export function decidePropagation(critical: boolean): PropagationDecision {
  return critical
    ? { abort_dag: true, block_downstream: false, siblings_continue: false }
    : { abort_dag: false, block_downstream: true, siblings_continue: true };
}

/** Deterministic DAG executor with critical-path abort and blocked propagation. */
export async function runDAG(dag: DAGDefinition, execute: DAGExecutor): Promise<RunDAGResult> {
  const depsOf = new Map<string, string[]>();
  for (const node of dag.nodes) depsOf.set(node.node_id, []);
  for (const edge of dag.edges) depsOf.get(edge.to)!.push(edge.from);

  const criticalByNode = new Map<string, boolean>(dag.nodes.map((n) => [n.node_id, n.critical === true]));
  const states = new Map<string, DAGNodeStatus>(dag.nodes.map((n) => [n.node_id, 'pending']));
  const failures = new Map<string, DAGFailureType>();
  let aborted = false;
  let criticalFailure: { node_id: string; failure: DAGFailureType } | undefined;

  const remaining = new Set(dag.nodes.map((n) => n.node_id));
  const allDepsDone = (id: string): boolean => depsOf.get(id)!.every((dep) => states.get(dep) === 'done');

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => states.get(id) === 'pending' && allDepsDone(id))
      .sort();

    if (ready.length === 0) {
      // No node can make progress: remaining pendings are blocked by a failed
      // or blocked dependency (the DAG is acyclic, so this is not a deadlock).
      for (const id of [...remaining].sort()) {
        if (states.get(id) === 'pending') {
          states.set(id, 'blocked');
          failures.set(id, 'dependency_failed');
          remaining.delete(id);
        }
      }
      break;
    }

    for (const id of ready) {
      if (aborted) {
        states.set(id, 'aborted');
        remaining.delete(id);
        continue;
      }
      const result = await execute(id);
      if (result.ok) {
        states.set(id, 'done');
      } else {
        states.set(id, 'failed');
        failures.set(id, result.failure ?? 'node_error');
        if (criticalByNode.get(id)) {
          aborted = true;
          criticalFailure = { node_id: id, failure: failures.get(id)! };
        }
      }
      remaining.delete(id);
    }

    // Blocked propagation after the wave: nodes whose dependency failed or is
    // already blocked become BLOCKED (not FAILED), with dependency_failed.
    for (const id of [...remaining].sort()) {
      if (states.get(id) !== 'pending') continue;
      if (depsOf.get(id)!.some((dep) => states.get(dep) === 'failed' || states.get(dep) === 'blocked')) {
        states.set(id, 'blocked');
        failures.set(id, 'dependency_failed');
        remaining.delete(id);
      }
    }

    if (aborted) {
      for (const id of [...remaining]) {
        states.set(id, 'aborted');
        remaining.delete(id);
      }
      break;
    }
  }

  return {
    states: dag.nodes.map((node) => {
      const state: DAGExecutionState = { node_id: node.node_id, status: states.get(node.node_id)! };
      const failure = failures.get(node.node_id);
      if (failure !== undefined) state.failure = failure;
      return state;
    }),
    aborted,
    ...(criticalFailure !== undefined ? { critical_failure: criticalFailure } : {}),
  };
}

/**
 * Whether a failure type is retryable. Shared vocabulary for the DAG failure
 * matrix and the fallback chain (AH-ROUTER-FALLBACK-11-001).
 */
export function isRetryableFailure(type: DAGFailureType): boolean {
  return classifyFailure(type).retryable;
}
