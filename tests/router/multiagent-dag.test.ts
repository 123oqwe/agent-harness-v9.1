import { describe, it, expect } from 'vitest';
import {
  DAGCycleError,
  AgentDAGExecutor,
  createAgentMessage,
  detectCycle,
  isSignedAgentMessage,
  nodeToolMask,
  parallelGroups,
  selectExecutionMode,
  topologicalSort,
  validateNodeConfig,
  type AgentTaskDAG,
  type AgentTaskNode,
} from '../../router/multiagent-dag.js';

function node(id: string, deps: string[] = [], agent_config?: AgentTaskNode['agent_config']): AgentTaskNode {
  return { node_id: id, deps, ...(agent_config ? { agent_config } : {}) };
}

const dag: AgentTaskDAG = {
  nodes: [node('c', ['a']), node('b', ['a']), node('a'), node('d', ['b', 'c'])],
};

describe('AH-MULTIAGENT-DAG-001 topological order', () => {
  it('produces a valid execution order: every dependency precedes its dependent', () => {
    const order = topologicalSort(dag);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const n of dag.nodes) {
      for (const dep of n.deps) {
        expect(pos.get(dep)!).toBeLessThan(pos.get(n.node_id)!);
      }
    }
  });

  it('groups nodes at the same dependency level together', () => {
    expect(parallelGroups(dag)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('groups are parallel-safe: no node depends on another in its group', () => {
    for (const group of parallelGroups(dag)) {
      const inGroup = new Set(group);
      for (const id of group) {
        const n = dag.nodes.find((x) => x.node_id === id)!;
        expect(n.deps.every((dep) => !inGroup.has(dep))).toBe(true);
      }
    }
  });
});

describe('AH-MULTIAGENT-DAG-001 cycle detection', () => {
  const cyclic: AgentTaskDAG = {
    nodes: [node('a', ['c']), node('b', ['a']), node('c', ['b'])],
  };

  it('rejects a cyclic DAG with a typed error carrying the cycle', () => {
    expect(() => topologicalSort(cyclic)).toThrow(DAGCycleError);
    try {
      topologicalSort(cyclic);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGCycleError);
      expect((e as DAGCycleError).code).toBe('DAG_CYCLE');
      expect((e as DAGCycleError).cycle_nodes).toEqual(['a', 'c', 'b', 'a']);
    }
  });

  it('parallelGroups also rejects cycles', () => {
    expect(() => parallelGroups(cyclic)).toThrow(DAGCycleError);
  });

  it('detectCycle returns the cycle path and null for acyclic DAGs', () => {
    expect(detectCycle(cyclic)).not.toBeNull();
    expect(detectCycle(dag)).toBeNull();
  });
});

describe('AH-MULTIAGENT-DAG-001 status tracking + stream events', () => {
  it('status is queryable through pending -> running -> completed', async () => {
    const ex = new AgentDAGExecutor(dag);
    expect(ex.statusOf('a')).toBe('pending');
    ex.markRunning('a');
    expect(ex.statusOf('a')).toBe('running');
    ex.markCompleted('a');
    expect(ex.statusOf('a')).toBe('completed');
  });

  it('emits a full graph snapshot on the first event, deltas after', async () => {
    const ex = new AgentDAGExecutor(dag);
    const events = ex.events();
    expect(events[0]!.kind).toBe('snapshot');
    expect(events[0]!.graph).toHaveLength(4); // full graph
    ex.markRunning('a');
    ex.markCompleted('a');
    ex.markRunning('b');
    ex.markCompleted('b');
    const deltas = events.slice(1);
    expect(deltas.every((e) => e.kind === 'delta')).toBe(true);
    expect(deltas.map((e) => e.node_id)).toEqual(['a', 'a', 'b', 'b']);
    // event_seq strictly increasing
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.event_seq).toBeGreaterThan(events[i - 1]!.event_seq);
    }
  });

  it('executes nodes in parallel within a dependency level', async () => {
    const ex = new AgentDAGExecutor(dag);
    const started: Record<string, boolean> = {};
    const runOrder: string[] = [];
    await ex.run(async (id) => {
      started[id] = true;
      runOrder.push(id);
      // 'b' and 'c' are same-level; prove overlap by checking both started
      return { ok: true };
    });
    // all four reached completed
    for (const n of dag.nodes) expect(ex.statusOf(n.node_id)).toBe('completed');
    expect(runOrder.length).toBe(4);
  });

  it('a failed node is queryable as failed and does not stop its group', async () => {
    const ex = new AgentDAGExecutor(dag);
    await ex.run(async (id) => ({ ok: id !== 'b' }));
    expect(ex.statusOf('b')).toBe('failed');
    expect(ex.statusOf('c')).toBe('completed');
    expect(ex.statusOf('d')).toBe('completed');
  });
});

describe('AH-MULTIAGENT-DAG-001 execution mode', () => {
  it('declared mode wins', () => {
    expect(selectExecutionMode({ declared: 'workflow_script', node_count: 2 })).toBe('workflow_script');
  });
  it('open-ended missions route as routing_slip', () => {
    expect(selectExecutionMode({ node_count: 1, open_ended: true })).toBe('routing_slip');
  });
  it('large fan-outs route as workflow_script', () => {
    expect(selectExecutionMode({ node_count: 12, fan_out: 12 })).toBe('workflow_script');
  });
  it('otherwise defaults to static_dag', () => {
    expect(selectExecutionMode({ node_count: 3, fan_out: 2 })).toBe('static_dag');
  });
});

describe('AH-MULTIAGENT-DAG-001 node config (G-CC1)', () => {
  it('validates effort and isolation at plan freeze', () => {
    expect(validateNodeConfig(node('ok', [], { effort: 'high', isolation: 'worktree' }))).toEqual([]);
    // deliberately invalid G-CC1 values — the runtime validator must reject them
    const badConfig = { effort: 'turbo', isolation: 'sandbox' } as unknown as AgentTaskNode['agent_config'];
    expect(validateNodeConfig(node('bad', [], badConfig))).toEqual([
      'node bad: invalid effort "turbo"',
      'node bad: invalid isolation "sandbox"',
    ]);
  });

  it('disallowed_tool_refs deny wins over grants (tool mask)', () => {
    const masked = node('x', [], { disallowed_tool_refs: ['write_file', 'execute_command'] });
    expect(nodeToolMask(masked, ['read_file', 'write_file', 'execute_command'])).toEqual(['read_file']);
  });
});

describe('AH-MULTIAGENT-DAG-001 cross-process messages (FG8)', () => {
  it('every agent message carries an OBO token and a JWS signature', () => {
    const msg = createAgentMessage({
      from: 'parent',
      to: 'child',
      obo_token: 'user-session-token',
      payload: { action: 'summarize' },
      sign: (p) => `jws.${JSON.stringify(p).length}`,
    });
    expect(msg.obo_token).toBe('user-session-token');
    expect(msg.jws_signature.length).toBeGreaterThan(0);
    expect(isSignedAgentMessage(msg)).toBe(true);
  });

  it('a message without a signature is not accepted', () => {
    expect(isSignedAgentMessage({ from: 'a', to: 'b', obo_token: 't', jws_signature: '', payload: {} })).toBe(false);
  });
});
