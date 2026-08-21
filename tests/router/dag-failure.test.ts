import { describe, it, expect } from 'vitest';
import {
  DAG_FAILURE_TYPES,
  classifyFailure,
  decidePropagation,
  isRetryableFailure,
  runDAG,
  type DAGDefinition,
  type DAGExecutionState,
} from '../../router/dag-failure.js';

function byId(states: DAGExecutionState[]): Map<string, DAGExecutionState> {
  return new Map(states.map((s) => [s.node_id, s]));
}

const ok = (node_id: string) => async () => ({ node_id, ok: true });

/** Returns an executor that fails the given node once with the given type. */
function failing(failureMap: Record<string, { type?: 'node_timeout' | 'node_error' | 'node_refused' | 'dependency_failed' | 'budget_exhausted' | 'policy_denied' | 'model_refused' | 'tool_error' | 'network_error' | 'truncation' | 'oscillation' }>) {
  return async (node_id: string) => {
    const f = failureMap[node_id];
    return f ? { node_id, ok: false, ...(f.type ? { failure: f.type } : {}) } : { node_id, ok: true };
  };
}

describe('AH-ROUTER-DAG-FAILURE-001 failure taxonomy', () => {
  it('exposes exactly the 11 mandated failure types', () => {
    expect(DAG_FAILURE_TYPES).toEqual([
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
    ]);
    expect(DAG_FAILURE_TYPES).toHaveLength(11);
  });

  it('classifies failures into transient/terminal/dependency with retryability', () => {
    expect(classifyFailure('node_timeout')).toEqual({ type: 'node_timeout', category: 'transient', retryable: true });
    expect(classifyFailure('network_error')).toEqual({ type: 'network_error', category: 'transient', retryable: true });
    expect(classifyFailure('model_refused')).toEqual({ type: 'model_refused', category: 'transient', retryable: true });
    expect(classifyFailure('policy_denied')).toEqual({ type: 'policy_denied', category: 'terminal', retryable: false });
    expect(classifyFailure('budget_exhausted')).toEqual({ type: 'budget_exhausted', category: 'terminal', retryable: false });
    expect(classifyFailure('dependency_failed')).toEqual({
      type: 'dependency_failed',
      category: 'dependency',
      retryable: false,
    });
  });

  it('isRetryableFailure agrees with classifyFailure', () => {
    for (const t of DAG_FAILURE_TYPES) {
      expect(isRetryableFailure(t)).toBe(classifyFailure(t).retryable);
    }
  });

  it('decidePropagation: critical aborts DAG, non-critical blocks downstream only', () => {
    expect(decidePropagation(true)).toEqual({
      abort_dag: true,
      block_downstream: false,
      siblings_continue: false,
    });
    expect(decidePropagation(false)).toEqual({
      abort_dag: false,
      block_downstream: true,
      siblings_continue: true,
    });
  });
});

describe('AH-ROUTER-DAG-FAILURE-001 execution semantics', () => {
  it('a non-critical failure does not cascade to siblings; downstream is BLOCKED not FAILED', async () => {
    // a → b (fails) and c (sibling, succeeds); b → d
    const dag: DAGDefinition = {
      nodes: [{ node_id: 'a' }, { node_id: 'b' }, { node_id: 'c' }, { node_id: 'd' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
      ],
    };
    const r = await runDAG(dag, failing({ b: { type: 'node_error' } }));
    const states = byId(r.states);
    expect(r.aborted).toBe(false);
    expect(r.critical_failure).toBeUndefined();
    expect(states.get('a')!.status).toBe('done');
    expect(states.get('b')!.status).toBe('failed');
    expect(states.get('b')!.failure).toBe('node_error');
    // sibling c unaffected
    expect(states.get('c')!.status).toBe('done');
    // downstream d is BLOCKED, never FAILED, with the dependency_failed marker
    expect(states.get('d')!.status).toBe('blocked');
    expect(states.get('d')!.failure).toBe('dependency_failed');
  });

  it('a critical path failure aborts the entire DAG, even ready siblings', async () => {
    // a → b, c; b → d (critical). c's dependent e is ready in the same wave as d.
    const dag: DAGDefinition = {
      nodes: [
        { node_id: 'a' },
        { node_id: 'b' },
        { node_id: 'c' },
        { node_id: 'd', critical: true },
        { node_id: 'e' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'e' },
      ],
    };
    const r = await runDAG(dag, failing({ d: { type: 'tool_error' } }));
    const states = byId(r.states);
    expect(r.aborted).toBe(true);
    expect(r.critical_failure).toEqual({ node_id: 'd', failure: 'tool_error' });
    expect(states.get('d')!.status).toBe('failed');
    // e was ready but the whole DAG aborts: it is ABORTED, not done
    expect(states.get('e')!.status).toBe('aborted');
    // a, b, c completed before the abort
    expect(states.get('a')!.status).toBe('done');
    expect(states.get('b')!.status).toBe('done');
    expect(states.get('c')!.status).toBe('done');
  });

  it('blocked propagation is transitive: a blocked node blocks its own downstream', async () => {
    // a → b (fails) → c → d
    const dag: DAGDefinition = {
      nodes: [{ node_id: 'a' }, { node_id: 'b' }, { node_id: 'c' }, { node_id: 'd' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
      ],
    };
    const r = await runDAG(dag, failing({ b: { type: 'network_error' } }));
    const states = byId(r.states);
    expect(states.get('b')!.status).toBe('failed');
    expect(states.get('c')!.status).toBe('blocked');
    expect(states.get('c')!.failure).toBe('dependency_failed');
    expect(states.get('d')!.status).toBe('blocked');
    expect(states.get('d')!.failure).toBe('dependency_failed');
  });

  it('failure propagation reaches every dependent node — no silent skip', async () => {
    // Two independent branches; only the dependent side of the failure is touched.
    const dag: DAGDefinition = {
      nodes: [{ node_id: 'a' }, { node_id: 'b' }, { node_id: 'x' }, { node_id: 'y' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'x', to: 'y' },
      ],
    };
    const r = await runDAG(dag, failing({ a: { type: 'node_refused' } }));
    const states = byId(r.states);
    expect(states.get('a')!.status).toBe('failed');
    expect(states.get('b')!.status).toBe('blocked');
    // independent branch fully runs
    expect(states.get('x')!.status).toBe('done');
    expect(states.get('y')!.status).toBe('done');
  });

  it('a failure without an explicit type defaults to node_error', async () => {
    const dag: DAGDefinition = { nodes: [{ node_id: 'a' }], edges: [] };
    const r = await runDAG(dag, async () => ({ node_id: 'a', ok: false }));
    expect(r.states[0]!.status).toBe('failed');
    expect(r.states[0]!.failure).toBe('node_error');
  });

  it('runs ready nodes deterministically in sorted node_id order', async () => {
    const order: string[] = [];
    const dag: DAGDefinition = {
      nodes: [{ node_id: 'z' }, { node_id: 'm' }, { node_id: 'a' }],
      edges: [],
    };
    const r = await runDAG(dag, async (node_id) => {
      order.push(node_id);
      return { node_id, ok: true };
    });
    expect(order).toEqual(['a', 'm', 'z']);
    expect(r.states.every((s) => s.status === 'done')).toBe(true);
  });

  it('an all-ok DAG completes with every node done', async () => {
    const dag: DAGDefinition = {
      nodes: [{ node_id: 'a' }, { node_id: 'b' }, { node_id: 'c' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
    };
    const r = await runDAG(dag, ok('a'));
    expect(r.aborted).toBe(false);
    expect(r.states.every((s) => s.status === 'done')).toBe(true);
  });
});
