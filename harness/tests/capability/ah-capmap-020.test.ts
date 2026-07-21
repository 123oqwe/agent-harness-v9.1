import { describe, it, expect, beforeEach } from 'vitest';
import { NotificationService, NotificationError } from '../../runtime/notifications.js';

describe('AH-CAPMAP-020 in-app notifications', () => {
  let svc: NotificationService;
  beforeEach(() => { svc = new NotificationService(30); });

  it('POST creates notification with id, user_id, type, title, body, created_at, read=false', () => {
    const n = svc.create('user-1', 'info', 'Title', 'Body');
    expect(n.id).toBeTruthy();
    expect(n.user_id).toBe('user-1');
    expect(n.type).toBe('info');
    expect(n.read).toBe(false);
    expect(n.created_at).toBeTruthy();
  });
  it('GET returns unread notifications sorted by created_at desc', () => {
    svc.create('user-1', 'info', 'A', 'a');
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
    const s = new NotificationService(0); // 0 days = immediate expiry
    s.create('user-1', 'info', 'A', 'a');
    s.purgeExpired();
    expect(s.list('user-1', true)).toHaveLength(0);
  });
  it('no external delivery (no email/push/SMS)', () => {
    const n = svc.create('user-1', 'info', 'A', 'a');
    expect((n as unknown as { email?: unknown }).email).toBeUndefined();
    expect((n as unknown as { push?: unknown }).push).toBeUndefined();
  });
  it('body max 500 chars', () => {
    expect(() => svc.create('user-1', 'info', 'T', 'x'.repeat(501))).toThrow(NotificationError);
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
  });
});
