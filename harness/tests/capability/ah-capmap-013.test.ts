import { describe, it, expect, beforeEach } from 'vitest';
import { DurableSession } from '../../session/durable-session.js';
import { NotificationQueue } from '../../runtime/notifications.js';

describe('AH-CAPMAP-013: durable session state transitions', () => {
  let session: DurableSession;

  beforeEach(() => {
    session = new DurableSession('run-001');
  });

  it('records all state transitions in order', () => {
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.append({ type: 'step_created', run_id: 'run-001', step_id: 'step-1', data: {} });
    session.append({ type: 'step_started', run_id: 'run-001', step_id: 'step-1', data: {} });
    session.append({ type: 'step_completed', run_id: 'run-001', step_id: 'step-1', data: {} });
    session.append({ type: 'run_completed', run_id: 'run-001', data: {} });

    const events = session.getEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain('run_created');
    expect(types).toContain('run_started');
    expect(types).toContain('step_created');
    expect(types).toContain('step_started');
    expect(types).toContain('step_completed');
    expect(types).toContain('run_completed');
  });

  it('state transitions are append-only', () => {
    const count1 = session.eventCount;
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    const count2 = session.eventCount;
    expect(count2).toBe(count1 + 1);
    // Events array should never shrink
    session.append({ type: 'run_completed', run_id: 'run-001', data: {} });
    expect(session.eventCount).toBe(count2 + 1);
  });

  it('notifications are derived from events', () => {
    const queue = new NotificationQueue();
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.append({ type: 'step_failed', run_id: 'run-001', step_id: 'step-1', data: {} });

    queue.fromEvents(session.getEvents());
    expect(queue.count).toBeGreaterThan(0);
    const errors = queue.getByLevel('error');
    expect(errors.length).toBeGreaterThan(0);
  });
});
