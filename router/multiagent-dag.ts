/**
 * AH-MULTIAGENT-DAG-001: agent task DAG with topological sort, parallel
 * groups, cycle rejection, status tracking, and StreamEvents.
 *
 * Guarantees:
 *  - Execution order is a valid topological order (never out-of-order).
 *  - Nodes at the same dependency level are parallel-safe and execute in
 *    the same group.
 *  - A cyclic DAG is rejected with a typed DAGCycleError carrying the cycle.
 *  - Per-node status is queryable (pending/running/completed/failed).
 *  - The executor emits a full graph snapshot on the first event, deltas
 *    afterwards.
 *  - Per-node agent config (G-CC1) is validated at plan freeze and its
 *    disallowed_tool_refs deny wins over any tool grant.
 */
export type AgentNodeStatus = 'pending' | 'running' | 'completed' | 'failed';

export type ExecutionMode = 'static_dag' | 'routing_slip' | 'workflow_script';

/** G-CC1 per-agent config, validated at RunPlan Freeze. */
export interface AgentConfig {
  isolation?: 'worktree' | 'none';
  hooks_ref?: string;
  memory_scope?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  disallowed_tool_refs?: string[];
}

export interface AgentTaskNode {
  node_id: string;
  deps: string[];
  agent_config?: AgentConfig;
}

export interface AgentTaskDAG {
  nodes: AgentTaskNode[];
  execution_mode?: ExecutionMode;
  insert_limit?: number;
}

/** Typed error for cyclic DAGs. */
export class DAGCycleError extends Error {
  readonly name = 'DAGCycleError';
  readonly code = 'DAG_CYCLE';
  readonly cycle_nodes: string[];
  constructor(cycle: string[]) {
    super(`cyclic dependency detected: ${cycle.join(' -> ')}`);
    this.cycle_nodes = cycle;
  }
}

function kahn(dag: AgentTaskDAG): { order: string[]; remaining: Set<string> } {
  const inDegree = new Map(dag.nodes.map((n) => [n.node_id, n.deps.length]));
  const children = new Map<string, string[]>(dag.nodes.map((n) => [n.node_id, []]));
  for (const n of dag.nodes) {
    for (const dep of n.deps) children.get(dep)!.push(n.node_id);
  }
  for (const list of children.values()) list.sort();
  const ready = dag.nodes.filter((n) => n.deps.length === 0).map((n) => n.node_id).sort();
  const order: string[] = [];
  const remaining = new Set(dag.nodes.map((n) => n.node_id));
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    remaining.delete(id);
    for (const child of children.get(id)!) {
      const next = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, next);
      if (next === 0) ready.push(child);
    }
    ready.sort();
  }
  return { order, remaining };
}

/** Depth-first cycle search; returns the cycle path or null. */
function dfsCycle(dag: AgentTaskDAG): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(dag.nodes.map((n) => [n.node_id, WHITE]));
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    const node = dag.nodes.find((n) => n.node_id === id);
    for (const dep of node?.deps ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const i = stack.indexOf(dep);
        return [...stack.slice(i), dep];
      }
      if (c === WHITE) {
        const r = visit(dep);
        if (r !== null) return r;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };
  const sorted = [...dag.nodes].sort((a, b) => (a.node_id < b.node_id ? -1 : 1));
  for (const n of sorted) {
    if (color.get(n.node_id) === WHITE) {
      const r = visit(n.node_id);
      if (r !== null) return r;
    }
  }
  return null;
}

/** Returns the cycle path, or null when the DAG is acyclic. */
export function detectCycle(dag: AgentTaskDAG): string[] | null {
  return dfsCycle(dag);
}

/** Valid topological execution order; throws DAGCycleError on cycles. */
export function topologicalSort(dag: AgentTaskDAG): string[] {
  const { order, remaining } = kahn(dag);
  if (remaining.size > 0) {
    throw new DAGCycleError(dfsCycle(dag) ?? [...remaining].sort());
  }
  return order;
}

/**
 * Parallel groups: nodes at the same dependency level, ordered by level.
 * Safe to run each group's nodes concurrently (they never depend on each
 * other). Throws DAGCycleError on cycles.
 */
export function parallelGroups(dag: AgentTaskDAG): string[][] {
  const groups: string[][] = [];
  const inDegree = new Map(dag.nodes.map((n) => [n.node_id, n.deps.length]));
  const children = new Map<string, string[]>(dag.nodes.map((n) => [n.node_id, []]));
  for (const n of dag.nodes) {
    for (const dep of n.deps) children.get(dep)!.push(n.node_id);
  }
  const removed = new Set<string>();
  let ready = dag.nodes.filter((n) => n.deps.length === 0).map((n) => n.node_id).sort();
  while (ready.length > 0) {
    const group: string[] = [];
    const nextReady: string[] = [];
    for (const id of ready) {
      group.push(id);
      removed.add(id);
      for (const child of children.get(id)!) {
        if (removed.has(child)) continue;
        const next = (inDegree.get(child) ?? 0) - 1;
        inDegree.set(child, next);
        if (next === 0) nextReady.push(child);
      }
    }
    groups.push(group);
    ready = [...new Set(nextReady)].sort();
  }
  if (removed.size < dag.nodes.length) {
    throw new DAGCycleError(dfsCycle(dag) ?? [...dag.nodes.map((n) => n.node_id)].filter((id) => !removed.has(id)));
  }
  return groups;
}

/**
 * Execution-mode selection: an explicit declaration wins; otherwise open-ended
 * missions route as routing_slip and large fan-outs as workflow_script.
 */
export function selectExecutionMode(opts: {
  declared?: ExecutionMode;
  node_count: number;
  fan_out?: number;
  open_ended?: boolean;
}): ExecutionMode {
  if (opts.declared !== undefined) return opts.declared;
  if (opts.open_ended) return 'routing_slip';
  if ((opts.fan_out ?? 0) >= 12 || opts.node_count >= 12) return 'workflow_script';
  return 'static_dag';
}

/** Spec output: workflow_graph StreamEvent (snapshot on first emit, deltas after). */
export interface WorkflowGraphStreamEvent {
  event_seq: number;
  kind: 'snapshot' | 'delta';
  node_id: string;
  status: AgentNodeStatus;
  /** Full graph snapshot — only on the snapshot event. */
  graph?: Array<{ node_id: string; status: AgentNodeStatus }>;
}

export type AgentNodeExecutor = (node_id: string) => Promise<{ ok: boolean }>;

/**
 * Stateful DAG executor with queryable per-node status and a StreamEvent
 * stream: the first event carries the full graph snapshot, subsequent events
 * are deltas.
 */
export class AgentDAGExecutor {
  readonly dag: AgentTaskDAG;
  readonly order: string[];
  readonly groups: string[][];
  private readonly statuses: Map<string, AgentNodeStatus>;
  private readonly stream: WorkflowGraphStreamEvent[];

  constructor(dag: AgentTaskDAG) {
    this.dag = dag;
    this.order = topologicalSort(dag);
    this.groups = parallelGroups(dag);
    this.statuses = new Map(dag.nodes.map((n) => [n.node_id, 'pending']));
    this.stream = [
      { event_seq: 0, kind: 'snapshot', node_id: '', status: 'pending', graph: this.snapshot() },
    ];
  }

  statusOf(node_id: string): AgentNodeStatus {
    return this.statuses.get(node_id)!;
  }

  markRunning(node_id: string): void {
    this.statuses.set(node_id, 'running');
    this.emitDelta(node_id);
  }

  markCompleted(node_id: string): void {
    this.statuses.set(node_id, 'completed');
    this.emitDelta(node_id);
  }

  markFailed(node_id: string): void {
    this.statuses.set(node_id, 'failed');
    this.emitDelta(node_id);
  }

  events(): WorkflowGraphStreamEvent[] {
    return this.stream;
  }

  private snapshot(): Array<{ node_id: string; status: AgentNodeStatus }> {
    return this.dag.nodes.map((n) => ({ node_id: n.node_id, status: this.statuses.get(n.node_id)! }));
  }

  private emitDelta(node_id: string): void {
    const seq = this.stream[this.stream.length - 1]!.event_seq + 1;
    this.stream.push({ event_seq: seq, kind: 'delta', node_id, status: this.statuses.get(node_id)! });
  }

  /**
   * Run the DAG: nodes at the same dependency level execute concurrently
   * (parallel-safe — they never depend on each other). A failed node does not
   * stop its group; dependents in later groups run regardless (failure
   * propagation is the DAG-failure matrix's concern).
   */
  async run(execute: AgentNodeExecutor): Promise<void> {
    for (const group of this.groups) {
      await Promise.all(
        group.map(async (nodeId) => {
          this.markRunning(nodeId);
          const result = await execute(nodeId);
          if (result.ok) this.markCompleted(nodeId);
          else this.markFailed(nodeId);
        }),
      );
    }
  }
}

/** Validate G-CC1 node config at RunPlan Freeze; returns the error list. */
export function validateNodeConfig(node: AgentTaskNode): string[] {
  const errors: string[] = [];
  const cfg = node.agent_config;
  if (cfg === undefined) return errors;
  if (cfg.effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(cfg.effort)) {
    errors.push(`node ${node.node_id}: invalid effort "${cfg.effort}"`);
  }
  if (cfg.isolation !== undefined && !['worktree', 'none'].includes(cfg.isolation)) {
    errors.push(`node ${node.node_id}: invalid isolation "${cfg.isolation}"`);
  }
  return errors;
}

/**
 * Tool-mask state (FG5): action selection is constrained to the allowed set,
 * and disallowed_tool_refs DENY WINS over any grant.
 */
export function nodeToolMask(node: AgentTaskNode, grantedTools: string[]): string[] {
  const denied = new Set(node.agent_config?.disallowed_tool_refs ?? []);
  return grantedTools.filter((t) => !denied.has(t));
}

/** Spec output: cross-process agent message (FG8). */
export interface CrossProcessAgentMessage {
  from: string;
  to: string;
  obo_token: string;
  jws_signature: string;
  payload: unknown;
}

/**
 * Build a cross-process agent message. Every message carries an OBO token
 * (the originating user's delegation chain) and a JWS signature over the
 * payload; the signature is produced by the caller's signer so the module
 * stays dependency-free.
 */
export function createAgentMessage(opts: {
  from: string;
  to: string;
  obo_token: string;
  payload: unknown;
  sign: (payload: unknown) => string;
}): CrossProcessAgentMessage {
  return {
    from: opts.from,
    to: opts.to,
    obo_token: opts.obo_token,
    payload: opts.payload,
    jws_signature: opts.sign(opts.payload),
  };
}

/** A message is only valid when it carries both an OBO token and a signature. */
export function isSignedAgentMessage(msg: CrossProcessAgentMessage): boolean {
  return msg.obo_token.length > 0 && msg.jws_signature.length > 0;
}
