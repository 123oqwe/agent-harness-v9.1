/**
 * AH-ROUTER-SKILL-CHAIN-001: skill catalog chaining and MCP discovery.
 *
 * A SkillChain orders skills so the output of skill A feeds the input of
 * skill B. Guarantees:
 *  - Every skill in a chain needs a capability token for its required
 *    capability at execution time (the policy engine is never bypassed).
 *  - A chain failure preserves partial results from completed steps and logs
 *    the failed step.
 *  - MCP discovery surfaces only skill metadata + the server NAME — endpoint
 *    or network topology is never exposed.
 */
export interface SkillSpec {
  skill_id: string;
  required_capability: string;
  /** Artifacts this skill consumes as inputs. */
  consumes: string[];
  /** Artifacts this skill produces as outputs. */
  produces: string[];
}

export interface SkillCatalog {
  skills: SkillSpec[];
}

export interface MCPRegistryServer {
  name: string;
  /** Endpoint exists only in the registry; discovery never surfaces it. */
  endpoint?: string;
  skills: SkillSpec[];
}

export interface MCPRegistry {
  servers: MCPRegistryServer[];
}

export interface TaskRequirement {
  goal_outputs: string[];
  initial_inputs?: string[];
}

/** Spec output: SkillChain with feed edges. */
export interface SkillFeed {
  from: string;
  output: string;
  to: string;
  input: string;
}

export interface SkillChain {
  /** Ordered skill_ids, executed front to back. */
  chain: string[];
  /** A's output -> B's input edges (A comes before B in the chain). */
  feeds: SkillFeed[];
}

export interface BuildSkillChainOptions {
  catalog: SkillCatalog;
  requirement: TaskRequirement;
  /** Policy-engine re-validation per skill; a denied skill never enters the chain. */
  policyOk?: (skill_id: string) => boolean;
}

/**
 * Build a deterministic skill chain by backward chaining from the task's goal
 * outputs: repeatedly pick the alphabetically-first unused skill that produces
 * a currently-needed artifact, then add its consumed inputs to the needed set.
 * The chain is then forward-verified into feed edges.
 */
export function buildSkillChain(opts: BuildSkillChainOptions): SkillChain {
  const { catalog, requirement } = opts;
  const eligible = catalog.skills.filter((s) => !opts.policyOk || opts.policyOk(s.skill_id));
  const byId = new Map(eligible.map((s) => [s.skill_id, s]));

  const needed = new Set(requirement.goal_outputs);
  const ordered: string[] = [];
  while (true) {
    const candidate = eligible
      .filter((s) => !ordered.includes(s.skill_id) && s.produces.some((p) => needed.has(p)))
      .map((s) => s.skill_id)
      .sort()[0];
    if (candidate === undefined) break;
    ordered.unshift(candidate); // built backwards: goal-producer lands last
    for (const input of byId.get(candidate)!.consumes) needed.add(input);
  }

  // forward check: each skill's inputs must be satisfiable (initial input or
  // produced by an earlier chain skill); drop a skill whose inputs are unmet
  const chain: string[] = [];
  const produced = new Set(requirement.initial_inputs ?? []);
  for (const skillId of ordered) {
    const spec = byId.get(skillId)!;
    if (spec.consumes.every((c) => produced.has(c))) {
      chain.push(skillId);
      for (const p of spec.produces) produced.add(p);
    }
  }

  const feeds: SkillFeed[] = [];
  const producedBy = new Map<string, string>(); // artifact -> producing skill_id
  for (const input of requirement.initial_inputs ?? []) producedBy.set(input, 'task-input');
  for (const skillId of chain) {
    const spec = byId.get(skillId)!;
    for (const input of spec.consumes) {
      const from = producedBy.get(input);
      if (from !== undefined && from !== 'task-input') {
        feeds.push({ from, output: input, to: skillId, input });
      }
    }
    for (const p of spec.produces) producedBy.set(p, skillId);
  }

  return { chain, feeds };
}

/** Spec output: MCP discovery result. */
export interface DiscoveredSkill {
  skill_id: string;
  required_capability: string;
  /** Server NAME only — never the endpoint/network topology. */
  mcp_server: string;
}

/**
 * Scan configured MCP servers for available skills. Only skill metadata and
 * the server name are surfaced; endpoints and any other registry metadata stay
 * in the registry (security invariant: discovery does not expose internal
 * network topology).
 */
export function discoverMcpSkills(registry: MCPRegistry): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  for (const server of registry.servers) {
    for (const skill of server.skills) {
      out.push({ skill_id: skill.skill_id, required_capability: skill.required_capability, mcp_server: server.name });
    }
  }
  out.sort((a, b) => (a.mcp_server < b.mcp_server ? -1 : a.mcp_server > b.mcp_server ? 1 : a.skill_id < b.skill_id ? -1 : 1));
  return out;
}

/** Spec output: capability token required per skill at execution time. */
export interface CapabilityToken {
  skill_id: string;
  capability: string;
}

export type SkillExecutor = (
  skill_id: string,
  inputs: Record<string, string>,
) => Promise<{ ok: true; outputs: Record<string, string> } | { ok: false; error: string }>;

export interface ChainStepLog {
  skill_id: string;
  ok: boolean;
  error?: string;
}

/** Spec output: ExecutionPlan result. */
export interface ChainRunResult {
  ok: boolean;
  /** Outputs of completed steps — preserved on failure. */
  partial_outputs: Record<string, string>;
  failed_step?: { skill_id: string; error: string };
  log: ChainStepLog[];
}

/**
 * Execute a skill chain sequentially. Every skill must present a capability
 * token matching its required capability before it runs; a missing token or a
 * failed step stops the chain, preserves partial outputs from completed steps,
 * and logs the failed step (never silently retried).
 */
export async function runSkillChain(
  chain: SkillSpec[],
  tokens: CapabilityToken[],
  execute: SkillExecutor,
  initial_inputs: Record<string, string> = {},
): Promise<ChainRunResult> {
  const partial: Record<string, string> = {};
  const log: ChainStepLog[] = [];
  let inputs = { ...initial_inputs };
  for (const spec of chain) {
    const token = tokens.find((t) => t.skill_id === spec.skill_id);
    if (token === undefined || token.capability !== spec.required_capability) {
      const error = `missing capability token for ${spec.skill_id} (${spec.required_capability})`;
      log.push({ skill_id: spec.skill_id, ok: false, error });
      return { ok: false, partial_outputs: { ...partial }, failed_step: { skill_id: spec.skill_id, error }, log };
    }
    const result = await execute(spec.skill_id, inputs);
    if (!result.ok) {
      log.push({ skill_id: spec.skill_id, ok: false, error: result.error });
      return { ok: false, partial_outputs: { ...partial }, failed_step: { skill_id: spec.skill_id, error: result.error }, log };
    }
    log.push({ skill_id: spec.skill_id, ok: true });
    Object.assign(partial, result.outputs);
    inputs = { ...inputs, ...result.outputs };
  }
  return { ok: true, partial_outputs: partial, log };
}
