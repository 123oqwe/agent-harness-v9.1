import { describe, it, expect, vi } from 'vitest';
import { recordSessionBranch } from '../../runtime/session-tree-port.js';

function mockAuthority(head: any = null) {
  const events: any[] = [];
  return {
    events,
    authority: {
      async readSessionHead(_scope: any, _sessionId: string) { return head; },
      async appendLineageEvent(req: any) { events.push(req); },
    },
  };
}

const scope = { tenant_id: 't1', run_id: 'r1', session_id: 's1', root_session_id: 's1' };

describe('recordSessionBranch', () => {
  it('returns silently when session head is null', async () => {
    const { authority } = mockAuthority(null);
    await expect(recordSessionBranch({
      authority: authority as any,
      scope,
      rootSessionId: 'root-1',
      childSessionId: 'child-1',
    })).resolves.toBeUndefined();
  });

  it('records a branch event when head exists', async () => {
    const { authority, events } = mockAuthority({
      seq: 5,
      hash: 'abc123',
      security: { state_hash: 'state-hash', capability_ceiling_hash: 'cap-hash', authorization_epoch: 1 },
    });
    await recordSessionBranch({
      authority: authority as any,
      scope,
      rootSessionId: 'root-1',
      childSessionId: 'child-1',
    });
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('branch');
    expect(events[0].child_session_id).toBe('child-1');
    expect(events[0].source.session_id).toBe('root-1');
    expect(events[0].source.seq).toBe(5);
    expect(events[0].source.hash).toBe('abc123');
  });

  it('uses default security anchors when not provided', async () => {
    const { authority, events } = mockAuthority({
      seq: 1,
      hash: 'h',
      security: undefined,
    });
    await recordSessionBranch({
      authority: authority as any,
      scope,
      rootSessionId: 'root',
      childSessionId: 'child',
    });
    expect(events[0].source.security.state_hash).toBeDefined();
    expect(events[0].source.security.capability_ceiling_hash).toBeDefined();
    expect(events[0].source.security.authorization_epoch).toBe(1);
  });

  it('catches errors from appendLineageEvent without throwing', async () => {
    const authority = {
      async readSessionHead() { return { seq: 1, hash: 'h', security: {} }; },
      async appendLineageEvent() { throw new Error('authority rejected'); },
    };
    await expect(recordSessionBranch({
      authority: authority as any,
      scope,
      rootSessionId: 'root',
      childSessionId: 'child',
    })).resolves.toBeUndefined();
  });

  it('command_id contains child session id', async () => {
    const { authority, events } = mockAuthority({ seq: 1, hash: 'h', security: {} });
    await recordSessionBranch({
      authority: authority as any,
      scope,
      rootSessionId: 'root',
      childSessionId: 'child-xyz',
    });
    expect(events[0].command_id).toContain('child-xyz');
  });

  it('event data has correct structure', async () => {
    const { authority, events } = mockAuthority({ seq: 1, hash: 'h', security: {} });
    await recordSessionBranch({
      authority: authority as any,
      scope,
      rootSessionId: 'root',
      childSessionId: 'child',
    });
    expect(events[0].data.version).toBe(1);
    expect(events[0].data.operation).toBe('branch');
    expect(events[0].data.replay_policy).toBe('lineage_only_no_effect_replay');
    expect(events[0].data.child_session_id).toBe('child');
  });
});
