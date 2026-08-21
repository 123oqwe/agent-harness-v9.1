/**
 * AH-MULTIAGENT-MERGE-001: multi-agent merge conflict resolution.
 *
 * Guarantees:
 *  - Stale base detection: a proposal whose base_hash differs from the current
 *    base is flagged; when its changes do not overlap already-current changes
 *    it is re-based and replayed, otherwise it participates in conflict
 *    resolution.
 *  - Semantic conflict analysis: two changes to the same target conflict when
 *    they disagree (set-vs-set with different values, set-vs-delete). There is
 *    NO hardcoded resolution (no "edit vs delete -> keep edit"); every conflict
 *    produces the full candidate space and a supervisor decides, otherwise the
 *    conflict escalates to a human.
 *  - Security invariants: a merge requires every contributing agent's capability
 *    token to be valid; semantic conflict detection runs on security-critical
 *    fields; a security-relevant change is never dropped silently — a candidate
 *    that drops one is flagged drops_security and the drop is always surfaced.
 *  - Privacy: merge logs are structural (agent ids, targets, change ids) and
 *    never include agent conversation content (AgentChange.detail is never
 *    serialized into the result or its log).
 */

/** A single change an agent proposes against a base document entry. */
export interface AgentChange {
  change_id: string;
  agent_id: string;
  target: string;
  op: 'set' | 'delete';
  value?: unknown;
  security_critical?: boolean;
  /** Free-form detail (e.g. conversation content) — never serialized. */
  detail?: unknown;
}

/** One agent's proposed change-set, bound to a signed capability token. */
export interface AgentProposal {
  agent_id: string;
  /** The base version this agent started from (must match to avoid staleness). */
  base_hash: string;
  changes: AgentChange[];
  /** Signed capability token; must pass verify_capability for the merge. */
  capability: unknown;
}

export interface BaseDocument {
  base_hash: string;
  entries: Record<string, unknown>;
}

export interface StaleBaseIssue {
  agent_id: string;
  proposal_base_hash: string;
  current_base_hash: string;
}

export type ConflictKind = 'overlap' | 'security';

export interface MergeConflict {
  id: string;
  target: string;
  change_ids: string[];
  agents: string[];
  kind: ConflictKind;
  security_critical: boolean;
}

export interface ResolutionCandidate {
  id: string;
  conflict_id: string;
  /** Change ids this candidate keeps (empty = keep the base value). */
  change_ids: string[];
  rationale: string;
  /** Dropping at least one security-critical change — never silent. */
  drops_security: boolean;
}

export type SupervisorVerdict =
  | { conflict_id: string; outcome: 'accept'; candidate_id: string }
  | { conflict_id: string; outcome: 'escalate'; reason: string };

/** Structural log entry — never carries agent conversation content. */
export type MergeLogEntry =
  | { type: 'stale_base'; agent_id: string; proposal_base_hash: string; current_base_hash: string }
  | { type: 'rebase'; agent_id: string; change_ids: string[]; new_base_hash: string }
  | { type: 'conflict'; conflict_id: string; target: string; kind: ConflictKind; agents: string[] }
  | { type: 'applied'; change_id: string; agent_id: string; target: string }
  | { type: 'dropped_security'; change_id: string; agent_id: string; target: string }
  | { type: 'escalated'; conflict_id: string; target: string; reason: string }
  | { type: 'supervisor'; conflict_id: string; outcome: 'accept' | 'escalate'; candidate_id?: string };

export interface MergeResult {
  ok: boolean;
  base_hash: string;
  merged_entries: Record<string, unknown>;
  /** Change ids applied (non-conflicting or supervisor-accepted). */
  applied: string[];
  conflicts: MergeConflict[];
  stale: StaleBaseIssue[];
  decisions: SupervisorVerdict[];
  /** Conflict ids requiring human escalation (undecidable). */
  escalated: string[];
  /** Security-critical change ids dropped — never empty when one is dropped. */
  dropped_security: string[];
  /** True when no security-relevant change was dropped. */
  security_survived: boolean;
  log: MergeLogEntry[];
}

export interface MergeInput {
  document: BaseDocument;
  proposals: AgentProposal[];
  /** Gate for the security invariant: all capability tokens must be valid. */
  verify_capability: (capability: unknown) => boolean;
  /** Optional classifier; default: AgentChange.security_critical. */
  is_security_critical?: (change: AgentChange) => boolean;
  /** Optional supervisor. Absent -> every conflict escalates to a human. */
  supervisor?: (conflicts: MergeConflict[], candidates: ResolutionCandidate[]) => SupervisorVerdict[];
}

export class MergeValidationError extends Error {
  readonly name = 'MergeValidationError';
  constructor(message: string) {
    super(message);
  }
}

function isSecurityCritical(
  change: AgentChange,
  classifier?: (change: AgentChange) => boolean,
): boolean {
  return classifier ? classifier(change) : (change.security_critical ?? false);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function changeById(changes: AgentChange[]): Map<string, AgentChange> {
  return new Map(changes.map((change) => [change.change_id, change]));
}

/** Proposals whose base is older than the current base. */
export function detectStaleBase(proposals: AgentProposal[], currentBaseHash: string): StaleBaseIssue[] {
  return proposals
    .filter((proposal) => proposal.base_hash !== currentBaseHash)
    .map((proposal) => ({
      agent_id: proposal.agent_id,
      proposal_base_hash: proposal.base_hash,
      current_base_hash: currentBaseHash,
    }));
}

/** A stale proposal replays cleanly when none of its targets are touched. */
export function canRebase(proposal: AgentProposal, currentChanges: AgentChange[]): boolean {
  const touched = new Set(currentChanges.map((change) => change.target));
  return proposal.changes.every((change) => !touched.has(change.target));
}

/** Re-base a stale proposal onto the current base (changes preserved). */
export function rebase(proposal: AgentProposal, newBaseHash: string): AgentProposal {
  return { ...proposal, base_hash: newBaseHash };
}

/**
 * Semantic conflict analysis. Two changes to the same target conflict exactly
 * when they disagree: set-vs-set with different values, or set-vs-delete.
 * Agreement (equal set values, or both delete) is not a conflict. A conflict is
 * kind 'security' when a security-critical field is involved — the analysis
 * always runs on security-critical fields.
 */
export function detectConflicts(
  changes: AgentChange[],
  classifier?: (change: AgentChange) => boolean,
): MergeConflict[] {
  const byTarget = new Map<string, AgentChange[]>();
  for (const change of changes) {
    const group = byTarget.get(change.target) ?? [];
    group.push(change);
    byTarget.set(change.target, group);
  }
  const conflicts: MergeConflict[] = [];
  for (const [target, group] of [...byTarget.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.change_id < b.change_id ? -1 : 1));
    const agrees = sorted.every((change, i) => {
      if (i === 0) return true;
      const prev = sorted[i - 1]!;
      if (prev.op !== change.op) return false;
      return deepEqual(prev.value, change.value);
    });
    if (agrees) continue; // all agents propose the same outcome
    const securityCritical = sorted.some((change) => isSecurityCritical(change, classifier));
    conflicts.push({
      id: `conflict-${target}`,
      target,
      change_ids: sorted.map((change) => change.change_id),
      agents: [...new Set(sorted.map((change) => change.agent_id))].sort(),
      kind: securityCritical ? 'security' : 'overlap',
      security_critical: securityCritical,
    });
  }
  return conflicts;
}

/**
 * The full candidate space for a conflict — no hardcoded preference. Each
 * involved change yields a keep-only-that-change candidate; a keep-base option
 * drops them all. drops_security marks candidates that drop a security-critical
 * change so the supervisor's choice is never a silent drop.
 */
export function buildCandidates(
  conflict: MergeConflict,
  changes: AgentChange[],
  classifier?: (change: AgentChange) => boolean,
): ResolutionCandidate[] {
  const byId = changeById(changes);
  const candidates: ResolutionCandidate[] = [];
  for (const changeId of conflict.change_ids) {
    const change = byId.get(changeId)!;
    const dropped = conflict.change_ids.filter((id) => id !== changeId);
    candidates.push({
      id: `keep-${changeId}`,
      conflict_id: conflict.id,
      change_ids: [changeId],
      rationale: `keep ${change.agent_id}'s change on ${conflict.target}`,
      drops_security: dropped.some((id) => isSecurityCritical(byId.get(id)!, classifier)),
    });
  }
  candidates.push({
    id: 'keep-base',
    conflict_id: conflict.id,
    change_ids: [],
    rationale: `keep the base value on ${conflict.target}`,
    drops_security: conflict.change_ids.some((id) => isSecurityCritical(byId.get(id)!, classifier)),
  });
  return candidates;
}

function applyChange(entries: Record<string, unknown>, change: AgentChange): void {
  if (change.op === 'set') entries[change.target] = change.value;
  else delete entries[change.target];
}

function buildLog(result: {
  baseHash: string;
  stale: StaleBaseIssue[];
  conflicts: MergeConflict[];
  applied: string[];
  changes: AgentChange[];
  escalated: string[];
  droppedSecurity: string[];
  rebased: Array<{ agent_id: string; change_ids: string[] }>;
  decisions: SupervisorVerdict[];
}): MergeLogEntry[] {
  const byId = changeById(result.changes);
  const log: MergeLogEntry[] = [];
  for (const issue of result.stale) {
    log.push({
      type: 'stale_base',
      agent_id: issue.agent_id,
      proposal_base_hash: issue.proposal_base_hash,
      current_base_hash: issue.current_base_hash,
    });
  }
  for (const rebased of result.rebased) {
    log.push({ type: 'rebase', agent_id: rebased.agent_id, change_ids: rebased.change_ids, new_base_hash: result.baseHash });
  }
  for (const conflict of result.conflicts) {
    log.push({ type: 'conflict', conflict_id: conflict.id, target: conflict.target, kind: conflict.kind, agents: conflict.agents });
  }
  for (const changeId of result.applied) {
    const change = byId.get(changeId)!;
    log.push({ type: 'applied', change_id: changeId, agent_id: change.agent_id, target: change.target });
  }
  for (const changeId of result.droppedSecurity) {
    const change = byId.get(changeId)!;
    log.push({ type: 'dropped_security', change_id: changeId, agent_id: change.agent_id, target: change.target });
  }
  for (const conflictId of result.escalated) {
    const conflict = result.conflicts.find((c) => c.id === conflictId)!;
    log.push({ type: 'escalated', conflict_id: conflictId, target: conflict.target, reason: 'undecidable by supervisor' });
  }
  for (const decision of result.decisions) {
    if (decision.outcome === 'accept') {
      log.push({ type: 'supervisor', conflict_id: decision.conflict_id, outcome: 'accept', candidate_id: decision.candidate_id });
    } else {
      log.push({ type: 'supervisor', conflict_id: decision.conflict_id, outcome: 'escalate' });
    }
  }
  return log;
}

/**
 * Merge multiple agents' outputs onto a base document. Every proposal's
 * capability token must verify or the merge is rejected outright (security
 * invariant). Stale proposals are re-based and replayed when their changes do
 * not overlap; overlapping stale changes and all disagreeing changes become
 * conflicts. A conflict with no supervisor verdict — or a security-critical
 * conflict whose resolution would drop a security change without an explicit
 * supervisor choice — escalates to a human.
 */
export function mergeAgentOutputs(input: MergeInput): MergeResult {
  const classifier = input.is_security_critical;
  const invalid = input.proposals.filter((proposal) => !input.verify_capability(proposal.capability));
  if (invalid.length > 0) {
    throw new MergeValidationError(`capability invalid for agent(s): ${invalid.map((p) => p.agent_id).join(', ')}`);
  }

  const allChanges = input.proposals.flatMap((proposal) => proposal.changes);
  const byId = changeById(allChanges);

  const stale = detectStaleBase(input.proposals, input.document.base_hash);
  const currentProposals = input.proposals.filter((proposal) => proposal.base_hash === input.document.base_hash);
  const currentChanges = currentProposals.flatMap((proposal) => proposal.changes);

  const rebased: Array<{ agent_id: string; change_ids: string[] }> = [];
  for (const proposal of input.proposals.filter((p) => p.base_hash !== input.document.base_hash)) {
    if (canRebase(proposal, currentChanges)) {
      rebased.push({ agent_id: proposal.agent_id, change_ids: proposal.changes.map((c) => c.change_id) });
    }
  }

  const conflicts = detectConflicts(allChanges, classifier);
  const conflictedIds = new Set(conflicts.flatMap((conflict) => conflict.change_ids));

  const mergedEntries: Record<string, unknown> = { ...input.document.entries };
  const applied: string[] = [];
  for (const proposal of input.proposals) {
    for (const change of proposal.changes) {
      if (conflictedIds.has(change.change_id)) continue;
      applyChange(mergedEntries, change);
      applied.push(change.change_id);
    }
  }

  const candidatesByConflict = new Map<string, ResolutionCandidate[]>();
  for (const conflict of conflicts) {
    candidatesByConflict.set(conflict.id, buildCandidates(conflict, allChanges, classifier));
  }
  const allCandidates = conflicts.flatMap((conflict) => candidatesByConflict.get(conflict.id)!);
  const decisions: SupervisorVerdict[] = input.supervisor
    ? input.supervisor(conflicts, allCandidates)
    : [];
  const decisionsByConflict = new Map(decisions.map((decision) => [decision.conflict_id, decision]));

  const escalated: string[] = [];
  const droppedSecurity: string[] = [];
  for (const conflict of conflicts) {
    const decision = decisionsByConflict.get(conflict.id);
    if (decision?.outcome === 'accept') {
      const candidates = candidatesByConflict.get(conflict.id)!;
      const candidate = candidates.find((c) => c.id === decision.candidate_id);
      if (candidate === undefined) {
        throw new MergeValidationError(`supervisor accepted unknown candidate for ${conflict.id}`);
      }
      for (const changeId of candidate.change_ids) {
        applyChange(mergedEntries, byId.get(changeId)!);
        applied.push(changeId);
      }
      for (const changeId of conflict.change_ids) {
        if (!candidate.change_ids.includes(changeId) && isSecurityCritical(byId.get(changeId)!, classifier)) {
          droppedSecurity.push(changeId);
        }
      }
    } else {
      escalated.push(conflict.id);
    }
  }

  // A security-critical conflict that produced no decision must not resolve
  // silently — it escalates even when the supervisor is absent.
  for (const conflict of conflicts) {
    if (conflict.security_critical && !decisionsByConflict.has(conflict.id)) {
      if (!escalated.includes(conflict.id)) escalated.push(conflict.id);
    }
  }

  const log = buildLog({
    baseHash: input.document.base_hash,
    stale,
    conflicts,
    applied,
    changes: allChanges,
    escalated,
    droppedSecurity,
    rebased,
    decisions,
  });

  return {
    ok: escalated.length === 0,
    base_hash: input.document.base_hash,
    merged_entries: mergedEntries,
    applied,
    conflicts,
    stale,
    decisions,
    escalated,
    dropped_security: [...new Set(droppedSecurity)].sort(),
    security_survived: droppedSecurity.length === 0,
    log,
  };
}
