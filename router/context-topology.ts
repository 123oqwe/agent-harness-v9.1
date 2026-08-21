/**
 * AH-ROUTER-CONTEXT-TOPOLOGY-001: 7 context topologies with isolation
 * verification.
 *
 * A context item crosses an agent boundary ONLY through an explicit share rule
 * (ShareRule). Each topology defines the boundary for those shares:
 *  - isolated: no shares cross — every agent reads only its own items.
 *  - shared_selective: an explicitly shared item is visible to every other
 *    agent; unshared items never cross.
 *  - parent_child: a share crosses from a parent to its direct children only;
 *    a child can never access the parent's full context.
 *  - pipeline: a share crosses from each agent to the next in order.
 *  - fan_out: the fan-out agent's shares reach all of its children.
 *  - fan_in: each child's shares reach the aggregation sink.
 *  - hierarchical: a node's shares reach all of its descendants.
 *
 * Isolation is enforced at the VFS permission layer: vfsReadAllowlist derives,
 * per agent, the exact set of VFS paths that agent may read from the topology.
 * The context graph is a projection of that same allowlist.
 */
export type TopologyType =
  | 'isolated'
  | 'shared_selective'
  | 'parent_child'
  | 'pipeline'
  | 'fan_out'
  | 'fan_in'
  | 'hierarchical';

export const TOPOLOGY_TYPES: readonly TopologyType[] = [
  'isolated',
  'shared_selective',
  'parent_child',
  'pipeline',
  'fan_out',
  'fan_in',
  'hierarchical',
];

/** An explicit share rule: item crosses to `to` (or every in-boundary agent when omitted). */
export interface ShareRule {
  item: string;
  to?: string[];
}

export interface AgentContext {
  agent_id: string;
  /** VFS paths owned by this agent (e.g. `/ctx/<agent_id>/secret.txt`). */
  items: string[];
  /** Explicit share rules — the ONLY way an item crosses a boundary. */
  shares: ShareRule[];
  parent?: string;
  children?: string[];
  order?: number;
}

export interface TopologyConfig {
  topology: TopologyType;
  agents: AgentContext[];
}

/** Spec output: ContextTopology. */
export interface ContextTopology {
  topology: TopologyType;
  /** Effective readable items per agent, derived from the topology + shares. */
  visibility: Record<string, string[]>;
}

function sharesTargeting(agents: AgentContext[], target: string, source: string[]): string[] {
  const items: string[] = [];
  for (const agent of agents) {
    if (!source.includes(agent.agent_id)) continue;
    for (const rule of agent.shares) {
      if (rule.to === undefined || rule.to.includes(target)) items.push(rule.item);
    }
  }
  return items;
}

function ownItems(agent: AgentContext): string[] {
  return [...agent.items];
}

/**
 * Resolve a topology into per-agent effective visibility. Pure and
 * deterministic: same config always yields the same visibility map.
 */
export function resolveTopology(config: TopologyConfig): ContextTopology {
  const byId = new Map(config.agents.map((a) => [a.agent_id, a]));
  const visibility: Record<string, string[]> = {};
  const unique = (list: string[]) => [...new Set(list)];

  for (const agent of config.agents) {
    switch (config.topology) {
      case 'isolated': {
        // no share crosses any boundary — a reads only its own items
        visibility[agent.agent_id] = ownItems(agent);
        break;
      }
      case 'shared_selective': {
        // explicitly shared items reach every other agent; unshared never cross
        visibility[agent.agent_id] = unique([
          ...ownItems(agent),
          ...sharesTargeting(config.agents, agent.agent_id, config.agents.map((a) => a.agent_id)),
        ]);
        break;
      }
      case 'parent_child': {
        const fromParent = agent.parent ? sharesTargeting(config.agents, agent.agent_id, [agent.parent]) : [];
        // child sees own items + what the parent explicitly shared to it — never the parent's full context
        visibility[agent.agent_id] = unique([...ownItems(agent), ...fromParent]);
        break;
      }
      case 'pipeline': {
        const prev = config.agents.find((a) => a.order === (agent.order ?? 0) - 1);
        const fromPrev = prev ? sharesTargeting(config.agents, agent.agent_id, [prev.agent_id]) : [];
        visibility[agent.agent_id] = unique([...ownItems(agent), ...fromPrev]);
        break;
      }
      case 'fan_out': {
        // children receive shares from the fan-out parent
        const parent = config.agents.find((a) => (a.children ?? []).includes(agent.agent_id));
        const fromParent = parent ? sharesTargeting(config.agents, agent.agent_id, [parent.agent_id]) : [];
        visibility[agent.agent_id] = unique([...ownItems(agent), ...fromParent]);
        break;
      }
      case 'fan_in': {
        // the aggregation sink receives each child's shares
        const isSink = (agent.children ?? []).length > 0;
        const fromChildren = isSink
          ? sharesTargeting(config.agents, agent.agent_id, agent.children ?? [])
          : [];
        visibility[agent.agent_id] = unique([...ownItems(agent), ...fromChildren]);
        break;
      }
      case 'hierarchical': {
        // a node's shares reach all descendants; ancestors are collected up the parent chain
        const ancestors: string[] = [];
        let cur = agent.parent;
        while (cur !== undefined && byId.has(cur)) {
          ancestors.push(cur);
          cur = byId.get(cur)!.parent;
        }
        visibility[agent.agent_id] = unique([...ownItems(agent), ...sharesTargeting(config.agents, agent.agent_id, ancestors)]);
        break;
      }
    }
  }
  return { topology: config.topology, visibility };
}

/**
 * VFS read allowlist per agent — the permission layer where isolation is
 * enforced (FG4). A path is readable by an agent if and only if it appears in
 * this allowlist; the context graph is a projection of it.
 */
export function vfsReadAllowlist(config: TopologyConfig): Record<string, string[]> {
  return resolveTopology(config).visibility;
}

/** Verify the security invariants of a topology config. */
export interface IsolationProof {
  held: boolean;
  violations: Array<{ reader: string; path: string }>;
}

/**
 * Property-test the topology: every path readable by an agent must be either
 * owned by it or reachable through an explicit share rule whose `to` targets
 * it. An injected secret in agent A can never appear in B's allowlist unless
 * A explicitly shared it with B.
 */
export function verifyIsolation(config: TopologyConfig): IsolationProof {
  const allowlist = vfsReadAllowlist(config);
  const violations: Array<{ reader: string; path: string }> = [];
  for (const agent of config.agents) {
    const allowed = allowlist[agent.agent_id] ?? [];
    for (const path of allowed) {
      const owner = config.agents.find((a) => a.items.includes(path));
      if (owner === undefined) continue; // not owned by any agent in scope
      if (owner.agent_id === agent.agent_id) continue; // own item
      const sharedToThis = owner.shares.some((s) => s.item === path && (s.to === undefined || s.to.includes(agent.agent_id)));
      if (!sharedToThis) violations.push({ reader: agent.agent_id, path });
    }
  }
  return { held: violations.length === 0, violations };
}
