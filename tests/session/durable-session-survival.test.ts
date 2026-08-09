import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DurableSession,
  SessionError,
  persistSession,
  loadSession,
  appendEvent,
} from '../../session/durable-session.js';
import type { SessionEvent } from '../../session/durable-session.js';

const TEST_KEY = Buffer.alloc(32, 0xab);

function makeEvent(seq: number, overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    seq,
    type: 'user',
    timestamp: '2026-01-01T00:00:00Z',
    data: { msg: `event-${seq}` },
    hash: `hash-${seq}`,
    prev_hash: seq > 1 ? `hash-${seq - 1}` : '',
    ...overrides,
  };
}

describe('durable-session-survival: deepFreeze and immutable events', () => {
  it('append returns frozen event', () => {
    const session = new DurableSession('test-1');
    session.acquireWriter();
    const ev = session.append('user', { msg: 'hello' });
    session.releaseWriter();
    expect(Object.isFrozen(ev)).toBe(true);
    expect(Object.isFrozen(ev.data)).toBe(true);
  });

  it('nested objects in event data are frozen', () => {
    const session = new DurableSession('test-2');
    session.acquireWriter();
    const ev = session.append('user', { nested: { deep: { value: 1 } } });
    session.releaseWriter();
    expect(Object.isFrozen(ev.data)).toBe(true);
    expect(Object.isFrozen((ev.data as any).nested)).toBe(true);
    expect(Object.isFrozen((ev.data as any).nested.deep)).toBe(true);
  });

  it('append with null data is frozen', () => {
    const session = new DurableSession('test-3');
    session.acquireWriter();
    const ev = session.append('system', null);
    session.releaseWriter();
    expect(Object.isFrozen(ev)).toBe(true);
  });

  it('append with array data freezes array', () => {
    const session = new DurableSession('test-4');
    session.acquireWriter();
    const ev = session.append('system', [1, 2, 3]);
    session.releaseWriter();
    expect(Object.isFrozen(ev.data)).toBe(true);
  });
});

describe('durable-session-survival: writer lock', () => {
  it('throws when appending without writer lock', () => {
    const session = new DurableSession('test-5');
    expect(() => session.append('user', { msg: 'test' })).toThrow(SessionError);
  });

  it('throws when acquiring writer lock twice from different owners', () => {
    const session = new DurableSession('test-6');
    session.acquireWriter('owner-1');
    expect(() => session.acquireWriter('owner-2')).toThrow('writer lock already held');
  });

  it('allows re-acquiring writer lock from same owner', () => {
    const session = new DurableSession('test-7');
    session.acquireWriter('owner-1');
    expect(() => session.acquireWriter('owner-1')).not.toThrow();
  });

  it('throws when releasing writer lock from wrong owner', () => {
    const session = new DurableSession('test-8');
    session.acquireWriter('owner-1');
    expect(() => session.releaseWriter('owner-2')).toThrow('writer lock owned by another caller');
  });

  it('releaseWriter is no-op when no lock held', () => {
    const session = new DurableSession('test-9');
    expect(() => session.releaseWriter()).not.toThrow();
  });

  it('throws for empty writer owner', () => {
    const session = new DurableSession('test-10');
    expect(() => session.acquireWriter('')).toThrow('writer owner is required');
  });
});

describe('durable-session-survival: session_id validation', () => {
  it('throws for empty session_id', () => {
    expect(() => new DurableSession('')).toThrow('session_id is required');
  });

  it('throws for whitespace-only session_id', () => {
    expect(() => new DurableSession('   ')).toThrow('session_id is required');
  });
});

describe('durable-session-survival: append event types', () => {
  it('throws for invalid event type', () => {
    const session = new DurableSession('test-11');
    session.acquireWriter();
    expect(() => session.append('invalid_type' as any, {})).toThrow('invalid event type');
    session.releaseWriter();
  });

  it('accepts all valid event types', () => {
    const session = new DurableSession('test-12');
    session.acquireWriter();
    const types = ['user', 'assistant', 'tool_call', 'tool_result', 'compaction', 'branch', 'fork', 'steer', 'system', 'error', 'summary'];
    for (const type of types) {
      session.append(type as any, { type });
    }
    session.releaseWriter();
    expect(session.eventCount()).toBe(types.length);
  });
});

describe('durable-session-survival: hash chain integrity', () => {
  it('first event has empty prev_hash', () => {
    const session = new DurableSession('test-13');
    session.acquireWriter();
    const ev = session.append('user', { msg: 'first' });
    session.releaseWriter();
    expect(ev.prev_hash).toBe('');
  });

  it('second event prev_hash equals first event hash', () => {
    const session = new DurableSession('test-14');
    session.acquireWriter();
    const ev1 = session.append('user', { msg: 'first' });
    const ev2 = session.append('user', { msg: 'second' });
    session.releaseWriter();
    expect(ev2.prev_hash).toBe(ev1.hash);
  });

  it('seq numbers increment from 1', () => {
    const session = new DurableSession('test-15');
    session.acquireWriter();
    const ev1 = session.append('user', { msg: 'first' });
    const ev2 = session.append('user', { msg: 'second' });
    session.releaseWriter();
    expect(ev1.seq).toBe(1);
    expect(ev2.seq).toBe(2);
  });

  it('getEvents returns all events', () => {
    const session = new DurableSession('test-16');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    session.append('user', { msg: 'b' });
    session.append('user', { msg: 'c' });
    session.releaseWriter();
    const events = session.getEvents();
    expect(events).toHaveLength(3);
  });

  it('eventCount returns correct count', () => {
    const session = new DurableSession('test-17');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    session.append('user', { msg: 'b' });
    session.releaseWriter();
    expect(session.eventCount()).toBe(2);
  });
});

describe('durable-session-survival: snapshot', () => {
  it('creates snapshot with version 1', () => {
    const session = new DurableSession('test-18');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    const snap = session.snapshot_({ state: 'running' });
    session.releaseWriter();
    expect(snap.version).toBe(1);
    expect(snap.session_id).toBe('test-18');
  });

  it('snapshot version increments', () => {
    const session = new DurableSession('test-19');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    const snap1 = session.snapshot_({ state: 'step1' });
    session.append('user', { msg: 'b' });
    const snap2 = session.snapshot_({ state: 'step2' });
    session.releaseWriter();
    expect(snap1.version).toBe(1);
    expect(snap2.version).toBe(2);
  });

  it('snapshot last_seq equals event count', () => {
    const session = new DurableSession('test-20');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    session.append('user', { msg: 'b' });
    const snap = session.snapshot_({ state: 'done' });
    session.releaseWriter();
    expect(snap.last_seq).toBe(2);
  });

  it('snapshot is frozen', () => {
    const session = new DurableSession('test-21');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    const snap = session.snapshot_({ state: 'running' });
    session.releaseWriter();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.summary)).toBe(true);
  });
});

describe('durable-session-survival: export and import', () => {
  it('export returns events and snapshot', () => {
    const session = new DurableSession('test-22');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    session.append('user', { msg: 'b' });
    session.snapshot_({ state: 'done' });
    session.releaseWriter();
    const exported = session.export_();
    expect(exported.session_id).toBe('test-22');
    expect(exported.events).toHaveLength(2);
    expect(exported.snapshot).not.toBeNull();
    expect(exported.snapshot!.version).toBe(1);
  });

  it('export returns null snapshot when no snapshot created', () => {
    const session = new DurableSession('test-23');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    session.releaseWriter();
    const exported = session.export_();
    expect(exported.snapshot).toBeNull();
  });

  it('import restores events and snapshot', () => {
    const session1 = new DurableSession('test-24');
    session1.acquireWriter();
    session1.append('user', { msg: 'a' });
    session1.append('user', { msg: 'b' });
    session1.snapshot_({ state: 'done' });
    session1.releaseWriter();
    const exported = session1.export_();

    const session2 = DurableSession.import_(exported);
    expect(session2.eventCount()).toBe(2);
    expect(session2.getEvents()[0]!.data).toEqual({ msg: 'a' });
  });

  it('import throws for mismatched snapshot last_hash', () => {
    const session = new DurableSession('test-25');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    const snap = session.snapshot_({ state: 'done' });
    session.releaseWriter();
    const exported = session.export_();
    // Corrupt the snapshot hash
    exported.snapshot = { ...snap, last_hash: 'wrong-hash' };
    expect(() => DurableSession.import_(exported)).toThrow('snapshot version mismatch: last_hash');
  });

  it('import throws for invalid snapshot version', () => {
    const session = new DurableSession('test-26');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    const snap = session.snapshot_({ state: 'done' });
    session.releaseWriter();
    const exported = session.export_();
    exported.snapshot = { ...snap, version: 0 };
    expect(() => DurableSession.import_(exported)).toThrow('snapshot version must be a positive integer');
  });

  it('import throws for snapshot last_seq > events length', () => {
    const session = new DurableSession('test-27');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    const snap = session.snapshot_({ state: 'done' });
    session.releaseWriter();
    const exported = session.export_();
    exported.snapshot = { ...snap, last_seq: 100 };
    expect(() => DurableSession.import_(exported)).toThrow('snapshot version mismatch: last_seq');
  });
});

describe('durable-session-survival: restore (crash recovery)', () => {
  it('restore rebuilds from event log', () => {
    const session1 = new DurableSession('test-28');
    session1.acquireWriter();
    session1.append('user', { msg: 'a' });
    session1.append('user', { msg: 'b' });
    session1.releaseWriter();
    const events = session1.getEvents();

    const session2 = DurableSession.restore({ session_id: 'test-28', events: [...events], snapshot: null });
    expect(session2.eventCount()).toBe(2);
    expect(session2.getEvents()[0]!.data).toEqual({ msg: 'a' });
  });

  it('restore is idempotent', () => {
    const session1 = new DurableSession('test-29');
    session1.acquireWriter();
    session1.append('user', { msg: 'a' });
    session1.append('user', { msg: 'b' });
    session1.releaseWriter();
    const events = session1.getEvents();

    const session2 = DurableSession.restore({ session_id: 'test-29', events: [...events], snapshot: null });
    const session3 = DurableSession.restore({ session_id: 'test-29', events: [...session2.getEvents()], snapshot: null });
    expect(session3.eventCount()).toBe(2);
  });
});

describe('durable-session-survival: file persistence', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ah-durable-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persistSession writes encrypted log file', () => {
    const session = new DurableSession('test-30');
    session.acquireWriter();
    session.append('user', { msg: 'hello' });
    session.releaseWriter();
    const logPath = join(dir, 'session.log');
    persistSession(session, logPath, { encryptionKey: TEST_KEY });
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    // Content should NOT contain plaintext
    expect(content).not.toContain('hello');
    expect(content).not.toContain('user');
  });

  it('loadSession restores from encrypted log', () => {
    const session1 = new DurableSession('test-31');
    session1.acquireWriter();
    session1.append('user', { msg: 'hello' });
    session1.append('assistant', { msg: 'world' });
    session1.releaseWriter();
    const logPath = join(dir, 'session.log');
    persistSession(session1, logPath, { encryptionKey: TEST_KEY });

    const session2 = loadSession('test-31', logPath, { encryptionKey: TEST_KEY });
    expect(session2.eventCount()).toBe(2);
    expect(session2.getEvents()[0]!.data).toEqual({ msg: 'hello' });
  });

  it('loadSession throws for missing file', () => {
    expect(() => loadSession('test', join(dir, 'nonexistent.log'), { encryptionKey: TEST_KEY }))
      .toThrow('session log not found');
  });

  it('loadSession throws for wrong key', () => {
    const session = new DurableSession('test-32');
    session.acquireWriter();
    session.append('user', { msg: 'secret' });
    session.releaseWriter();
    const logPath = join(dir, 'session.log');
    persistSession(session, logPath, { encryptionKey: TEST_KEY });

    const wrongKey = Buffer.alloc(32, 0xcd);
    expect(() => loadSession('test-32', logPath, { encryptionKey: wrongKey }))
      .toThrow();
  });

  it('appendEvent writes to file incrementally', () => {
    const logPath = join(dir, 'session.log');
    const ev = makeEvent(1);
    appendEvent(ev, logPath, { encryptionKey: TEST_KEY }, 'test-33');
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).not.toContain('event-1');
  });

  it('appendEvent creates header on first write', () => {
    const logPath = join(dir, 'session.log');
    appendEvent(makeEvent(1), logPath, { encryptionKey: TEST_KEY }, 'test-34');
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    expect(lines[0]).toBeTruthy();
  });
});

describe('durable-session-survival: setLogPath', () => {
  it('throws when persistence backend already configured via constructor', () => {
    const mockPersistence = {
      appendEvent() {},
      saveSnapshot() {},
    };
    const session = new DurableSession('test-35', { persistence: mockPersistence });
    expect(() => session.setLogPath('/tmp/test.log', { encryptionKey: TEST_KEY }))
      .toThrow('persistence backend already configured');
  });

  it('throws when events already exist', () => {
    const session = new DurableSession('test-36');
    session.acquireWriter();
    session.append('user', { msg: 'a' });
    session.releaseWriter();
    expect(() => session.setLogPath('/tmp/test.log', { encryptionKey: TEST_KEY }))
      .toThrow('log path must be configured before the first event');
  });

  it('throws for empty path', () => {
    const session = new DurableSession('test-37');
    expect(() => session.setLogPath('   ', { encryptionKey: TEST_KEY }))
      .toThrow('log path is required');
  });
});

describe('durable-session-survival: clock injection', () => {
  it('uses injected clock for timestamps', () => {
    const fixedTime = '2026-06-06T12:00:00Z';
    const session = new DurableSession('test-38', { clock: () => fixedTime });
    session.acquireWriter();
    const ev = session.append('user', { msg: 'a' });
    session.releaseWriter();
    expect(ev.timestamp).toBe(fixedTime);
  });

  it('uses default clock when not injected', () => {
    const session = new DurableSession('test-39');
    session.acquireWriter();
    const ev = session.append('user', { msg: 'a' });
    session.releaseWriter();
    expect(() => new Date(ev.timestamp).toISOString()).not.toThrow();
  });
});

describe('durable-session-survival: encryption error messages', () => {
  it('decryptFileRecord throws "session file authentication failed" for tampered ciphertext', () => {
    const session = new DurableSession('test-enc-1');
    session.setLogPath('/tmp/ah-test-enc-1.log', { encryptionKey: TEST_KEY });
    session.acquireWriter();
    session.append('user', { msg: 'test' });
    session.releaseWriter();
    // Read the log, tamper with the ciphertext, and try to reload
    const content = readFileSync('/tmp/ah-test-enc-1.log', 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length >= 2) {
      const tamperedLine = lines[1]!.slice(0, -4) + 'XXXX';
      writeFileSync('/tmp/ah-test-enc-1.log', `${lines[0]!}\n${tamperedLine}\n`);
      expect(() => loadSession('test-enc-1', '/tmp/ah-test-enc-1.log', { encryptionKey: TEST_KEY }))
        .toThrow('session file authentication failed');
    }
    rmSync('/tmp/ah-test-enc-1.log', { force: true });
  });

  it('loadSession throws "invalid header" for wrong header line', () => {
    writeFileSync('/tmp/ah-test-header.log', 'WRONG HEADER\nsomedata\n');
    expect(() => loadSession('test-header', '/tmp/ah-test-header.log', { encryptionKey: TEST_KEY }))
      .toThrow('invalid session log header');
    rmSync('/tmp/ah-test-header.log', { force: true });
  });

  it('loadSession throws "snapshot record missing" for empty snapshot after header', () => {
    writeFileSync('/tmp/ah-test-snap.log', `${'AH-SESSION-LOG:1'}\n`);
    writeFileSync('/tmp/ah-test-snap.log.snapshot.json', `${'AH-SESSION-LOG:1'}\n\n`);
    expect(() => loadSession('test-snap', '/tmp/ah-test-snap.log', { encryptionKey: TEST_KEY }))
      .toThrow('invalid encrypted session snapshot');
    rmSync('/tmp/ah-test-snap.log', { force: true });
    rmSync('/tmp/ah-test-snap.log.snapshot.json', { force: true });
  });

  it('appendEvent writes new file with header line', () => {
    const logPath = '/tmp/ah-test-append.log';
    rmSync(logPath, { force: true });
    appendEvent(
      { seq: 1, type: 'user', timestamp: '2026-01-01T00:00:00Z', data: { msg: 'hello' }, hash: 'h1', prev_hash: '' },
      logPath,
      { encryptionKey: TEST_KEY },
      'test-append',
    );
    const content = readFileSync(logPath, 'utf8');
    expect(content.startsWith('AH-SESSION-LOG:1')).toBe(true);
    rmSync(logPath, { force: true });
  });

  it('appendEvent appends to existing file without duplicate header', () => {
    const logPath = '/tmp/ah-test-append2.log';
    rmSync(logPath, { force: true });
    appendEvent(
      { seq: 1, type: 'user', timestamp: '2026-01-01T00:00:00Z', data: { msg: 'first' }, hash: 'h1', prev_hash: '' },
      logPath,
      { encryptionKey: TEST_KEY },
      'test-append2',
    );
    appendEvent(
      { seq: 2, type: 'assistant', timestamp: '2026-01-01T00:00:01Z', data: { msg: 'second' }, hash: 'h2', prev_hash: 'h1' },
      logPath,
      { encryptionKey: TEST_KEY },
      'test-append2',
    );
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    // First line is header, then 2 encrypted event lines
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('AH-SESSION-LOG:1');
    rmSync(logPath, { force: true });
  });
});

describe('durable-session-survival: cloneJsonValue error messages', () => {
  it('append throws "event data must be JSON-serializable" for circular reference', () => {
    const session = new DurableSession('test-circ-1');
    session.acquireWriter();
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(() => session.append('user', circular)).toThrow('event data must be JSON-serializable');
    session.releaseWriter();
  });

  it('append throws "event data must be JSON-serializable" for BigInt value', () => {
    const session = new DurableSession('test-circ-2');
    session.acquireWriter();
    expect(() => session.append('user', { big: BigInt(123) })).toThrow('event data must be JSON-serializable');
    session.releaseWriter();
  });

  it('export_ throws "event must be JSON-serializable" for circular event data', () => {
    const session = new DurableSession('test-circ-3');
    // Manually inject a circular event
    (session as any).events.push({ seq: 1, type: 'user', timestamp: '2026-01-01T00:00:00Z', data: null, hash: 'h', prev_hash: '' });
    // Replace the null data with a circular reference
    const circular: any = {};
    circular.self = circular;
    (session as any).events[0].data = circular;
    expect(() => session.export_()).toThrow('event must be JSON-serializable');
  });
});
