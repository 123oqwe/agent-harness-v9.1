import { describe, it, expect, vi } from 'vitest';
import { EventBus, createEvent } from '../../runtime/event-bus.js';
import { recordSessionBranch } from '../../runtime/session-tree-port.js';

// ============================================================
// EventBus - batch mode (L34-58)
// ============================================================

describe('Event-bus survival-2 - batch mode', () => {
  it('buffers events in values mode and flushes after batchMs', async () => {
    const bus = new EventBus({ mode: 'values', batchMs: 10 });
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('model_called', 'run-1', { test: 1 }));
    // Events should be buffered, not yet delivered
    expect(received.length).toBe(0);
    // Wait for batchMs
    await new Promise((r) => setTimeout(r, 20));
    bus.publish(createEvent('model_called', 'run-1', { test: 2 }));
    // First event should have been flushed
    expect(received.length).toBeGreaterThanOrEqual(1);
  });

  it('delivers events immediately in updates mode', () => {
    const bus = new EventBus({ mode: 'updates' });
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('model_called', 'run-1', { test: 1 }));
    expect(received.length).toBe(1);
  });

  it('defaults to updates mode', () => {
    const bus = new EventBus();
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('model_called', 'run-1', { test: 1 }));
    expect(received.length).toBe(1);
  });

  it('swallows subscriber errors in updates mode', () => {
    const bus = new EventBus({ mode: 'updates' });
    const received: any[] = [];
    bus.subscribe(() => { throw new Error('subscriber error'); });
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('model_called', 'run-1', { test: 1 }));
    expect(received.length).toBe(1);
  });

  it('swallows subscriber errors in values mode flush', async () => {
    const bus = new EventBus({ mode: 'values', batchMs: 1 });
    const received: any[] = [];
    bus.subscribe(() => { throw new Error('subscriber error'); });
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('model_called', 'run-1', { test: 1 }));
    await new Promise((r) => setTimeout(r, 10));
    bus.flush();
    expect(received.length).toBe(1);
  });

  it('subscribe returns unsubscribe function', () => {
    const bus = new EventBus();
    const received: any[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('model_called', 'run-1', {}));
    expect(received.length).toBe(1);
    unsubscribe();
    bus.publish(createEvent('model_called', 'run-1', {}));
    expect(received.length).toBe(1);
  });

  it('flush delivers all buffered events', async () => {
    const bus = new EventBus({ mode: 'values', batchMs: 10000 });
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('model_called', 'run-1', { n: 1 }));
    bus.publish(createEvent('tool_result', 'run-1', { n: 2 }));
    bus.publish(createEvent('run_state_change', 'run-1', { n: 3 }));
    expect(received.length).toBe(0);
    bus.flush();
    expect(received.length).toBe(3);
  });

  it('flush clears buffer', async () => {
    const bus = new EventBus({ mode: 'values', batchMs: 10000 });
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('model_called', 'run-1', {}));
    bus.flush();
    expect(received.length).toBe(1);
    bus.flush();
    expect(received.length).toBe(1);
  });

  it('events getter returns buffered events', () => {
    const bus = new EventBus({ mode: 'values', batchMs: 10000 });
    bus.publish(createEvent('model_called', 'run-1', { n: 1 }));
    bus.publish(createEvent('tool_result', 'run-1', { n: 2 }));
    expect(bus.events.length).toBe(2);
  });
});

// ============================================================
// createEvent (L74-85)
// ============================================================

describe('Event-bus survival-2 - createEvent', () => {
  it('creates event with exact type and run_id', () => {
    const event = createEvent('model_called', 'run-1', { key: 'value' });
    expect(event.type).toBe('model_called');
    expect(event.run_id).toBe('run-1');
    expect(event.data).toEqual({ key: 'value' });
  });

  it('includes timestamp as ISO string', () => {
    const event = createEvent('model_called', 'run-1', {});
    expect(event.timestamp).toBeDefined();
    expect(typeof event.timestamp).toBe('string');
    expect(() => new Date(event.timestamp)).not.toThrow();
  });

  it('includes step_id when provided', () => {
    const event = createEvent('tool_result', 'run-1', {}, 'step-1');
    expect(event.step_id).toBe('step-1');
  });

  it('omits step_id when undefined', () => {
    const event = createEvent('model_called', 'run-1', {});
    expect(event.step_id).toBeUndefined();
  });
});

// ============================================================
// session-tree-port - recordSessionBranch (L24-71)
// ============================================================

describe('Session-tree-port survival-2 - recordSessionBranch', () => {
  it('returns silently when readSessionHead returns null', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue(null),
      appendLineageEvent: vi.fn(),
    } as any;
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'r1-branch',
    });
    expect(authority.readSessionHead).toHaveBeenCalledTimes(1);
    expect(authority.appendLineageEvent).not.toHaveBeenCalled();
  });

  it('calls appendLineageEvent with exact command_id format', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 5,
        hash: 'hash-123',
        security: { state_hash: 'state-hash', capability_ceiling_hash: 'ceil-hash', authorization_epoch: 2 },
      }),
      appendLineageEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'r1-branch',
    });
    expect(authority.appendLineageEvent).toHaveBeenCalledTimes(1);
    const arg = authority.appendLineageEvent.mock.calls[0][0];
    expect(arg.command_id).toMatch(/^branch-r1-branch-\d+$/);
    expect(arg.operation).toBe('branch');
    expect(arg.child_session_id).toBe('r1-branch');
  });

  it('uses head security anchors when available', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 3,
        hash: 'head-hash',
        security: { state_hash: 'sec-state', capability_ceiling_hash: 'sec-ceil', authorization_epoch: 5 },
      }),
      appendLineageEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'child-1',
    });
    const arg = authority.appendLineageEvent.mock.calls[0][0];
    expect(arg.source.security.state_hash).toBe('sec-state');
    expect(arg.source.security.capability_ceiling_hash).toBe('sec-ceil');
    expect(arg.source.security.authorization_epoch).toBe(5);
  });

  it('generates default security anchors when head has no security', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 1,
        hash: 'head-hash',
      }),
      appendLineageEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'child-1',
    });
    const arg = authority.appendLineageEvent.mock.calls[0][0];
    expect(arg.source.security.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(arg.source.security.capability_ceiling_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(arg.source.security.authorization_epoch).toBe(1);
  });

  it('uses head seq and hash in source point', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 42,
        hash: 'abc123',
        security: { state_hash: 's', capability_ceiling_hash: 'c', authorization_epoch: 1 },
      }),
      appendLineageEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'child-1',
    });
    const arg = authority.appendLineageEvent.mock.calls[0][0];
    expect(arg.source.seq).toBe(42);
    expect(arg.source.hash).toBe('abc123');
    expect(arg.source.session_id).toBe('r1');
  });

  it('passes expected_tree_head with head seq and hash', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 10,
        hash: 'h10',
        security: { state_hash: 's', capability_ceiling_hash: 'c', authorization_epoch: 1 },
      }),
      appendLineageEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'child-1',
    });
    const arg = authority.appendLineageEvent.mock.calls[0][0];
    expect(arg.expected_tree_head).toEqual({ seq: 10, hash: 'h10' });
  });

  it('passes data with version=1 and replay_policy lineage_only_no_effect_replay', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 1,
        hash: 'h',
        security: { state_hash: 's', capability_ceiling_hash: 'c', authorization_epoch: 1 },
      }),
      appendLineageEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'child-1',
    });
    const arg = authority.appendLineageEvent.mock.calls[0][0];
    expect(arg.data.version).toBe(1);
    expect(arg.data.replay_policy).toBe('lineage_only_no_effect_replay');
    expect(arg.data.operation).toBe('branch');
    expect(arg.data.child_session_id).toBe('child-1');
  });

  it('catches errors from appendLineageEvent silently', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 1,
        hash: 'h',
        security: { state_hash: 's', capability_ceiling_hash: 'c', authorization_epoch: 1 },
      }),
      appendLineageEvent: vi.fn().mockRejectedValue(new Error('rejected')),
    } as any;
    // Should not throw
    await expect(recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'child-1',
    })).resolves.toBeUndefined();
  });

  it('passes event_type as branch', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 1,
        hash: 'h',
        security: { state_hash: 's', capability_ceiling_hash: 'c', authorization_epoch: 1 },
      }),
      appendLineageEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'r1' },
      rootSessionId: 'r1',
      childSessionId: 'child-1',
    });
    const arg = authority.appendLineageEvent.mock.calls[0][0];
    expect(arg.event_type).toBe('branch');
  });

  it('passes scope in appendLineageEvent call', async () => {
    const authority = {
      readSessionHead: vi.fn().mockResolvedValue({
        seq: 1,
        hash: 'h',
        security: { state_hash: 's', capability_ceiling_hash: 'c', authorization_epoch: 1 },
      }),
      appendLineageEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    const scope = { tenant_id: 't1', root_session_id: 'r1' };
    await recordSessionBranch({
      authority,
      scope,
      rootSessionId: 'r1',
      childSessionId: 'child-1',
    });
    const arg = authority.appendLineageEvent.mock.calls[0][0];
    expect(arg.scope).toEqual(scope);
  });
});
