import { describe, it, expect } from 'vitest';
import { NotificationService, NotificationError } from '../../runtime/notifications.js';

describe('NotificationService', () => {
  it('creates a notification', () => {
    const ns = new NotificationService();
    const n = ns.create('user1', 'info', 'Title', 'Body text');
    expect(n.id).toBeDefined();
    expect(n.user_id).toBe('user1');
    expect(n.type).toBe('info');
    expect(n.title).toBe('Title');
    expect(n.body).toBe('Body text');
    expect(n.read).toBe(false);
    expect(n.seq).toBe(1);
  });
  it('lists notifications for user', () => {
    const ns = new NotificationService();
    ns.create('user1', 'info', 'T1', 'B1');
    ns.create('user1', 'warning', 'T2', 'B2');
    ns.create('user2', 'info', 'T3', 'B3');
    const list = ns.list('user1');
    expect(list).toHaveLength(2);
  });
  it('list excludes read notifications by default', () => {
    const ns = new NotificationService();
    const n = ns.create('user1', 'info', 'T', 'B');
    ns.markRead('user1', n.id);
    expect(ns.list('user1')).toHaveLength(0);
    expect(ns.list('user1', true)).toHaveLength(1);
  });
  it('markRead throws for non-owner', () => {
    const ns = new NotificationService();
    const n = ns.create('user1', 'info', 'T', 'B');
    expect(() => ns.markRead('user2', n.id)).toThrow(NotificationError);
  });
  it('dismiss removes notification', () => {
    const ns = new NotificationService();
    const n = ns.create('user1', 'info', 'T', 'B');
    ns.dismiss('user1', n.id);
    expect(ns.list('user1')).toHaveLength(0);
  });
  it('dismiss throws for non-owner', () => {
    const ns = new NotificationService();
    const n = ns.create('user1', 'info', 'T', 'B');
    expect(() => ns.dismiss('user2', n.id)).toThrow(NotificationError);
  });
  it('throws on empty user_id', () => {
    const ns = new NotificationService();
    expect(() => ns.create('', 'info', 'T', 'B')).toThrow(NotificationError);
  });
  it('throws on unsupported type', () => {
    const ns = new NotificationService();
    expect(() => ns.create('user1', 'unknown' as any, 'T', 'B')).toThrow(NotificationError);
  });
  it('throws on empty title', () => {
    const ns = new NotificationService();
    expect(() => ns.create('user1', 'info', '', 'B')).toThrow(NotificationError);
  });
  it('throws on body exceeding 500 chars', () => {
    const ns = new NotificationService();
    expect(() => ns.create('user1', 'info', 'T', 'x'.repeat(501))).toThrow(NotificationError);
  });
  it('supports all notification types', () => {
    const ns = new NotificationService();
    for (const type of ['info', 'warning', 'error', 'success', 'approval_request'] as const) {
      const n = ns.create('user1', type, 'T', 'B');
      expect(n.type).toBe(type);
    }
  });
  it('purgeExpired removes expired notifications', () => {
    let time = new Date('2026-01-01T00:00:00Z');
    const ns = new NotificationService({ ttlDays: 1, now: () => time });
    ns.create('user1', 'info', 'T', 'B');
    time = new Date('2026-01-03T00:00:00Z');
    const purged = ns.purgeExpired();
    expect(purged).toBe(1);
    expect(ns.list('user1')).toHaveLength(0);
  });
  it('list returns empty for unknown user', () => {
    const ns = new NotificationService();
    expect(ns.list('unknown')).toEqual([]);
  });
  it('seq increments across notifications', () => {
    const ns = new NotificationService();
    const n1 = ns.create('u1', 'info', 'T', 'B');
    const n2 = ns.create('u1', 'info', 'T', 'B');
    expect(n2.seq).toBe(n1.seq + 1);
  });
  it('notifications are frozen', () => {
    const ns = new NotificationService();
    const n = ns.create('u1', 'info', 'T', 'B');
    expect(Object.isFrozen(n)).toBe(true);
  });
});
