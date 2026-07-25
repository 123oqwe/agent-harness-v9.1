import { describe, it, expect, beforeEach } from 'vitest';
import { NotificationService, NotificationError } from '../../runtime/notifications.js';

describe('AH-CAPMAP-020 in-app notifications', () => {
  let svc: NotificationService;
  let now: number;
  let id: number;
  beforeEach(() => {
    now = Date.parse('2026-07-25T00:00:00.000Z');
    id = 0;
    svc = new NotificationService({
      ttlDays: 30,
      now: () => new Date(now),
      createId: () => `notification-${++id}`,
    });
  });

  it('POST creates notification with id, user_id, type, title, body, created_at, read=false', () => {
    const n = svc.create('user-1', 'info', 'Title', 'Body');
    expect(n.id).toBeTruthy();
    expect(n.user_id).toBe('user-1');
    expect(n.type).toBe('info');
    expect(n.read).toBe(false);
    expect(n.created_at).toBe('2026-07-25T00:00:00.000Z');
    expect(n.expires_at).toBe('2026-08-24T00:00:00.000Z');
    expect(n.seq).toBe(1);
  });
  it('GET returns unread notifications sorted by created_at desc', () => {
    svc.create('user-1', 'info', 'A', 'a');
    now += 1;
    const b = svc.create('user-1', 'warning', 'B', 'b');
    const list = svc.list('user-1');
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(b.id); // newest first
  });
  it('GET ?include_read=true returns all', () => {
    const n = svc.create('user-1', 'info', 'A', 'a');
    svc.markRead('user-1', n.id);
    expect(svc.list('user-1')).toHaveLength(0);
    expect(svc.list('user-1', true)).toHaveLength(1);
  });
  it('PATCH marks as read', () => {
    const n = svc.create('user-1', 'info', 'A', 'a');
    svc.markRead('user-1', n.id);
    expect(svc.list('user-1', true)[0]!.read).toBe(true);
  });
  it('DELETE dismisses notification', () => {
    const n = svc.create('user-1', 'info', 'A', 'a');
    svc.dismiss('user-1', n.id);
    expect(svc.list('user-1', true)).toHaveLength(0);
  });
  it('notification types: info, warning, error, success, approval_request', () => {
    for (const t of ['info', 'warning', 'error', 'success', 'approval_request'] as const) {
      const n = svc.create('user-1', t, 'T', 'b');
      expect(n.type).toBe(t);
    }
  });
  it('notifications expire after 30 days (configurable)', () => {
    const s = new NotificationService({
      ttlDays: 0,
      now: () => new Date(now),
      createId: () => 'expires-now',
    });
    s.create('user-1', 'info', 'A', 'a');
    expect(s.purgeExpired()).toBe(1);
    expect(s.list('user-1', true)).toHaveLength(0);
    expect(s.purgeExpired()).toBe(0);
  });
  it('no external delivery (no email/push/SMS)', () => {
    const n = svc.create('user-1', 'info', 'A', 'a');
    expect((n as unknown as { email?: unknown }).email).toBeUndefined();
    expect((n as unknown as { push?: unknown }).push).toBeUndefined();
  });
  it('body max 500 chars', () => {
    try {
      svc.create('user-1', 'info', 'T', 'x'.repeat(501));
      expect.fail('expected body limit');
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationError);
      expect((error as NotificationError).name).toBe('NotificationError');
      expect((error as NotificationError).message).toBe(
        'body exceeds 500 chars',
      );
    }
    expect(() => svc.create('user-1', 'info', 'T', 'x'.repeat(500))).not.toThrow();
  });
  it('user can only see their own notifications', () => {
    svc.create('user-1', 'info', 'A', 'a');
    svc.create('user-2', 'info', 'B', 'b');
    expect(svc.list('user-1')).toHaveLength(1);
    expect(svc.list('user-1')[0]!.user_id).toBe('user-1');
  });
  it('notification creation requires authenticated session', () => {
    expect(() => svc.create('', 'info', 'T', 'b')).toThrow(NotificationError);
    expect(() => svc.create('   ', 'info', 'T', 'b')).toThrow(
      'authenticated session required',
    );
  });

  it('rejects invalid configuration, type, title, clock, and IDs', () => {
    expect(() => new NotificationService(-1)).toThrow(
      'ttlDays must be a non-negative number',
    );
    expect(() => new NotificationService(Number.NaN)).toThrow(NotificationError);
    expect(() =>
      svc.create('user-1', 'unknown' as never, 'T', 'b'),
    ).toThrow('unsupported notification type');
    expect(() => svc.create('user-1', 'info', ' ', 'b')).toThrow(
      'title is required',
    );
    const badClock = new NotificationService({
      now: () => new Date(Number.NaN),
      createId: () => 'id',
    });
    expect(() => badClock.create('user-1', 'info', 'T', 'b')).toThrow(
      'clock returned an invalid date',
    );
    const blankId = new NotificationService({ createId: () => ' ' });
    expect(() => blankId.create('user-1', 'info', 'T', 'b')).toThrow(
      'notification id must be non-empty and unique',
    );
    const duplicate = new NotificationService({ createId: () => 'same' });
    duplicate.create('user-1', 'info', 'T', 'b');
    expect(() => duplicate.create('user-1', 'info', 'T', 'b')).toThrow(
      'notification id must be non-empty and unique',
    );
  });

  it('fails closed for cross-user or missing mutation attempts', () => {
    const value = svc.create('user-1', 'info', 'T', 'b');
    expect(() => svc.markRead('user-2', value.id)).toThrow(
      'not found or not owner',
    );
    expect(() => svc.markRead('user-1', 'missing')).toThrow(NotificationError);
    expect(() => svc.dismiss('user-2', value.id)).toThrow(NotificationError);
    expect(() => svc.dismiss('user-1', 'missing')).toThrow(NotificationError);
    expect(svc.list('user-1', true)).toHaveLength(1);
  });

  it('does not expose mutable queue authority', () => {
    const value = svc.create('user-1', 'info', 'T', 'b');
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => {
      (value as { read: boolean }).read = true;
    }).toThrow();
    const listed = svc.list('user-1', true)[0]!;
    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed.read).toBe(false);
    svc.markRead('user-1', value.id);
    expect(value.read).toBe(false);
    expect(svc.list('user-1', true)[0]!.read).toBe(true);
  });

  it('orders equal timestamps by monotonic sequence and removes empty indexes', () => {
    const first = svc.create('user-1', 'info', 'A', 'a');
    const second = svc.create('user-1', 'info', 'B', 'b');
    expect(svc.list('user-1').map((value) => value.id)).toEqual([
      second.id,
      first.id,
    ]);
    svc.dismiss('user-1', first.id);
    svc.dismiss('user-1', second.id);
    expect(svc.list('user-1', true)).toEqual([]);
  });

  it('purges only expired records and keeps other users isolated', () => {
    const expired = svc.create('user-1', 'info', 'A', 'a');
    now += 29 * 86_400_000;
    const live = svc.create('user-2', 'info', 'B', 'b');
    now += 2 * 86_400_000;
    expect(svc.purgeExpired()).toBe(1);
    expect(svc.list('user-1', true)).toEqual([]);
    expect(svc.list('user-2', true).map((value) => value.id)).toEqual([
      live.id,
    ]);
    expect(expired.id).not.toBe(live.id);
  });

  it('excludes a notification at the exact expiration boundary', () => {
    const short = new NotificationService({
      ttlDays: 1,
      now: () => new Date(now),
      createId: () => 'boundary',
    });
    short.create('user-1', 'info', 'A', 'a');
    now += 86_400_000;
    expect(short.list('user-1', true)).toEqual([]);
  });
});
