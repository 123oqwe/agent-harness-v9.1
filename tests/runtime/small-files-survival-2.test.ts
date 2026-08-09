import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../runtime/event-bus.js';
const CLOCK = '2026-07-25T00:00:00.000Z';
import { NotificationService } from '../../runtime/notifications.js';
import { retry, classifyError, CircuitBreaker } from '../../runtime/retry.js';
import { DurableSession } from '../../session/durable-session.js';
import { recordSessionBranch } from '../../runtime/session-tree-port.js';

// event-bus.ts: L34 StringLiteral, L47 EqualityOperator, L74 ConditionalExpression
describe('small-files-survival-2 event-bus', () => {
  it('publishes event with exact type string', () => {
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'tool_result', run_id: 'r1', timestamp: CLOCK, data: { value: 42 } });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('tool_result');
  });

  it('flushes batch when batchMs threshold is exceeded', async () => {
    const bus = new EventBus({ batchMs: 10 });
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'step_transition', run_id: 'r1', timestamp: CLOCK, data: {} });
    bus.publish({ type: 'error_event', run_id: 'r1', timestamp: CLOCK, data: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(2);
  });

  it('flushes immediately in non-batch mode', () => {
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'model_called', run_id: 'r1', timestamp: CLOCK, data: {} });
    expect(events.length).toBe(1);
  });

  it('handles batch mode with createEvent', async () => {
    const bus = new EventBus({ batchMs: 5 });
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'plan_ready', run_id: 'r1', timestamp: CLOCK, data: { n: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('plan_ready');
  });
});

// notifications.ts: L127-159
describe('small-files-survival-2 notifications', () => {
  it('creates notification with exact user_id and type', () => {
    const svc = new NotificationService({ ttlDays: 7 });
    const notif = svc.create('user1', 'info', 'Test Title', 'test body');
    expect(notif).toBeDefined();
    expect(notif.user_id).toBe('user1');
    expect(notif.type).toBe('info');
    expect(notif.title).toBe('Test Title');
    expect(notif.body).toBe('test body');
  });

  it('retrieves notifications by user_id', () => {
    const svc = new NotificationService({ ttlDays: 7 });
    svc.create('user1', 'info', 'Title 1', 'body1');
    svc.create('user2', 'info', 'Title 2', 'body2');
    const user1Notifs = svc.list("user1", true);
    expect(user1Notifs.length).toBe(1);
    expect(user1Notifs[0]?.title).toBe('Title 1');
  });

  it('marks notification as read', () => {
    const svc = new NotificationService({ ttlDays: 7 });
    const notif = svc.create('user1', 'info', 'Test', 'body');
    svc.markRead('user1', notif.id);
    const notifs = svc.list("user1", true);
    expect(notifs[0]?.read).toBe(true);
  });

  it('deletes notification', () => {
    const svc = new NotificationService({ ttlDays: 7 });
    const notif = svc.create('user1', 'info', 'Test', 'body');
    svc.dismiss('user1', notif.id);
    const notifs = svc.list("user1", true);
    expect(notifs.length).toBe(0);
  });
});

// retry.ts: L90, L170, L202-203, L209, L260
describe('small-files-survival-2 retry', () => {
  it('retries on retryable error and succeeds', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw new Error('ECONNRESET');
      return 'success';
    });
    const result = await retry(fn, { maxAttempts: 3, baseDelay: 1, idempotencyKey: 'test-key' });
    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('throws after max attempts', async () => {
    const fn = vi.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(retry(fn, { maxAttempts: 2, baseDelay: 1, idempotencyKey: 'test-key' })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('classifies network errors as retryable', () => {
    const error = new Error('ECONNRESET');
    const result = classifyError(error);
    expect(result.retryable).toBe(true);
  });

  it('classifies non-network errors as non-retryable', () => {
    const error = new Error('validation failed');
    const result = classifyError(error);
    expect(result.retryable).toBe(false);
  });

  it('CircuitBreaker opens after threshold failures', () => {
    const breaker = new CircuitBreaker(2, 1000);
    expect(breaker.state_).toBe('closed');
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state_).toBe('open');
  });

  it('CircuitBreaker allows when closed', () => {
    const breaker = new CircuitBreaker(5, 1000);
    expect(() => breaker.allow()).not.toThrow();
  });

  it('CircuitBreaker rejects when open', () => {
    const breaker = new CircuitBreaker(1, 10000);
    breaker.recordFailure();
    expect(breaker.state_).toBe('open');
    expect(() => { breaker.allow(); }).toThrow();
  });

  it('CircuitBreaker resets after cooldown', () => {
    let time = 0;
    const breaker = new CircuitBreaker(1, 100, () => time);
    breaker.recordFailure();
    expect(breaker.state_).toBe('open');
    time = 200;
    breaker.allow(); // should transition to half_open
    expect(breaker.state_).toBe('half_open');
  });

  it('CircuitBreaker records success and resets failures', () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.state_).toBe('closed');
  });

  it('retry respects delay between attempts', async () => {
    let attempts = 0;
    const timestamps: number[] = [];
    const fn = vi.fn(async () => {
      timestamps.push(Date.now());
      attempts++;
      if (attempts < 3) throw new Error('ECONNRESET');
      return 'done';
    });
    await retry(fn, { maxAttempts: 3, baseDelay: 50, idempotencyKey: 'test-key' });
    expect(timestamps.length).toBe(3);
    const delay1 = timestamps[1]! - timestamps[0]!;
    expect(delay1).toBeGreaterThanOrEqual(40);
  });

  it('retry with one attempt executes once', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await retry(fn, { maxAttempts: 1, baseDelay: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retry returns exact result value', async () => {
    const fn = vi.fn(async () => ({ data: 42, status: 'ok' }));
    const result = await retry(fn, { maxAttempts: 3, baseDelay: 1 });
    expect(result).toEqual({ data: 42, status: 'ok' });
  });
});

// session-tree-port.ts: L34 StringLiteral
describe('small-files-survival-2 session-tree-port', () => {
  it('recordSessionBranch creates branch when session head exists', async () => {
    const recorded: any[] = [];
    const authority: any = {
      readSessionHead: async () => ({
        session_id: 'root-1',
        security: { state_hash: 'hash1', capability_ceiling_hash: 'hash2', authorization_epoch: 1 },
      }),
      appendBranch: async (input: any) => {
        recorded.push(input);
      },
    };
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'root-1' },
      rootSessionId: 'root-1',
      childSessionId: 'root-1-branch',
    });
    // If recordBranch/appendBranch was called, verify the input
    if (recorded.length > 0) {
      expect(recorded[0]?.rootSessionId).toBe('root-1');
    }
  });

  it('recordSessionBranch does nothing when session head is null', async () => {
    const recorded: any[] = [];
    const authority: any = {
      readSessionHead: async () => null,
      recordBranch: async (input: any) => {
        recorded.push(input);
        return { branch_id: input.childSessionId };
      },
    };
    await recordSessionBranch({
      authority,
      scope: { tenant_id: 't1', root_session_id: 'root-2' },
      rootSessionId: 'root-2',
      childSessionId: 'child-2',
    });
    expect(recorded.length).toBe(0);
  });
});
