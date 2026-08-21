import { describe, expect, it } from 'vitest';

import {
  MergeValidationError,
  buildCandidates,
  detectConflicts,
  mergeAgentOutputs,
  type AgentChange,
  type AgentProposal,
  type MergeConflict,
  type MergeInput,
  type ResolutionCandidate,
  type SupervisorVerdict,
} from '../../runtime/merge-conflict.js';

const OK_CAP = { valid: true };

function change(overrides: Partial<AgentChange> & { change_id: string; target: string }): AgentChange {
  return { agent_id: 'agent-a', op: 'set', ...overrides };
}

function proposal(overrides: Partial<AgentProposal> & { agent_id: string }): AgentProposal {
  return { base_hash: 'base-1', changes: [], capability: OK_CAP, ...overrides };
}

function merge(input: Partial<MergeInput> & Pick<MergeInput, 'proposals'>): ReturnType<typeof mergeAgentOutputs> {
  return mergeAgentOutputs({
    document: { base_hash: 'base-1', entries: {} },
    verify_capability: (capability) => (capability as { valid?: boolean })?.valid === true,
    ...input,
  });
}

function acceptAll(candidateIdFor: (conflictId: string) => string) {
  return (_conflicts: MergeConflict[], candidates: ResolutionCandidate[]): SupervisorVerdict[] => {
    const byConflict = new Map<string, ResolutionCandidate[]>();
    for (const candidate of candidates) {
      const list = byConflict.get(candidate.conflict_id) ?? [];
      list.push(candidate);
      byConflict.set(candidate.conflict_id, list);
    }
    return [...byConflict.keys()].map((conflictId) => ({
      conflict_id: conflictId,
      outcome: 'accept' as const,
      candidate_id: candidateIdFor(conflictId),
    }));
  };
}

describe('AH-MULTIAGENT-MERGE-001 semantic conflict analysis', () => {
  it('two agents setting the same target to different values conflict', () => {
    const conflicts = detectConflicts([
      change({ change_id: 'c1', agent_id: 'a', target: 'config/max_tokens', value: 100 }),
      change({ change_id: 'c2', agent_id: 'b', target: 'config/max_tokens', value: 200 }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe('overlap');
    expect(conflicts[0]!.change_ids.sort()).toEqual(['c1', 'c2']);
  });

  it('set-vs-delete on the same target is a conflict — with no default winner', () => {
    const edit = change({ change_id: 'c1', agent_id: 'a', target: 'feature/flags/x', op: 'set', value: true });
    const del = change({ change_id: 'c2', agent_id: 'b', target: 'feature/flags/x', op: 'delete' });
    const conflicts = detectConflicts([edit, del]);
    expect(conflicts).toHaveLength(1);

    // The full candidate space is produced: keep-edit, keep-delete, keep-base.
    // No hardcoded "edit vs delete -> keep edit" preference.
    const candidates = buildCandidates(conflicts[0]!, [edit, del]);
    expect(candidates.map((c) => c.id)).toEqual(['keep-c1', 'keep-c2', 'keep-base']);

    // With no supervisor the conflict is undecidable and escalates.
    const result = merge({ proposals: [proposal({ agent_id: 'a', changes: [edit] }), proposal({ agent_id: 'b', changes: [del] })] });
    expect(result.ok).toBe(false);
    expect(result.escalated).toEqual(['conflict-feature/flags/x']);
  });

  it('agreeing changes (same value or both delete) are not conflicts', () => {
    expect(
      detectConflicts([
        change({ change_id: 'c1', agent_id: 'a', target: 'k', value: 5 }),
        change({ change_id: 'c2', agent_id: 'b', target: 'k', value: 5 }),
      ]),
    ).toEqual([]);
    expect(
      detectConflicts([
        change({ change_id: 'c1', agent_id: 'a', target: 'k', op: 'delete' }),
        change({ change_id: 'c2', agent_id: 'b', target: 'k', op: 'delete' }),
      ]),
    ).toEqual([]);
  });

  it('conflicts are deterministic and ordered by target', () => {
    const conflicts = detectConflicts([
      change({ change_id: 'c1', agent_id: 'a', target: 'z', value: 1 }),
      change({ change_id: 'c2', agent_id: 'b', target: 'z', value: 2 }),
      change({ change_id: 'c3', agent_id: 'c', target: 'a', value: 3 }),
      change({ change_id: 'c4', agent_id: 'd', target: 'a', value: 4 }),
    ]);
    expect(conflicts.map((c) => c.id)).toEqual(['conflict-a', 'conflict-z']);
  });
});

describe('AH-MULTIAGENT-MERGE-001 supervisor evaluation', () => {
  it('a supervisor decision applies the chosen candidate', () => {
    const result = merge({
      proposals: [
        proposal({ agent_id: 'a', changes: [change({ change_id: 'c1', agent_id: 'a', target: 'k', value: 100 })] }),
        proposal({ agent_id: 'b', changes: [change({ change_id: 'c2', agent_id: 'b', target: 'k', value: 200 })] }),
      ],
      supervisor: acceptAll(() => 'keep-c2'),
    });
    expect(result.ok).toBe(true);
    expect(result.merged_entries.k).toBe(200);
    expect(result.decisions).toContainEqual({ conflict_id: 'conflict-k', outcome: 'accept', candidate_id: 'keep-c2' });
  });

  it('a supervisor escalate verdict routes the conflict to a human', () => {
    const result = merge({
      proposals: [
        proposal({ agent_id: 'a', changes: [change({ change_id: 'c1', agent_id: 'a', target: 'k', value: 1 })] }),
        proposal({ agent_id: 'b', changes: [change({ change_id: 'c2', agent_id: 'b', target: 'k', value: 2 })] }),
      ],
      supervisor: () => [{ conflict_id: 'conflict-k', outcome: 'escalate' as const, reason: 'policy ambiguity' }],
    });
    expect(result.ok).toBe(false);
    expect(result.escalated).toEqual(['conflict-k']);
  });

  it('an unknown candidate id from the supervisor is a validation error', () => {
    expect(() =>
      merge({
        proposals: [
          proposal({ agent_id: 'a', changes: [change({ change_id: 'c1', agent_id: 'a', target: 'k', value: 1 })] }),
          proposal({ agent_id: 'b', changes: [change({ change_id: 'c2', agent_id: 'b', target: 'k', value: 2 })] }),
        ],
        supervisor: () => [{ conflict_id: 'conflict-k', outcome: 'accept' as const, candidate_id: 'nonexistent' }],
      }),
    ).toThrow(MergeValidationError);
  });

  it('non-conflicting changes merge without involving the supervisor', () => {
    const result = merge({
      proposals: [
        proposal({ agent_id: 'a', changes: [change({ change_id: 'c1', agent_id: 'a', target: 'x', value: 1 })] }),
        proposal({ agent_id: 'b', changes: [change({ change_id: 'c2', agent_id: 'b', target: 'y', value: 2 })] }),
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.merged_entries).toEqual({ x: 1, y: 2 });
    expect(result.conflicts).toEqual([]);
    expect(result.applied.sort()).toEqual(['c1', 'c2']);
  });
});

describe('AH-MULTIAGENT-MERGE-001 security invariants', () => {
  it('a merge rejects outright when any capability token is invalid', () => {
    expect(() =>
      merge({
        proposals: [proposal({ agent_id: 'a', capability: { valid: false } })],
      }),
    ).toThrow(MergeValidationError);
  });

  it('semantic conflict detection runs on security-critical fields (kind=security)', () => {
    const conflicts = detectConflicts([
      change({ change_id: 's1', agent_id: 'a', target: 'auth/admin', value: ['alice'], security_critical: true }),
      change({ change_id: 's2', agent_id: 'b', target: 'auth/admin', value: ['bob'] }),
    ]);
    expect(conflicts[0]!.kind).toBe('security');
    expect(conflicts[0]!.security_critical).toBe(true);
  });

  it('a security-critical conflict with no supervisor escalates — never silently dropped', () => {
    const result = merge({
      proposals: [
        proposal({
          agent_id: 'a',
          changes: [change({ change_id: 's1', agent_id: 'a', target: 'auth/admin', value: ['alice'], security_critical: true })],
        }),
        proposal({
          agent_id: 'b',
          changes: [change({ change_id: 's2', agent_id: 'b', target: 'auth/admin', value: ['bob'] })],
        }),
      ],
    });
    expect(result.escalated).toEqual(['conflict-auth/admin']);
    expect(result.dropped_security).toEqual([]); // nothing dropped — the conflict is unresolved
    expect(result.security_survived).toBe(true); // nothing was dropped
    expect(result.ok).toBe(false);
  });

  it('a supervisor dropping a security-critical change is surfaced, never silent', () => {
    const result = merge({
      proposals: [
        proposal({
          agent_id: 'a',
          changes: [change({ change_id: 's1', agent_id: 'a', target: 'auth/admin', value: ['alice'], security_critical: true })],
        }),
        proposal({
          agent_id: 'b',
          changes: [change({ change_id: 's2', agent_id: 'b', target: 'auth/admin', value: ['bob'] })],
        }),
      ],
      // keep-s2 keeps the plain change and drops the security-critical s1 — the
      // drop must be surfaced, never silent.
      supervisor: acceptAll(() => 'keep-s2'),
    });
    expect(result.dropped_security).toEqual(['s1']);
    expect(result.security_survived).toBe(false);
    expect(result.log).toContainEqual({ type: 'dropped_security', change_id: 's1', agent_id: 'a', target: 'auth/admin' });
  });
});

describe('AH-MULTIAGENT-MERGE-001 privacy', () => {
  it('merge logs never include agent conversation content', () => {
    const secret = 'TOP SECRET agent conversation transcript';
    const result = merge({
      proposals: [
        proposal({
          agent_id: 'a',
          changes: [
            change({
              change_id: 'c1',
              agent_id: 'a',
              target: 'x',
              value: 1,
              detail: { transcript: secret },
            }),
          ],
        }),
        proposal({
          agent_id: 'b',
          changes: [
            change({
              change_id: 'c2',
              agent_id: 'b',
              target: 'k',
              value: 2,
              detail: { transcript: secret },
            }),
          ],
        }),
      ],
    });
    expect(JSON.stringify(result.log)).not.toContain('TOP SECRET');
    expect(JSON.stringify(result)).not.toContain('TOP SECRET');
  });
});
