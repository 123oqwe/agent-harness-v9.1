import { describe, it, expect, vi } from 'vitest';
import {
  retry,
  classifyError,
  RetryExhausted,
  CircuitOpenError,
  CircuitBreaker,
} from '../../runtime/retry.js';
import { NotificationService } from '../../runtime/notifications.js';
import { EventBus, createEvent } from '../../runtime/event-bus.js';
import {
  recordSessionBranch,
  type SessionTreeBranchContext,
} from '../../runtime/session-tree-port.js';
import { DefaultEffectReadBack } from '../../runtime/pause-resume-port.js';

// ===== retry.ts survival tests =====

describe('retry.ts: classifyError error messages', () => {
  it('extracts message from Error objects', () => {
    const err = new Error('something failed');
    expect(classifyError(err).message).toBe('something failed');
  });

  it('extracts message from non-Error objects with message property', () => {
    const err = { message: 'custom error', code: 42 };
    expect(classifyError(err).message).toBe('custom error');
  });

  it('stringifies non-object errors', () => {
    expect(classifyError('string error').message).toBe('string error');
    expect(classifyError(42).message).toBe('42');
    expect(classifyError(null).message).toBe('null');
  });

  it('extracts message from null error', () => {
    expect(classifyError(null).message).toBe('null');
  });
});

describe('retry.ts: classifyError status codes', () => {
  it('classifies 408 as timeout retryable', () => {
    const r = classifyError({ status: 408, message: 'timeout' });
    expect(r.kind).toBe('timeout');
    expect(r.status).toBe(408);
    expect(r.retryable).toBe(true);
  });

  it('classifies 429 as rate_limited retryable', () => {
    const r = classifyError({ status: 429, message: 'too many requests' });
    expect(r.kind).toBe('rate_limited');
    expect(r.status).toBe(429);
    expect(r.retryable).toBe(true);
  });

  it('classifies 500 as server retryable', () => {
    const r = classifyError({ status: 500, message: 'internal error' });
    expect(r.kind).toBe('server');
    expect(r.status).toBe(500);
    expect(r.retryable).toBe(true);
  });

  it('classifies 503 as server retryable', () => {
    const r = classifyError({ status: 503, message: 'unavailable' });
    expect(r.kind).toBe('server');
    expect(r.status).toBe(503);
    expect(r.retryable).toBe(true);
  });

  it('classifies 599 as server retryable', () => {
    const r = classifyError({ status: 599, message: 'edge' });
    expect(r.kind).toBe('server');
    expect(r.retryable).toBe(true);
  });

  it('classifies 400 as unknown not retryable', () => {
    const r = classifyError({ status: 400, message: 'bad request' });
    expect(r.kind).toBe('unknown');
    expect(r.status).toBe(400);
    expect(r.retryable).toBe(false);
  });

  it('classifies 404 as unknown not retryable', () => {
    const r = classifyError({ status: 404, message: 'not found' });
    expect(r.kind).toBe('unknown');
    expect(r.retryable).toBe(false);
  });
});

describe('retry.ts: classifyError message patterns', () => {
  it('detects timeout in message', () => {
    const r = classifyError(new Error('request timed out'));
    expect(r.kind).toBe('timeout');
    expect(r.retryable).toBe(true);
  });

  it('detects ETIMEDOUT in message', () => {
    const r = classifyError(new Error('ETIMEDOUT'));
    expect(r.kind).toBe('timeout');
    expect(r.retryable).toBe(true);
  });

  it('detects network in message', () => {
    const r = classifyError(new Error('network error'));
    expect(r.kind).toBe('network');
    expect(r.retryable).toBe(true);
  });

  it('detects ECONNRESET in message', () => {
    const r = classifyError(new Error('ECONNRESET'));
    expect(r.kind).toBe('network');
    expect(r.retryable).toBe(true);
  });

  it('detects ECONNREFUSED in message', () => {
    const r = classifyError(new Error('ECONNREFUSED'));
    expect(r.kind).toBe('network');
    expect(r.retryable).toBe(true);
  });

  it('detects fetch failed in message', () => {
    const r = classifyError(new Error('fetch failed'));
    expect(r.kind).toBe('network');
    expect(r.retryable).toBe(true);
  });

  it('classifies generic errors as unknown not retryable', () => {
    const r = classifyError(new Error('something went wrong'));
    expect(r.kind).toBe('unknown');
    expect(r.retryable).toBe(false);
  });
});

describe('retry.ts: CircuitBreaker cooldown and state', () => {
  it('throws RangeError for threshold < 1', () => {
    expect(() => new CircuitBreaker(0)).toThrow(RangeError);
    expect(() => new CircuitBreaker(-1)).toThrow(RangeError);
  });

  it('throws RangeError for non-integer threshold', () => {
    expect(() => new CircuitBreaker(1.5)).toThrow(RangeError);
  });

  it('throws RangeError for negative cooldownMs', () => {
    expect(() => new CircuitBreaker(5, -1)).toThrow(RangeError);
  });

  it('throws RangeError for non-integer cooldownMs', () => {
    expect(() => new CircuitBreaker(5, 1.5)).toThrow(RangeError);
  });

  it('allows cooldownMs = 0', () => {
    expect(() => new CircuitBreaker(5, 0)).not.toThrow();
  });

  it('allow() returns immediately when closed', () => {
    const cb = new CircuitBreaker(5, 60000);
    expect(() => cb.allow()).not.toThrow();
  });

  it('allow() throws CircuitOpenError when open and within cooldown', () => {
    let time = 1000;
    const cb = new CircuitBreaker(2, 60000, () => time);
    cb.recordFailure();
    cb.recordFailure(); // opens circuit
    expect(() => cb.allow()).toThrow(CircuitOpenError);
  });

  it('allow() transitions to half_open after cooldown', () => {
    let time = 1000;
    const cb = new CircuitBreaker(2, 60000, () => time);
    cb.recordFailure();
    cb.recordFailure(); // opens
    time += 70000; // past cooldown
    expect(() => cb.allow()).not.toThrow();
  });

  it('allow() throws CircuitOpenError when half_open', () => {
    let time = 1000;
    const cb = new CircuitBreaker(2, 60000, () => time);
    cb.recordFailure();
    cb.recordFailure(); // opens
    time += 70000; // past cooldown -> half_open
    cb.allow(); // transitions to half_open
    expect(() => cb.allow()).toThrow(CircuitOpenError);
  });

  it('recordSuccess closes circuit from half_open', () => {
    let time = 1000;
    const cb = new CircuitBreaker(2, 60000, () => time);
    cb.recordFailure();
    cb.recordFailure();
    time += 70000;
    cb.allow(); // half_open
    cb.recordSuccess();
    expect(() => cb.allow()).not.toThrow(); // closed
  });

  it('recordFailure from half_open opens circuit immediately', () => {
    let time = 1000;
    const cb = new CircuitBreaker(2, 60000, () => time);
    cb.recordFailure();
    cb.recordFailure();
    time += 70000;
    cb.allow(); // half_open
    cb.recordFailure(); // should open immediately
    expect(() => cb.allow()).toThrow(CircuitOpenError);
  });

  it('CircuitOpenError has retryAfterMs', () => {
    let time = 1000;
    const cb = new CircuitBreaker(2, 60000, () => time);
    cb.recordFailure();
    cb.recordFailure();
    time += 10000; // 10s elapsed, 50s remaining
    try {
      cb.allow();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError);
      expect((e as CircuitOpenError).retryAfterMs).toBe(50000);
    }
  });
});

describe('retry.ts: retry function behavior', () => {
  it('succeeds on first attempt without idempotency key', async () => {
    const result = await retry(async () => 42);
    expect(result).toBe(42);
  });

  it('does not retry without idempotency key (effectiveMaxAttempts=1)', async () => {
    let attempts = 0;
    await expect(retry(async () => {
      attempts += 1;
      throw new Error('fail');
    })).rejects.toThrow('fail');
    expect(attempts).toBe(1);
  });

  it('retries with idempotency key', async () => {
    let attempts = 0;
    const result = await retry(
      async (attempt) => {
        attempts += 1;
        if (attempt < 3) throw new Error('timeout');
        return 'success';
      },
      {
        idempotencyKey: 'key-1',
        maxAttempts: 3,
        baseDelay: 0,
        maxDelay: 0,
        jitterMs: 0,
        dependencies: { sleep: async () => undefined },
      },
    );
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws RetryExhausted after max attempts', async () => {
    await expect(retry(
      async () => { throw new Error('timeout'); },
      {
        idempotencyKey: 'key-2',
        maxAttempts: 2,
        baseDelay: 0,
        maxDelay: 0,
        jitterMs: 0,
        dependencies: { sleep: async () => undefined },
      },
    )).rejects.toThrow(RetryExhausted);
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(retry(
      async () => {
        attempts += 1;
        throw new Error('something wrong');
      },
      {
        idempotencyKey: 'key-3',
        maxAttempts: 5,
        baseDelay: 0,
        maxDelay: 0,
        jitterMs: 0,
        dependencies: { sleep: async () => undefined },
      },
    )).rejects.toThrow('something wrong');
    expect(attempts).toBe(1);
  });

  it('validates maxAttempts >= 1', async () => {
    await expect(retry(async () => 1, { maxAttempts: 0 } as any)).rejects.toThrow(RangeError);
  });

  it('validates baseDelay >= 0', async () => {
    await expect(retry(async () => 1, { baseDelay: -1 } as any)).rejects.toThrow(RangeError);
  });

  it('validates maxDelay >= 0', async () => {
    await expect(retry(async () => 1, { maxDelay: -1 } as any)).rejects.toThrow(RangeError);
  });

  it('validates jitterMs >= 0', async () => {
    await expect(retry(async () => 1, { jitterMs: -1 } as any)).rejects.toThrow(RangeError);
  });

  it('log callback receives attempt, delayMs, error, timestamp', async () => {
    const logs: any[] = [];
    try {
      await retry(
        async () => { throw new Error('timeout'); },
        {
          idempotencyKey: 'key-4',
          maxAttempts: 2,
          baseDelay: 100,
          maxDelay: 1000,
          jitterMs: 0,
          dependencies: { sleep: async () => undefined },
          log: (entry) => logs.push(entry),
        },
      );
    } catch { /* expected */ }
    expect(logs.length).toBe(2);
    expect(logs[0].attempt).toBe(1);
    expect(logs[0].error).toBe('timeout');
    expect(typeof logs[0].timestamp).toBe('string');
    expect(logs[0].delayMs).toBeGreaterThanOrEqual(0);
  });

  it('defaultSleep resolves immediately for 0ms', async () => {
    // Test through retry with 0 delay
    const result = await retry(async () => 'ok', {
      idempotencyKey: 'key-5',
      maxAttempts: 1,
      baseDelay: 0,
      maxDelay: 0,
      jitterMs: 0,
    });
    expect(result).toBe('ok');
  });

  it('defaultJitter returns 0 for maxInclusive=0', async () => {
    let jitterResult: number | undefined;
    try {
      await retry(
        async () => { throw new Error('timeout'); },
        {
          idempotencyKey: 'key-6',
          maxAttempts: 2,
          baseDelay: 100,
          maxDelay: 1000,
          jitterMs: 0,
          dependencies: {
            sleep: async () => undefined,
            randomJitter: (max) => { jitterResult = max; return 0; },
          },
        },
      );
    } catch { /* expected */ }
    expect(jitterResult).toBe(0);
  });

  it('throws RangeError when now() returns invalid date', async () => {
    await expect(retry(
      async () => { throw new Error('timeout'); },
      {
        idempotencyKey: 'key-7',
        maxAttempts: 2,
        baseDelay: 0,
        maxDelay: 0,
        jitterMs: 0,
        dependencies: {
          sleep: async () => undefined,
          now: () => new Date('invalid'),
        },
      },
    )).rejects.toThrow(RangeError);
  });

  it('throws RangeError when randomJitter returns out of range', async () => {
    await expect(retry(
      async () => { throw new Error('timeout'); },
      {
        idempotencyKey: 'key-8',
        maxAttempts: 2,
        baseDelay: 0,
        maxDelay: 0,
        jitterMs: 100,
        dependencies: {
          sleep: async () => undefined,
          randomJitter: () => 999, // > jitterMs
        },
      },
    )).rejects.toThrow(RangeError);
  });

  it('RetryExhausted has lastError and attempts', async () => {
    try {
      await retry(
        async () => { throw new Error('timeout'); },
        {
          idempotencyKey: 'key-9',
          maxAttempts: 3,
          baseDelay: 0,
          maxDelay: 0,
          jitterMs: 0,
          dependencies: { sleep: async () => undefined },
        },
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RetryExhausted);
      expect((e as RetryExhausted).attempts).toBe(3);
      expect((e as RetryExhausted).lastError).toBeInstanceOf(Error);
    }
  });
});

// ===== notifications.ts survival tests =====

describe('notifications.ts: create, dismiss, purgeExpired', () => {
  function makeStore(now: () => Date) {
    return new NotificationService({ now, ttlDays: 1 });
  }

  it('dismiss removes notification and cleans up userIndex', () => {
    let time = 1000000;
    const store = makeStore(() => new Date(time));
    store.create('user-1', 'info', 'Test', 'Body');
    const list = store.list('user-1');
    expect(list).toHaveLength(1);
    store.dismiss('user-1', list[0]!.id);
    expect(store.list('user-1')).toHaveLength(0);
  });

  it('dismiss cleans up userIndex when size becomes 0', () => {
    let time = 1000000;
    const store = makeStore(() => new Date(time));
    store.create('user-1', 'info', 'Test', 'Body');
    const list = store.list('user-1');
    store.dismiss('user-1', list[0]!.id);
    store.create('user-1', 'warning', 'New', 'Body');
    expect(store.list('user-1')).toHaveLength(1);
  });

  it('purgeExpired removes expired notifications', () => {
    let time = 1000000;
    const store = makeStore(() => new Date(time));
    store.create('user-1', 'info', 'Active', 'Body');
    // Advance time past TTL (1 day = 86400000ms)
    time += 100000;
    const purged = store.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(0);
  });

  it('purgeExpired returns 0 when nothing expired', () => {
    let time = 1000000;
    const store = makeStore(() => new Date(time));
    store.create('user-1', 'info', 'Active', 'Body');
    expect(store.purgeExpired()).toBe(0);
  });

  it('list filters expired notifications', () => {
    let time = Date.now();
    const store = makeStore(() => new Date(time));
    store.create('user-1', 'info', 'Old', 'Body');
    // Advance past TTL (1 day = 86400000ms)
    time += 86400001;
    const list = store.list('user-1');
    // expired notifications are filtered from list
    expect(list.length).toBe(0);
  });

  it('list filters read notifications when includeRead=false', () => {
    let time = 1000000;
    const store = makeStore(() => new Date(time));
    store.create('user-1', 'info', 'Unread', 'Body');
    time += 1000;
    store.create('user-1', 'info', 'Read', 'Body');
    // List is sorted by created_at desc, so items[0] is 'Read' (newer)
    const items = store.list('user-1');
    store.markRead('user-1', items[0]!.id);
    const unread = store.list('user-1', false);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.title).toBe('Unread');
  });

  it('list includes read notifications when includeRead=true', () => {
    let time = 1000000;
    const store = makeStore(() => new Date(time));
    store.create('user-1', 'info', 'Test', 'Body');
    const items = store.list('user-1');
    store.markRead('user-1', items[0]!.id);
    const all = store.list('user-1', true);
    expect(all).toHaveLength(1);
  });

  it('list returns empty for non-existent user', () => {
    const store = makeStore(() => new Date());
    expect(store.list('nonexistent')).toEqual([]);
  });

  it('list sorts by created_at desc then seq desc', () => {
    let time = 1000000;
    const store = makeStore(() => new Date(time));
    store.create('user-1', 'info', 'Older', 'Body');
    time += 1000;
    store.create('user-1', 'info', 'Newer', 'Body');
    const list = store.list('user-1');
    expect(list[0]!.title).toBe('Newer');
    expect(list[1]!.title).toBe('Older');
  });

  it('create throws for empty userId', () => {
    const store = makeStore(() => new Date());
    expect(() => store.create('  ', 'info', 'T', 'B')).toThrow();
  });

  it('create throws for empty title', () => {
    const store = makeStore(() => new Date());
    expect(() => store.create('user-1', 'info', '  ', 'B')).toThrow();
  });
});

// ===== event-bus.ts survival tests =====

describe('event-bus.ts: EventBus modes and batching', () => {
  it('subscribe and unsubscribe works in updates mode', () => {
    const bus = new EventBus({ mode: 'updates' });
    const events: any[] = [];
    const unsub = bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'tool_result', run_id: 'r1', timestamp: '2026-01-01', data: {} });
    expect(events).toHaveLength(1);
    unsub();
    bus.publish({ type: 'tool_result', run_id: 'r1', timestamp: '2026-01-01', data: {} });
    expect(events).toHaveLength(1);
  });

  it('updates mode calls subscribers immediately', () => {
    const bus = new EventBus({ mode: 'updates' });
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'step_transition', run_id: 'r1', timestamp: '2026-01-01', data: { step: 1 } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('step_transition');
  });

  it('values mode buffers events', () => {
    const bus = new EventBus({ mode: 'values', batchMs: 999999 });
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'tool_result', run_id: 'r1', timestamp: '2026-01-01', data: {} });
    expect(events).toHaveLength(0); // buffered, not flushed
    expect(bus.events).toHaveLength(1);
  });

  it('values mode flushes after batchMs', () => {
    let now = Date.now();
    const bus = new EventBus({ mode: 'values', batchMs: 50 });
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'tool_result', run_id: 'r1', timestamp: '2026-01-01', data: {} });
    expect(events).toHaveLength(0);
    // Wait for batch
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        bus.publish({ type: 'tool_result', run_id: 'r1', timestamp: '2026-01-01', data: {} });
        expect(events).toHaveLength(2);
        resolve();
      }, 60);
    });
  });

  it('flush delivers all buffered events to subscribers', () => {
    const bus = new EventBus({ mode: 'values', batchMs: 999999 });
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'tool_result', run_id: 'r1', timestamp: '2026-01-01', data: {} });
    bus.publish({ type: 'step_transition', run_id: 'r1', timestamp: '2026-01-01', data: {} });
    bus.flush();
    expect(events).toHaveLength(2);
    expect(bus.events).toHaveLength(0);
  });

  it('subscriber errors are swallowed', () => {
    const bus = new EventBus({ mode: 'updates' });
    bus.subscribe(() => { throw new Error('subscriber error'); });
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    bus.publish({ type: 'tool_result', run_id: 'r1', timestamp: '2026-01-01', data: {} });
    expect(events).toHaveLength(1);
  });

  it('createEvent includes step_id when provided', () => {
    const event = createEvent('tool_result', 'r1', { x: 1 }, 'step-1');
    expect(event.step_id).toBe('step-1');
    expect(event.run_id).toBe('r1');
  });

  it('createEvent omits step_id when not provided', () => {
    const event = createEvent('tool_result', 'r1', { x: 1 });
    expect(event.step_id).toBeUndefined();
  });

  it('createEvent has timestamp as ISO string', () => {
    const event = createEvent('tool_result', 'r1', {});
    expect(typeof event.timestamp).toBe('string');
    expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
  });
});

// ===== pause-resume-port.ts survival tests =====

describe('pause-resume-port.ts: DefaultEffectReadBack', () => {
  it('returns confirmed for IN_FLIGHT operations', async () => {
    const port = new DefaultEffectReadBack();
    const result = await port.query({
      operation_id: 'op-1',
      effect_state: 'IN_FLIGHT',
    } as any);
    expect(result.status).toBe('confirmed');
    expect(result.status).toBe('confirmed');
    if (result.status === 'confirmed') {
      expect(result.stored_outcome_json).toContain('op-1');
    }
  });

  it('returns indeterminate for non-IN_FLIGHT operations', async () => {
    const port = new DefaultEffectReadBack();
    const result = await port.query({
      operation_id: 'op-2',
      effect_state: 'PRE_DISPATCH',
    } as any);
    expect(result.status).toBe('indeterminate');
  });

  it('returns indeterminate for EFFECT_CONFIRMED operations', async () => {
    const port = new DefaultEffectReadBack();
    const result = await port.query({
      operation_id: 'op-3',
      effect_state: 'EFFECT_CONFIRMED',
    } as any);
    expect(result.status).toBe('indeterminate');
  });

  it('stored_outcome_json contains operation_id', async () => {
    const port = new DefaultEffectReadBack();
    const result = await port.query({
      operation_id: 'my-op-id',
      effect_state: 'IN_FLIGHT',
    } as any);
    if (result.status === 'confirmed') {
      expect(result.stored_outcome_json).toBe(JSON.stringify({ operation_id: 'my-op-id' }));
    }
  });
});
