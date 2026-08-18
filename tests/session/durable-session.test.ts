import { describe, it, expect } from 'vitest';
import { DurableSession, SessionError, type SessionPersistencePort } from '../../session/durable-session.js';

describe('DurableSession', () => {
  it('creates with a valid session_id', () => {
    const s = new DurableSession('session-1');
    expect(s.session_id).toBe('session-1');
    expect(s.eventCount()).toBe(0);
  });

  it('throws on empty session_id', () => {
    expect(() => new DurableSession('')).toThrow(SessionError);
    expect(() => new DurableSession('  ')).toThrow(SessionError);
  });

  it('acquireWriter and releaseWriter work', () => {
    const s = new DurableSession('s1');
    s.acquireWriter('owner-1');
    s.releaseWriter('owner-1');
    // Can re-acquire
    s.acquireWriter('owner-2');
    s.releaseWriter('owner-2');
  });

  it('acquireWriter throws when already held by another owner', () => {
    const s = new DurableSession('s1');
    s.acquireWriter('owner-1');
    expect(() => s.acquireWriter('owner-2')).toThrow(SessionError);
  });

  it('acquireWriter is idempotent for same owner', () => {
    const s = new DurableSession('s1');
    s.acquireWriter('owner-1');
    expect(() => s.acquireWriter('owner-1')).not.toThrow();
  });

  it('releaseWriter throws when held by different owner', () => {
    const s = new DurableSession('s1');
    s.acquireWriter('owner-1');
    expect(() => s.releaseWriter('owner-2')).toThrow(SessionError);
  });

  it('releaseWriter does nothing when no lock held', () => {
    const s = new DurableSession('s1');
    expect(() => s.releaseWriter()).not.toThrow();
  });

  it('append requires writer lock', () => {
    const s = new DurableSession('s1');
    expect(() => s.append('user', { content: 'hello' })).toThrow(SessionError);
  });

  it('append creates event with correct seq and hash chain', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    const ev1 = s.append('user', { content: 'first' });
    expect(ev1.seq).toBe(1);
    expect(ev1.prev_hash).toBe('');
    expect(ev1.hash).toBeDefined();
    const ev2 = s.append('assistant', { content: 'response' });
    expect(ev2.seq).toBe(2);
    expect(ev2.prev_hash).toBe(ev1.hash);
  });

  it('append throws on invalid event type', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    expect(() => s.append('invalid_type' as any, {})).toThrow(SessionError);
  });

  it('append throws on non-serializable data', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    const circular: any = {};
    circular.self = circular;
    expect(() => s.append('user', circular)).toThrow(SessionError);
  });

  it('getEvents returns frozen array', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    s.append('user', { content: 'test' });
    const events = s.getEvents();
    expect(Object.isFrozen(events)).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('getEvent returns event by seq', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    s.append('user', { content: 'a' });
    s.append('assistant', { content: 'b' });
    expect(s.getEvent(1)?.type).toBe('user');
    expect(s.getEvent(2)?.type).toBe('assistant');
    expect(s.getEvent(99)).toBeUndefined();
  });

  it('snapshot creates versioned snapshot', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    s.append('user', { content: 'test' });
    const snap = s.snapshot_({ messages: 1 });
    expect(snap.version).toBe(1);
    expect(snap.session_id).toBe('s1');
    expect(snap.last_seq).toBe(1);
    expect(snap.last_hash).toBe(s.getEvent(1)!.hash);
  });

  it('snapshot version increments', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    s.append('user', {});
    const snap1 = s.snapshot_({});
    const snap2 = s.snapshot_({});
    expect(snap2.version).toBe(snap1.version + 1);
  });

  it('getSnapshot returns null initially', () => {
    const s = new DurableSession('s1');
    expect(s.getSnapshot()).toBeNull();
  });

  it('export returns events and snapshot', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    s.append('user', { content: 'test' });
    const exported = s.export_();
    expect(exported.session_id).toBe('s1');
    expect(exported.events).toHaveLength(1);
    expect(exported.snapshot).toBeNull();
  });

  it('import_ rebuilds from exported data', () => {
    const s1 = new DurableSession('s1');
    s1.acquireWriter();
    s1.append('user', { content: 'test' });
    s1.append('assistant', { content: 'reply' });
    const exported = s1.export_();
    const s2 = DurableSession.import_(exported);
    expect(s2.session_id).toBe('s1');
    expect(s2.eventCount()).toBe(2);
    expect(s2.getEvent(1)?.data).toEqual({ content: 'test' });
  });

  it('import_ detects hash chain break', () => {
    const s1 = new DurableSession('s1');
    s1.acquireWriter();
    s1.append('user', { content: 'test' });
    const exported = s1.export_();
    // Tamper with hash
    exported.events[0]!.hash = 'tampered';
    expect(() => DurableSession.import_(exported)).toThrow(SessionError);
  });

  it('import_ detects non-contiguous sequence', () => {
    const exported = {
      session_id: 's1',
      events: [
        { seq: 1, type: 'user', timestamp: 't1', data: {}, hash: 'h1', prev_hash: '' },
        { seq: 5, type: 'user', timestamp: 't2', data: {}, hash: 'h2', prev_hash: 'h1' },
      ],
      snapshot: null,
    };
    expect(() => DurableSession.import_(exported as any)).toThrow(SessionError);
  });

  it('import_ detects prev_hash mismatch', () => {
    const s1 = new DurableSession('s1');
    s1.acquireWriter();
    s1.append('user', { content: 'a' });
    s1.append('user', { content: 'b' });
    const exported = s1.export_();
    // Tamper with prev_hash of second event
    exported.events[1]!.prev_hash = 'wrong';
    // Recompute hash to pass hash chain check but fail prev_hash check
    exported.events[1]!.hash = require('node:crypto').createHash('sha256')
      .update(JSON.stringify({ seq: 2, type: 'user', timestamp: exported.events[1]!.timestamp, data: { content: 'b' }, prev_hash: 'wrong' }))
      .digest('hex').slice(0, 16);
    expect(() => DurableSession.import_(exported as any)).toThrow(SessionError);
  });

  it('import_ rejects a fractional snapshot last_seq with a clean SessionError, not a TypeError', () => {
    // Defensive `?.` on the snapshot hash lookup must turn a malformed
    // (non-integer) last_seq into a SessionError. Without it, the direct
    // index read throws TypeError instead of a typed error.
    const s1 = new DurableSession('s1');
    s1.acquireWriter();
    s1.append('user', { content: 'test' });
    const bad = {
      session_id: 's1',
      events: s1.getEvents(),
      snapshot: { session_id: 's1', version: 1, last_seq: 0.5, last_hash: 'corrupt' },
    };
    expect(() => DurableSession.import_(bad as any)).toThrow(SessionError);
  });

  it('restore is alias for import_', () => {
    const s1 = new DurableSession('s1');
    s1.acquireWriter();
    s1.append('user', { content: 'test' });
    const exported = s1.export_();
    const s2 = DurableSession.restore(exported);
    expect(s2.eventCount()).toBe(1);
  });

  it('resumeFrom returns next seq number', () => {
    const s = new DurableSession('s1');
    s.acquireWriter();
    s.append('user', {});
    s.append('assistant', {});
    expect(s.resumeFrom()).toBe(3);
  });

  it('uses custom clock', () => {
    let clockVal = '2026-01-01T00:00:00Z';
    const s = new DurableSession('s1', { clock: () => clockVal });
    s.acquireWriter();
    const ev = s.append('user', { content: 'test' });
    expect(ev.timestamp).toBe(clockVal);
    clockVal = '2026-06-01T12:00:00Z';
    const ev2 = s.append('user', { content: 'test2' });
    expect(ev2.timestamp).toBe('2026-06-01T12:00:00Z');
  });

  it('persistence port receives events', () => {
    const appended: any[] = [];
    const persistence: SessionPersistencePort = {
      appendEvent(_id, ev) { appended.push(ev); },
    };
    const s = new DurableSession('s1', { persistence });
    s.acquireWriter();
    s.append('user', { content: 'test' });
    expect(appended).toHaveLength(1);
    expect(appended[0].type).toBe('user');
  });

  it('persistence port receives snapshots', () => {
    const snapshots: any[] = [];
    const persistence: SessionPersistencePort = {
      appendEvent() {},
      saveSnapshot(_id, snap) { snapshots.push(snap); },
    };
    const s = new DurableSession('s1', { persistence });
    s.acquireWriter();
    s.append('user', {});
    s.snapshot_({ count: 1 });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].version).toBe(1);
  });

  it('EVENT_TYPES has 11 types', () => {
    expect(DurableSession.EVENT_TYPES).toHaveLength(11);
    expect(DurableSession.EVENT_TYPES).toContain('user');
    expect(DurableSession.EVENT_TYPES).toContain('assistant');
    expect(DurableSession.EVENT_TYPES).toContain('tool_call');
    expect(DurableSession.EVENT_TYPES).toContain('tool_result');
    expect(DurableSession.EVENT_TYPES).toContain('compaction');
    expect(DurableSession.EVENT_TYPES).toContain('branch');
    expect(DurableSession.EVENT_TYPES).toContain('fork');
    expect(DurableSession.EVENT_TYPES).toContain('steer');
    expect(DurableSession.EVENT_TYPES).toContain('system');
    expect(DurableSession.EVENT_TYPES).toContain('error');
    expect(DurableSession.EVENT_TYPES).toContain('summary');
  });
});
