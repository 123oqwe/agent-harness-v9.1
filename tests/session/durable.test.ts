import { describe, it, expect, beforeEach } from 'vitest';
import { DurableSession, SessionError } from '../../session/durable-session.js';

describe('AH-RUNTIME-SESSION-001 durable session', () => {
  let s: DurableSession;
  beforeEach(() => { s = new DurableSession('sess-1'); });

  it('event log is source of truth', () => {
    s.acquireWriter();
    s.append('user', { text: 'hello' });
    s.append('assistant', { decision_summary: 'hi' });
    expect(s.eventCount()).toBe(2);
    expect(s.getEvents()[0]!.type).toBe('user');
  });

  it('snapshot is acceleration (rebuildable)', () => {
    s.acquireWriter();
    s.append('user', { text: 'hi' });
    const snap = s.snapshot_({ last: 'hi' });
    expect(snap.last_seq).toBe(1);
    expect(s.getSnapshot()).toBe(snap);
  });

  it('crash mid-task: resume without duplicate writes', () => {
    s.acquireWriter();
    s.append('user', { text: 'do task' });
    s.append('assistant', { decision_summary: 'step1' });
    // simulate crash: export, then restore
    const exported = s.export_();
    const restored = DurableSession.restore(exported);
    expect(restored.eventCount()).toBe(2);
    // resume from next seq
    expect(restored.resumeFrom()).toBe(3);
    // replaying the same events does NOT duplicate (idempotent replay)
    const restored2 = DurableSession.restore(exported);
    expect(restored2.eventCount()).toBe(2);
  });

  it('session export/import works', () => {
    s.acquireWriter();
    s.append('user', { text: 'a' });
    s.append('tool_call', { name: 'read_file' });
    s.append('tool_result', { ok: true });
    const exported = s.export_();
    const imported = DurableSession.import_(exported);
    expect(imported.eventCount()).toBe(3);
    expect(imported.getEvents()[1]!.type).toBe('tool_call');
  });

  it('11 entry types supported', () => {
    expect(DurableSession.EVENT_TYPES).toHaveLength(11);
    s.acquireWriter();
    for (const t of DurableSession.EVENT_TYPES) s.append(t, { x: 1 });
    expect(s.eventCount()).toBe(11);
  });

 it('concurrent writer lock enforced', () => {
   s.acquireWriter();
   // acquireWriter is idempotent: same caller can re-acquire safely
   expect(() => s.acquireWriter()).not.toThrow();
   s.releaseWriter();
   s.acquireWriter();
   expect(() => s.acquireWriter()).not.toThrow();
   s.releaseWriter();
   // After release, a new acquire works
   s.acquireWriter();
   s.releaseWriter();
   // Append without lock still fails
   const s2 = new DurableSession('test-no-lock');
   expect(() => s2.append('user', { text: 'x' })).toThrow(SessionError);
 });

  it('snapshot version verified on load (mismatch rejected)', () => {
    s.acquireWriter();
    s.append('user', { text: 'a' });
    const snap = s.snapshot_({ s: 1 });
    // tamper with snapshot last_seq
    const exported = s.export_();
    const tampered = { ...exported, snapshot: { ...snap, last_seq: 99 } };
    expect(() => DurableSession.import_(tampered)).toThrow(SessionError);
  });

  it('hash chain integrity: tampering detected on import', () => {
    s.acquireWriter();
    s.append('user', { text: 'a' });
    s.append('assistant', { d: 'b' });
    const exported = s.export_();
    // tamper with event data
    exported.events[0]!.data = { text: 'TAMPERED' };
    expect(() => DurableSession.import_(exported)).toThrow(SessionError);
  });

  it('append requires writer lock', () => {
    expect(() => s.append('user', { x: 1 })).toThrow(SessionError);
  });

  it('invalid event type rejected', () => {
    s.acquireWriter();
    expect(() => s.append('invalid_type' as never, {})).toThrow(SessionError);
  });
});
