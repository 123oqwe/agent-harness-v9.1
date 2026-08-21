import { describe, it, expect } from 'vitest';
import {
  TOPOLOGY_TYPES,
  resolveTopology,
  verifyIsolation,
  vfsReadAllowlist,
  type AgentContext,
} from '../../router/context-topology.js';

const SECRET = '/ctx/A/secret.txt';

function agents(a: Partial<AgentContext> & { agent_id: string }): AgentContext {
  return { items: [], shares: [], ...a };
}

describe('AH-ROUTER-CONTEXT-TOPOLOGY-001 topology types', () => {
  it('implements exactly the 7 mandated topologies', () => {
    expect(TOPOLOGY_TYPES).toEqual([
      'isolated',
      'shared_selective',
      'parent_child',
      'pipeline',
      'fan_out',
      'fan_in',
      'hierarchical',
    ]);
    expect(TOPOLOGY_TYPES).toHaveLength(7);
  });
});

describe('AH-ROUTER-CONTEXT-TOPOLOGY-001 isolated', () => {
  const config = {
    topology: 'isolated' as const,
    agents: [
      agents({ agent_id: 'A', items: ['/ctx/A/notes.txt', SECRET] }),
      agents({ agent_id: 'B', items: ['/ctx/B/notes.txt'] }),
    ],
  };

  it('agent A cannot read agent B context and vice versa', () => {
    const t = resolveTopology(config);
    expect(t.visibility.A).toEqual(['/ctx/A/notes.txt', SECRET]);
    expect(t.visibility.B).toEqual(['/ctx/B/notes.txt']);
    expect(t.visibility.B).not.toContain(SECRET);
  });

  it('isolated is enforced at the VFS permission layer, not just the context graph', () => {
    const allowlist = vfsReadAllowlist(config);
    expect(allowlist.B).not.toContain(SECRET);
    expect(allowlist.A).toContain(SECRET);
  });

  it('property test: a secret injected in A is invisible to B', () => {
    const proof = verifyIsolation(config);
    expect(proof.held).toBe(true);
    expect(proof.violations).toEqual([]);
  });

  it('isolated ignores share rules entirely — no cross-boundary reads', () => {
    const leaked = {
      topology: 'isolated' as const,
      agents: [
        agents({ agent_id: 'A', items: [SECRET], shares: [{ item: SECRET }] }),
        agents({ agent_id: 'B', items: [] }),
      ],
    };
    expect(resolveTopology(leaked).visibility.B).toEqual([]);
  });
});

describe('AH-ROUTER-CONTEXT-TOPOLOGY-001 shared_selective', () => {
  it('only explicitly shared items cross the boundary', () => {
    const config = {
      topology: 'shared_selective' as const,
      agents: [
        agents({ agent_id: 'A', items: ['/ctx/A/shared.txt', '/ctx/A/private.txt'], shares: [{ item: '/ctx/A/shared.txt' }] }),
        agents({ agent_id: 'B', items: [] }),
      ],
    };
    const t = resolveTopology(config);
    expect(t.visibility.B).toContain('/ctx/A/shared.txt');
    expect(t.visibility.B).not.toContain('/ctx/A/private.txt');
    expect(verifyIsolation(config).held).toBe(true);
  });

  it('a share targeted at specific agents does not reach others', () => {
    const config = {
      topology: 'shared_selective' as const,
      agents: [
        agents({ agent_id: 'A', items: ['/ctx/A/x.txt'], shares: [{ item: '/ctx/A/x.txt', to: ['B'] }] }),
        agents({ agent_id: 'B', items: [] }),
        agents({ agent_id: 'C', items: [] }),
      ],
    };
    const t = resolveTopology(config);
    expect(t.visibility.B).toContain('/ctx/A/x.txt');
    expect(t.visibility.C).not.toContain('/ctx/A/x.txt');
  });
});

describe('AH-ROUTER-CONTEXT-TOPOLOGY-001 parent_child', () => {
  it('a child sees only what the parent explicitly shared — never the parent full context', () => {
    const config = {
      topology: 'parent_child' as const,
      agents: [
        agents({
          agent_id: 'P',
          items: ['/ctx/P/all.txt', '/ctx/P/delegated.txt'],
          shares: [{ item: '/ctx/P/delegated.txt', to: ['C'] }],
        }),
        agents({ agent_id: 'C', items: [], parent: 'P' }),
      ],
    };
    const t = resolveTopology(config);
    expect(t.visibility.C).toEqual(['/ctx/P/delegated.txt']);
    expect(t.visibility.C).not.toContain('/ctx/P/all.txt');
    expect(verifyIsolation(config).held).toBe(true);
  });
});

describe('AH-ROUTER-CONTEXT-TOPOLOGY-001 pipeline / fan_out / fan_in / hierarchical', () => {
  it('pipeline: each agent sees the previous agent shared output', () => {
    const config = {
      topology: 'pipeline' as const,
      agents: [
        agents({ agent_id: 'a0', order: 0, items: ['/ctx/a0/in.txt'], shares: [{ item: '/ctx/a0/out.txt' }] }),
        agents({ agent_id: 'a1', order: 1, items: ['/ctx/a1/own.txt'] }),
      ],
    };
    const t = resolveTopology(config);
    expect(t.visibility.a1).toContain('/ctx/a0/out.txt');
    expect(t.visibility.a1).not.toContain('/ctx/a0/in.txt');
    expect(verifyIsolation(config).held).toBe(true);
  });

  it('fan_out: children receive the parent shared task input', () => {
    const config = {
      topology: 'fan_out' as const,
      agents: [
        agents({ agent_id: 'P', items: ['/ctx/P/task.txt'], shares: [{ item: '/ctx/P/task.txt' }], children: ['C1', 'C2'] }),
        agents({ agent_id: 'C1', items: [], parent: 'P' }),
        agents({ agent_id: 'C2', items: [], parent: 'P' }),
      ],
    };
    const t = resolveTopology(config);
    expect(t.visibility.C1).toContain('/ctx/P/task.txt');
    expect(t.visibility.C2).toContain('/ctx/P/task.txt');
    expect(verifyIsolation(config).held).toBe(true);
  });

  it('fan_in: the aggregation sink receives each child shared output', () => {
    const config = {
      topology: 'fan_in' as const,
      agents: [
        agents({ agent_id: 'C1', items: ['/ctx/C1/r1.txt'], shares: [{ item: '/ctx/C1/r1.txt' }], parent: 'S' }),
        agents({ agent_id: 'C2', items: ['/ctx/C2/r2.txt'], shares: [{ item: '/ctx/C2/r2.txt' }], parent: 'S' }),
        agents({ agent_id: 'S', items: [], children: ['C1', 'C2'] }),
      ],
    };
    const t = resolveTopology(config);
    expect(t.visibility.S).toContain('/ctx/C1/r1.txt');
    expect(t.visibility.S).toContain('/ctx/C2/r2.txt');
    expect(t.visibility.C1).not.toContain('/ctx/C2/r2.txt');
    expect(verifyIsolation(config).held).toBe(true);
  });

  it('hierarchical: a node share reaches all descendants, not just direct children', () => {
    const config = {
      topology: 'hierarchical' as const,
      agents: [
        agents({ agent_id: 'R', items: ['/ctx/R/global.txt'], shares: [{ item: '/ctx/R/global.txt' }], children: ['M'] }),
        agents({ agent_id: 'M', items: [], parent: 'R', children: ['L'] }),
        agents({ agent_id: 'L', items: [], parent: 'M' }),
      ],
    };
    const t = resolveTopology(config);
    expect(t.visibility.L).toContain('/ctx/R/global.txt');
    expect(verifyIsolation(config).held).toBe(true);
  });
});

describe('AH-ROUTER-CONTEXT-TOPOLOGY-001 isolation proof', () => {
  it('flags a config where an agent reads a path it neither owns nor is shared', () => {
    const config = {
      topology: 'shared_selective' as const,
      agents: [
        agents({ agent_id: 'A', items: ['/ctx/A/owned.txt'] }),
        // B claims A's path directly in its own items — a crossing without a share
        agents({ agent_id: 'B', items: ['/ctx/A/owned.txt'] }),
      ],
    };
    const proof = verifyIsolation(config);
    expect(proof.held).toBe(false);
    expect(proof.violations).toContainEqual({ reader: 'B', path: '/ctx/A/owned.txt' });
  });
});
