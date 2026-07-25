import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableSession, persistSession, loadSession, appendEvent } from '../../session/durable-session.js';

const FILE_KEY = Buffer.alloc(32, 0x2a);
const FILE_OPTIONS = { encryptionKey: FILE_KEY };

describe('Session file persistence', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sess-persist-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists session to file and reloads it', () => {
    const s = new DurableSession('persist-1');
    s.acquireWriter();
    s.append('user', { text: 'hello' });
    s.append('assistant', { decision_summary: 'hi' });
    const logPath = join(dir, 'session.ndjson');
    persistSession(s, logPath, FILE_OPTIONS);
    expect(existsSync(logPath)).toBe(true);
    const loaded = loadSession('persist-1', logPath, FILE_OPTIONS);
    expect(loaded.eventCount()).toBe(2);
    expect(loaded.getEvents()[0]!.type).toBe('user');
  });

  it('crash recovery: load after crash resumes without duplicate events', () => {
    const s = new DurableSession('crash-1');
    s.acquireWriter();
    s.append('user', { text: 'do task' });
    s.append('assistant', { decision_summary: 'step1' });
    const logPath = join(dir, 'crash.ndjson');
    persistSession(s, logPath, FILE_OPTIONS);
    // simulate crash: load in a new process context
    const restored = loadSession('crash-1', logPath, FILE_OPTIONS);
    expect(restored.eventCount()).toBe(2);
    expect(restored.resumeFrom()).toBe(3);
    // no duplication
    const restored2 = loadSession('crash-1', logPath, FILE_OPTIONS);
    expect(restored2.eventCount()).toBe(2);
  });

  it('appendEvent writes incrementally to the log file', () => {
    const s = new DurableSession('incr-1');
    s.acquireWriter();
    const ev = s.append('user', { text: 'incremental' });
    const logPath = join(dir, 'incr.ndjson');
    appendEvent(ev, logPath, FILE_OPTIONS, 'incr-1');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath).includes(Buffer.from('incremental'))).toBe(false);
    expect(loadSession('incr-1', logPath, FILE_OPTIONS).getEvent(1)?.type).toBe(
      'user',
    );
  });

  it('snapshot is persisted alongside event log', () => {
    const s = new DurableSession('snap-1');
    s.acquireWriter();
    s.append('user', { text: 'a' });
    s.snapshot_({ last: 'a' });
    const logPath = join(dir, 'snap.ndjson');
    persistSession(s, logPath, FILE_OPTIONS);
    expect(existsSync(logPath + '.snapshot.json')).toBe(true);
    const loaded = loadSession('snap-1', logPath, FILE_OPTIONS);
    expect(loaded.getSnapshot()).not.toBeNull();
    expect(loaded.getSnapshot()!.last_seq).toBe(1);
  });


  it('DurableSession persists each event incrementally to disk on append (not just at end)', () => {
    const logPath = join(tmpdir(), 'sess-incr-' + Date.now() + '.log');
    const session = new DurableSession('incr-test');
    session.acquireWriter();
    session.append('user', { msg: 'first' });
    // After append, the event must already be on disk (incremental persistence)
    expect(existsSync(logPath)).toBe(false); // no logPath set yet — this is the old API

    // New behavior: DurableSession should accept a logPath and persist incrementally
    const session2 = new DurableSession('incr-test-2');
    session2.setLogPath(logPath, FILE_OPTIONS);
    session2.acquireWriter();
    session2.append('user', { msg: 'first' });
    // Event must be on disk immediately after append
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).not.toContain('first');

    session2.append('assistant', { msg: 'second' });
    const content2 = readFileSync(logPath, 'utf8');
    expect(content2).not.toContain('first');
    expect(content2).not.toContain('second');
    expect(loadSession('incr-test-2', logPath, FILE_OPTIONS).eventCount()).toBe(
      2,
    );
    session2.releaseWriter();
    rmSync(logPath, { force: true });
  });

});
