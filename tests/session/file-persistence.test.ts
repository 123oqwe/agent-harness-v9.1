import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableSession, persistSession, loadSession, appendEvent } from '../../session/durable-session.js';

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
    persistSession(s, logPath);
    expect(existsSync(logPath)).toBe(true);
    const loaded = loadSession('persist-1', logPath);
    expect(loaded.eventCount()).toBe(2);
    expect(loaded.getEvents()[0]!.type).toBe('user');
  });

  it('crash recovery: load after crash resumes without duplicate events', () => {
    const s = new DurableSession('crash-1');
    s.acquireWriter();
    s.append('user', { text: 'do task' });
    s.append('assistant', { decision_summary: 'step1' });
    const logPath = join(dir, 'crash.ndjson');
    persistSession(s, logPath);
    // simulate crash: load in a new process context
    const restored = loadSession('crash-1', logPath);
    expect(restored.eventCount()).toBe(2);
    expect(restored.resumeFrom()).toBe(3);
    // no duplication
    const restored2 = loadSession('crash-1', logPath);
    expect(restored2.eventCount()).toBe(2);
  });

  it('appendEvent writes incrementally to the log file', () => {
    const s = new DurableSession('incr-1');
    s.acquireWriter();
    const ev = s.append('user', { text: 'incremental' });
    const logPath = join(dir, 'incr.ndjson');
    appendEvent(ev, logPath);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8').trim();
    expect(JSON.parse(content).type).toBe('user');
  });

  it('snapshot is persisted alongside event log', () => {
    const s = new DurableSession('snap-1');
    s.acquireWriter();
    s.append('user', { text: 'a' });
    s.snapshot_({ last: 'a' });
    const logPath = join(dir, 'snap.ndjson');
    persistSession(s, logPath);
    expect(existsSync(logPath + '.snapshot.json')).toBe(true);
    const loaded = loadSession('snap-1', logPath);
    expect(loaded.getSnapshot()).not.toBeNull();
    expect(loaded.getSnapshot()!.last_seq).toBe(1);
  });
});
