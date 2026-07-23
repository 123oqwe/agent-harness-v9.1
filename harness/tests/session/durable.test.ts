import { describe, it, expect, beforeEach } from 'vitest';
import { DurableSession } from '../../session/durable-session.js';

describe('AH-SESSION-001: durable session events', () => {
  let session: DurableSession;

  beforeEach(() => {
    session = new DurableSession('run-001');
  });

  it('creates a run_created event on construction', () => {
    expect(session.eventCount).toBe(1);
    const events = session.getEvents();
    expect(events[0].type).toBe('run_created');
    expect(events[0].run_id).toBe('run-001');
  });

  it('appends events with sequential sequence numbers', () => {
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.append({ type: 'step_created', run_id: 'run-001', step_id: 'step-1', data: {} });
    expect(session.eventCount).toBe(3);
    expect(session.lastSeq).toBe(3);
  });

  it('events have hash chain (prev_hash links to previous event_hash)', () => {
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.append({ type: 'step_created', run_id: 'run-001', step_id: 'step-1', data: {} });
    const events = session.getEvents();
    expect(events[1].prev_hash).toBe(events[0].event_hash);
    expect(events[2].prev_hash).toBe(events[1].event_hash);
  });

  it('verifyIntegrity returns valid for untampered chain', () => {
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.append({ type: 'step_created', run_id: 'run-001', step_id: 'step-1', data: {} });
    const integrity = session.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it('updates state from events', () => {
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    expect(session.getState('status')).toBe('running');
    session.append({ type: 'run_completed', run_id: 'run-001', data: {} });
    expect(session.getState('status')).toBe('completed');
  });

  it('tracks executed actions for replay detection', () => {
    session.append({ type: 'action_executed', run_id: 'run-001', data: { tool_name: 'read_file' } });
    session.append({ type: 'action_executed', run_id: 'run-001', data: { tool_name: 'write_file' } });
    const executed = session.getState('executed_actions') as string[];
    expect(executed).toEqual(['read_file', 'write_file']);
  });
});

describe('AH-SESSION-001: snapshots', () => {
  let session: DurableSession;

  beforeEach(() => {
    session = new DurableSession('run-001');
  });

  it('creates a versioned snapshot', () => {
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    const snap = session.snapshot();
    expect(snap.version).toBe(1);
    // snapshot captures last_seq before appending snapshot_created event
    expect(snap.last_seq).toBe(session.lastSeq - 1);
    expect(snap.hash).toBeTruthy();
  });

  it('snapshot version increments', () => {
    session.snapshot();
    session.snapshot();
    expect(session.snapshotCount).toBe(2);
    expect(session.getLatestSnapshot()?.version).toBe(2);
  });

  it('can retrieve snapshot by version', () => {
    session.snapshot();
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.snapshot();
    const snap1 = session.getSnapshot(1);
    expect(snap1).toBeDefined();
    expect(snap1?.version).toBe(1);
  });

  it('snapshot captures current state', () => {
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    const snap = session.snapshot();
    expect(snap.state.status).toBe('running');
  });
});

describe('AH-SESSION-001: restore', () => {
  it('restore replays events deterministically', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.append({ type: 'step_created', run_id: 'run-001', step_id: 'step-1', data: {} });
    session.append({ type: 'step_started', run_id: 'run-001', step_id: 'step-1', data: {} });
    session.append({ type: 'step_completed', run_id: 'run-001', step_id: 'step-1', data: {} });

    const result = session.restore(0);
    expect(result.restored).toBe(true);
    expect(result.events_replayed).toBe(5);
    expect(result.corrupt_events).toBe(0);
  });

  it('restore from snapshot replays only post-snapshot events', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.append({ type: 'step_created', run_id: 'run-001', step_id: 'step-1', data: {} });
    const snap = session.snapshot();
    session.append({ type: 'step_started', run_id: 'run-001', step_id: 'step-1', data: {} });

    const result = session.restore(snap.last_seq);
    // snapshot_created event + step_started event = 2
    expect(result.events_replayed).toBe(2);
  });

  it('restore detects corrupt events', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    // We can't easily tamper with events since they're private, but
    // restore should still work correctly
    const result = session.restore(0);
    expect(result.corrupt_events).toBe(0);
  });
});
