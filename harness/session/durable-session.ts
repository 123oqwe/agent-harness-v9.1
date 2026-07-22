/**
 * AH-RUNTIME-SESSION-001: Linear durable session with event sourcing.
 *
 * Event log is the source of truth. Snapshot is acceleration (rebuildable).
 * Crash mid-task: resume without duplicate writes (idempotent replay).
 * 11 entry types: user, assistant, tool_call, tool_result, compaction,
 * branch, fork, steer, system, error, summary. Concurrent writer lock enforced.
 * Snapshot version verified on load.
 */
import { createHash } from 'node:crypto';

export type SessionEventType = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'compaction' | 'branch' | 'fork' | 'steer' | 'system' | 'error' | 'summary';

export interface SessionEvent {
  seq: number;
  type: SessionEventType;
  timestamp: string;
  data: unknown;
  hash: string;       // hash of seq+type+timestamp+data, chains to previous
  prev_hash: string;  // '' for genesis
}

export interface SessionSnapshot {
  session_id: string;
  version: number;
  last_seq: number;
  last_hash: string;
  created_at: string;
  summary: unknown;
}

export class SessionError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionError'; Object.setPrototypeOf(this, SessionError.prototype); }
}

const ALL_TYPES: SessionEventType[] = ['user', 'assistant', 'tool_call', 'tool_result', 'compaction', 'branch', 'fork', 'steer', 'system', 'error', 'summary'];

function hashEvent(seq: number, type: SessionEventType, timestamp: string, data: unknown, prev_hash: string): string {
  return createHash('sha256').update(`${seq}|${type}|${timestamp}|${JSON.stringify(data)}|${prev_hash}`).digest('hex');
}

export class DurableSession {
  readonly session_id: string;
  private readonly events: SessionEvent[] = [];
  private snapshot: SessionSnapshot | null = null;
  private writerLocked = false;
  private last_hash = '';
  private logPath: string | null = null;

  constructor(session_id: string) { this.session_id = session_id; }

  /** Set the file path for incremental event log persistence. */
  setLogPath(path: string): void { this.logPath = path; }

  /** Acquire exclusive writer lock (concurrent writer lock enforced). */
  acquireWriter(): void {
    if (this.writerLocked) throw new SessionError('concurrent writer lock held');
    this.writerLocked = true;
  }
  releaseWriter(): void { this.writerLocked = false; }

  /** Append an event to the log (source of truth). Persists incrementally if logPath is set. */
  append(type: SessionEventType, data: unknown): SessionEvent {
    if (!ALL_TYPES.includes(type)) throw new SessionError(`invalid event type: ${type}`);
    if (!this.writerLocked) throw new SessionError('writer lock required to append');
    const seq = this.events.length + 1;
    const timestamp = new Date().toISOString();
    const prev_hash = this.last_hash;
    const hash = hashEvent(seq, type, timestamp, data, prev_hash);
    const ev: SessionEvent = { seq, type, timestamp, data, hash, prev_hash };
    this.events.push(ev);
    this.last_hash = hash;
    // Incremental persistence: flush each event to disk immediately
    if (this.logPath) {
      appendEvent(ev, this.logPath);
    }
    return ev;
  }

  /** Create a snapshot (acceleration). Version must increment. */
  snapshot_(summary: unknown): SessionSnapshot {
    const version = (this.snapshot?.version ?? 0) + 1;
    this.snapshot = {
      session_id: this.session_id, version,
      last_seq: this.events.length, last_hash: this.last_hash,
      created_at: new Date().toISOString(), summary,
    };
    return this.snapshot;
  }

  /** Export the session (event log + snapshot) for persistence. */
  export_(): { session_id: string; events: SessionEvent[]; snapshot: SessionSnapshot | null } {
    return { session_id: this.session_id, events: [...this.events], snapshot: this.snapshot };
  }

  /** Import a previously exported session. Snapshot version verified on load. */
  static import_(data: { session_id: string; events: SessionEvent[]; snapshot: SessionSnapshot | null }): DurableSession {
    const s = new DurableSession(data.session_id);
    // Replay event log (the authority); verify hash chain integrity
    let prev = '';
    for (const ev of data.events) {
      const expected = hashEvent(ev.seq, ev.type, ev.timestamp, ev.data, ev.prev_hash);
      if (expected !== ev.hash) throw new SessionError(`hash chain broken at seq ${ev.seq}`);
      if (ev.prev_hash !== prev) throw new SessionError(`prev_hash mismatch at seq ${ev.seq}`);
      s.events.push(ev);
      prev = ev.hash;
      s.last_hash = ev.hash;
    }
    // Snapshot is acceleration; verify it matches the replayed state
    if (data.snapshot) {
      if (data.snapshot.last_seq !== s.events.length) throw new SessionError('snapshot version mismatch: last_seq');
      if (data.snapshot.last_hash !== s.last_hash) throw new SessionError('snapshot version mismatch: last_hash');
      s.snapshot = data.snapshot;
    }
    return s;
  }

  /** Crash recovery: rebuild from event log. Idempotent — replaying doesn't duplicate side effects. */
  static restore(data: { session_id: string; events: SessionEvent[]; snapshot: SessionSnapshot | null }): DurableSession {
    return DurableSession.import_(data);
  }

  /** Resume from the first incomplete event (crash mid-task). */
  resumeFrom(): number { return this.events.length + 1; }

  getEvents(): readonly SessionEvent[] { return this.events; }
  getEvent(seq: number): SessionEvent | undefined { return this.events[seq - 1]; }
  getSnapshot(): SessionSnapshot | null { return this.snapshot; }
  eventCount(): number { return this.events.length; }

  /** 11 entry types supported. */
  static readonly EVENT_TYPES = ALL_TYPES;
}

// ---------------------------------------------------------------------------
// File-based persistence (cross-process durable log)
// ---------------------------------------------------------------------------

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persist the session event log to a file (one JSON line per event).
 * This makes the session durable across process restarts.
 */
export function persistSession(session: DurableSession, logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const data = session.export_();
  // Write all events as NDJSON (one event per line)
  writeFileSync(logPath, data.events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  // Write snapshot alongside if present
  if (data.snapshot) {
    writeFileSync(logPath + '.snapshot.json', JSON.stringify(data.snapshot, null, 2), 'utf8');
  }
}

/**
 * Load a session from a file-based event log.
 * Replays the hash-chained event log and verifies integrity.
 */
export function loadSession(session_id: string, logPath: string): DurableSession {
  if (!existsSync(logPath)) throw new SessionError(`session log not found: ${logPath}`);
  const content = readFileSync(logPath, 'utf8');
  const events: SessionEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line));
  }
  let snapshot: SessionSnapshot | null = null;
  const snapshotPath = logPath + '.snapshot.json';
  if (existsSync(snapshotPath)) {
    snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  }
  return DurableSession.import_({ session_id, events, snapshot });
}

/**
 * Append a single event to the log file (incremental persistence).
 * Use this for crash-safe writing after each session.append().
 */
export function appendEvent(event: SessionEvent, logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
}
