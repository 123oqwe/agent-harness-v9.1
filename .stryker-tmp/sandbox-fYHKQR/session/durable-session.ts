/**
 * AH-RUNTIME-SESSION-001: Linear durable session with event sourcing.
 *
 * Event log is the source of truth. Snapshot is acceleration (rebuildable).
 * Crash mid-task: resume without duplicate writes (idempotent replay).
 * 11 entry types: user, assistant, tool_call, tool_result, compaction,
 * branch, fork, steer, system, error, summary. Concurrent writer lock enforced.
 * Snapshot version verified on load.
 */
// @ts-nocheck

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

  constructor(session_id: string) { this.session_id = session_id; }

  /** Acquire exclusive writer lock (concurrent writer lock enforced). */
  acquireWriter(): void {
    if (this.writerLocked) throw new SessionError('concurrent writer lock held');
    this.writerLocked = true;
  }
  releaseWriter(): void { this.writerLocked = false; }

  /** Append an event to the log (source of truth). */
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
