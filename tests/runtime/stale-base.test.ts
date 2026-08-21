import { describe, expect, it } from 'vitest';

import {
  canRebase,
  detectStaleBase,
  mergeAgentOutputs,
  rebase,
  type AgentChange,
  type AgentProposal,
  type MergeInput,
} from '../../runtime/merge-conflict.js';

function change(overrides: Partial<AgentChange> & { change_id: string; target: string }): AgentChange {
  return { agent_id: 'agent-a', op: 'set', ...overrides };
}

function proposal(overrides: Partial<AgentProposal> & { agent_id: string }): AgentProposal {
  return { base_hash: 'base-1', changes: [], capability: { valid: true }, ...overrides };
}

function merge(input: Partial<MergeInput> & Pick<MergeInput, 'proposals'>): ReturnType<typeof mergeAgentOutputs> {
  return mergeAgentOutputs({
    document: { base_hash: 'base-1', entries: {} },
    verify_capability: (capability) => (capability as { valid?: boolean })?.valid === true,
    ...input,
  });
}

describe('AH-MULTIAGENT-MERGE-001 stale base detection', () => {
  it('flags proposals whose base differs from the current base', () => {
    const stale = detectStaleBase(
      [
        proposal({ agent_id: 'current', base_hash: 'base-1' }),
        proposal({ agent_id: 'stale-a', base_hash: 'base-0' }),
        proposal({ agent_id: 'stale-b', base_hash: 'base-0' }),
      ],
      'base-1',
    );
    expect(stale).toEqual([
      { agent_id: 'stale-a', proposal_base_hash: 'base-0', current_base_hash: 'base-1' },
      { agent_id: 'stale-b', proposal_base_hash: 'base-0', current_base_hash: 'base-1' },
    ]);
  });

  it('a proposal on the current base is not stale', () => {
    expect(detectStaleBase([proposal({ agent_id: 'a', base_hash: 'base-1' })], 'base-1')).toEqual([]);
  });
});

describe('AH-MULTIAGENT-MERGE-001 rebase / replay', () => {
  it('a stale proposal replays when it touches no already-current target', () => {
    const staleProposal = proposal({
      agent_id: 'stale',
      base_hash: 'base-0',
      changes: [change({ change_id: 's1', agent_id: 'stale', target: 'new-field', value: 42 })],
    });
    const currentChanges = [change({ change_id: 'c1', agent_id: 'a', target: 'other-field', value: 1 })];
    expect(canRebase(staleProposal, currentChanges)).toBe(true);

    const replayed = rebase(staleProposal, 'base-1');
    expect(replayed.base_hash).toBe('base-1');
    expect(replayed.changes).toEqual(staleProposal.changes);
  });

  it('a stale proposal whose target is touched by current changes cannot rebase', () => {
    const staleProposal = proposal({
      agent_id: 'stale',
      base_hash: 'base-0',
      changes: [change({ change_id: 's1', agent_id: 'stale', target: 'k', value: 42 })],
    });
    const currentChanges = [change({ change_id: 'c1', agent_id: 'a', target: 'k', value: 1 })];
    expect(canRebase(staleProposal, currentChanges)).toBe(false);
  });

  it('end to end: a stale non-overlapping proposal merges and is replayed', () => {
    const result = merge({
      proposals: [
        proposal({
          agent_id: 'a',
          base_hash: 'base-1',
          changes: [change({ change_id: 'c1', agent_id: 'a', target: 'x', value: 1 })],
        }),
        proposal({
          agent_id: 'stale',
          base_hash: 'base-0',
          changes: [change({ change_id: 's1', agent_id: 'stale', target: 'y', value: 2 })],
        }),
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.merged_entries).toEqual({ x: 1, y: 2 });
    expect(result.stale).toEqual([{ agent_id: 'stale', proposal_base_hash: 'base-0', current_base_hash: 'base-1' }]);
    expect(result.log).toContainEqual({ type: 'rebase', agent_id: 'stale', change_ids: ['s1'], new_base_hash: 'base-1' });
    expect(result.log).toContainEqual({ type: 'stale_base', agent_id: 'stale', proposal_base_hash: 'base-0', current_base_hash: 'base-1' });
  });

  it('end to end: a stale overlapping proposal becomes a conflict, never a silent merge', () => {
    const result = merge({
      proposals: [
        proposal({
          agent_id: 'a',
          base_hash: 'base-1',
          changes: [change({ change_id: 'c1', agent_id: 'a', target: 'k', value: 100 })],
        }),
        proposal({
          agent_id: 'stale',
          base_hash: 'base-0',
          changes: [change({ change_id: 's1', agent_id: 'stale', target: 'k', value: 200 })],
        }),
      ],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.change_ids.sort()).toEqual(['c1', 's1']);
    // No supervisor -> the conflicting stale change does not silently override.
    expect(result.escalated).toEqual(['conflict-k']);
    expect(result.ok).toBe(false);
  });

  it('end to end: a stale change that agrees with the current change merges silently', () => {
    const result = merge({
      proposals: [
        proposal({
          agent_id: 'a',
          base_hash: 'base-1',
          changes: [change({ change_id: 'c1', agent_id: 'a', target: 'k', value: 5 })],
        }),
        proposal({
          agent_id: 'stale',
          base_hash: 'base-0',
          changes: [change({ change_id: 's1', agent_id: 'stale', target: 'k', value: 5 })],
        }),
      ],
    });
    expect(result.conflicts).toEqual([]);
    expect(result.merged_entries.k).toBe(5);
    expect(result.ok).toBe(true);
  });
});
