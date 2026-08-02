/**
 * AH-RUNTIME-SESSION-001: Linear durable session with event sourcing.
 *
 * Event log is the source of truth. Snapshot is acceleration (rebuildable).
 * Crash mid-task: resume without duplicate writes (idempotent replay).
 * 11 entry types: user, assistant, tool_call, tool_result, compaction,
 * branch, fork, steer, system, error, summary. Concurrent writer lock enforced.
 * Snapshot version verified on load.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { hashSessionEvent, SESSION_EVENT_TYPES } from './session-event-codec.js';

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

export interface SessionPersistencePort {
  appendEvent(sessionId: string, event: SessionEvent): void;
  saveSnapshot?(sessionId: string, snapshot: SessionSnapshot): void;
}

export interface DurableSessionOptions {
  persistence?: SessionPersistencePort | undefined;
  clock?: () => string;
}

export interface SessionFileEncryptionOptions {
  /** Caller-custodied data-encryption key; never written beside the log. */
  encryptionKey: Uint8Array;
}

export class SessionError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionError'; Object.setPrototypeOf(this, SessionError.prototype); }
}

const ALL_TYPES = SESSION_EVENT_TYPES;

function cloneJsonValue<T>(value: T, label: string): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new SessionError(`${label} must be JSON-serializable: ${error instanceof Error ? error.message : 'serialization failed'}`);
  }
  if (serialized === undefined) {
    throw new SessionError(`${label} must be JSON-serializable`);
  }
  return JSON.parse(serialized) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function immutableEvent(event: SessionEvent): SessionEvent {
  return deepFreeze({
    ...event,
    data: cloneJsonValue(event.data, 'event data'),
  });
}

function immutableSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return deepFreeze({
    ...snapshot,
    summary: cloneJsonValue(snapshot.summary, 'snapshot summary'),
  });
}

export class DurableSession {
  readonly session_id: string;
  private readonly events: SessionEvent[] = [];
  private snapshot: SessionSnapshot | null = null;
  private writerOwner: string | null = null;
  private last_hash = '';
  private logPath: string | null = null;
  private fileEncryptionKey: Buffer | null = null;
  private readonly persistence: SessionPersistencePort | undefined;
  private readonly clock: () => string;

  constructor(session_id: string, options: DurableSessionOptions = {}) {
    if (session_id.trim().length === 0) {
      throw new SessionError('session_id is required');
    }
    this.session_id = session_id;
    this.persistence = options.persistence;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /** Set the file path for incremental event log persistence. */
  setLogPath(path: string, options: SessionFileEncryptionOptions): void {
    if (this.persistence) {
      throw new SessionError('persistence backend already configured');
    }
    if (this.events.length > 0) {
      throw new SessionError('log path must be configured before the first event');
    }
    if (path.trim().length === 0) {
      throw new SessionError('log path is required');
    }
    this.fileEncryptionKey = validatedFileKey(options);
    this.logPath = path;
  }

  /** Acquire exclusive writer lock (concurrent writer lock enforced). */
  acquireWriter(owner = 'default'): void {
    if (owner.trim().length === 0) {
      throw new SessionError('writer owner is required');
    }
    if (this.writerOwner === owner) return;
    if (this.writerOwner !== null) {
      throw new SessionError('writer lock already held');
    }
    this.writerOwner = owner;
  }
  releaseWriter(owner = 'default'): void {
    if (this.writerOwner === null) return;
    if (this.writerOwner !== owner) {
      throw new SessionError('writer lock owned by another caller');
    }
    this.writerOwner = null;
  }

  /** Append an event to the log (source of truth). Persists incrementally if logPath is set. */
  append(type: SessionEventType, data: unknown): SessionEvent {
    if (!ALL_TYPES.includes(type)) throw new SessionError(`invalid event type: ${type}`);
    if (this.writerOwner === null) throw new SessionError('writer lock required to append');
    const seq = this.events.length + 1;
    const timestamp = this.clock();
    const prev_hash = this.last_hash;
    const eventData = cloneJsonValue(data, 'event data');
    const hash = hashSessionEvent(seq, type, timestamp, eventData, prev_hash);
    const ev = immutableEvent({ seq, type, timestamp, data: eventData, hash, prev_hash });
    // Durable append must succeed before the in-memory authority advances.
    if (this.logPath) {
      appendEvent(
        ev,
        this.logPath,
        { encryptionKey: this.fileEncryptionKey! },
        this.session_id,
      );
    }
    this.persistence?.appendEvent(this.session_id, ev);
    this.events.push(ev);
    this.last_hash = hash;
    return ev;
  }

  /** Create a snapshot (acceleration). Version must increment. */
  snapshot_(summary: unknown): SessionSnapshot {
    const version = (this.snapshot?.version ?? 0) + 1;
    const snapshot = immutableSnapshot({
      session_id: this.session_id, version,
      last_seq: this.events.length, last_hash: this.last_hash,
      created_at: this.clock(), summary,
    });
    this.persistence?.saveSnapshot?.(this.session_id, snapshot);
    this.snapshot = snapshot;
    return snapshot;
  }

  /** Export the session (event log + snapshot) for persistence. */
  export_(): { session_id: string; events: SessionEvent[]; snapshot: SessionSnapshot | null } {
    return {
      session_id: this.session_id,
      events: this.events.map((event) => cloneJsonValue(event, 'event')),
      snapshot:
        this.snapshot === null
          ? null
          : cloneJsonValue(this.snapshot, 'snapshot'),
    };
  }

  /** Import a previously exported session. Snapshot version verified on load. */
  static import_(
    data: {
      session_id: string;
      events: SessionEvent[];
      snapshot: SessionSnapshot | null;
    },
    options: DurableSessionOptions = {},
  ): DurableSession {
    const s = new DurableSession(data.session_id, options);
    if (!Array.isArray(data.events)) {
      throw new SessionError('events must be an array');
    }
    // Replay event log (the authority); verify hash chain integrity
    let prev = '';
    for (const ev of data.events) {
      if (ev.seq !== s.events.length + 1) {
        throw new SessionError(`non-contiguous sequence at seq ${ev.seq}`);
      }
      if (!ALL_TYPES.includes(ev.type)) {
        throw new SessionError(`invalid event type at seq ${ev.seq}`);
      }
      if (typeof ev.timestamp !== 'string' || ev.timestamp.length === 0) {
        throw new SessionError(`invalid timestamp at seq ${ev.seq}`);
      }
      if (typeof ev.prev_hash !== 'string' || typeof ev.hash !== 'string') {
        throw new SessionError(`invalid hash envelope at seq ${ev.seq}`);
      }
      const eventData = cloneJsonValue(ev.data, `event data at seq ${ev.seq}`);
      const expected = hashSessionEvent(ev.seq, ev.type, ev.timestamp, eventData, ev.prev_hash);
      if (expected !== ev.hash) throw new SessionError(`hash chain broken at seq ${ev.seq}`);
      if (ev.prev_hash !== prev) throw new SessionError(`prev_hash mismatch at seq ${ev.seq}`);
      s.events.push(immutableEvent({ ...ev, data: eventData }));
      prev = ev.hash;
      s.last_hash = ev.hash;
    }
    // Snapshot is acceleration; verify it matches the replayed state
    if (data.snapshot) {
      if (data.snapshot.session_id !== data.session_id) {
        throw new SessionError('snapshot session_id mismatch');
      }
      if (!Number.isSafeInteger(data.snapshot.version) || data.snapshot.version < 1) {
        throw new SessionError('snapshot version must be a positive integer');
      }
      if (data.snapshot.last_seq < 0 || data.snapshot.last_seq > s.events.length) {
        throw new SessionError('snapshot version mismatch: last_seq');
      }
      const snapshotHash =
        data.snapshot.last_seq === 0
          ? ''
          : s.events[data.snapshot.last_seq - 1]?.hash;
      if (data.snapshot.last_hash !== snapshotHash) {
        throw new SessionError('snapshot version mismatch: last_hash');
      }
      s.snapshot = immutableSnapshot(data.snapshot);
    }
    return s;
  }

  /** Crash recovery: rebuild from event log. Idempotent — replaying doesn't duplicate side effects. */
  static restore(
    data: {
      session_id: string;
      events: SessionEvent[];
      snapshot: SessionSnapshot | null;
    },
    options: DurableSessionOptions = {},
  ): DurableSession {
    return DurableSession.import_(data, options);
  }

  /** Resume from the first incomplete event (crash mid-task). */
  resumeFrom(): number { return this.events.length + 1; }

  getEvents(): readonly SessionEvent[] { return Object.freeze([...this.events]); }
  getEvent(seq: number): SessionEvent | undefined { return this.events[seq - 1]; }
  getSnapshot(): SessionSnapshot | null { return this.snapshot; }
  eventCount(): number { return this.events.length; }

  /** 11 entry types supported. */
  static readonly EVENT_TYPES = ALL_TYPES;
}

// ---------------------------------------------------------------------------
// File-based persistence (cross-process durable log)
// ---------------------------------------------------------------------------

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const SESSION_FILE_HEADER = 'AH-SESSION-LOG:1';
const SESSION_FILE_PREFIX = 'ahfile:v1';

function validatedFileKey(options: SessionFileEncryptionOptions): Buffer {
  if (
    options?.encryptionKey === undefined ||
    options.encryptionKey.byteLength !== 32
  ) {
    throw new SessionError('32-byte session file encryptionKey is required');
  }
  return Buffer.from(options.encryptionKey);
}

function encryptFileRecord(
  plaintext: string,
  key: Buffer,
  associatedData: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    SESSION_FILE_PREFIX,
    nonce.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

function decryptFileRecord(
  envelope: string,
  key: Buffer,
  associatedData: string,
): string {
  const parts = envelope.split(':');
  if (
    parts.length !== 5 ||
    `${parts[0]}:${parts[1]}` !== SESSION_FILE_PREFIX
  ) {
    throw new SessionError('invalid encrypted session record');
  }
  try {
    const nonce = Buffer.from(parts[2]!, 'base64');
    const tag = Buffer.from(parts[3]!, 'base64');
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
      throw new Error('invalid envelope size');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parts[4]!, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SessionError('session file authentication failed');
  }
}

function durableReplace(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Persist an AES-256-GCM encrypted event log. The caller owns the key.
 */
export function persistSession(
  session: DurableSession,
  logPath: string,
  options: SessionFileEncryptionOptions,
): void {
  const data = session.export_();
  const key = validatedFileKey(options);
  try {
    const records = data.events.map((event) =>
      encryptFileRecord(
        JSON.stringify(event),
        key,
        `event:${data.session_id}:${event.seq}`,
      ),
    );
    durableReplace(
      logPath,
      `${[SESSION_FILE_HEADER, ...records].join('\n')}\n`,
    );
    if (data.snapshot) {
      durableReplace(
        `${logPath}.snapshot.json`,
        `${SESSION_FILE_HEADER}\n${encryptFileRecord(
          JSON.stringify(data.snapshot),
          key,
          `snapshot:${data.session_id}`,
        )}\n`,
      );
    }
  } finally {
    key.fill(0);
  }
}

/**
 * Load a session from a file-based event log.
 * Replays the hash-chained event log and verifies integrity.
 */
export function loadSession(
  session_id: string,
  logPath: string,
  options: SessionFileEncryptionOptions,
): DurableSession {
  if (!existsSync(logPath)) throw new SessionError(`session log not found: ${logPath}`);
  const key = validatedFileKey(options);
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  if (lines.shift() !== SESSION_FILE_HEADER) {
    key.fill(0);
    throw new SessionError('invalid session log header');
  }
  const events: SessionEvent[] = [];
  let lineNumber = 1;
  try {
  for (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const nextSequence = events.length + 1;
      events.push(
        JSON.parse(
          decryptFileRecord(
            line,
            key,
            `event:${session_id}:${nextSequence}`,
          ),
        ) as SessionEvent,
      );
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError(`invalid encrypted session event at line ${lineNumber}`);
    }
  }
  let snapshot: SessionSnapshot | null = null;
  const snapshotPath = logPath + '.snapshot.json';
  if (existsSync(snapshotPath)) {
    try {
      const snapshotLines = readFileSync(snapshotPath, 'utf8').split('\n');
      if (snapshotLines.shift() !== SESSION_FILE_HEADER) {
        throw new Error('invalid header');
      }
      const encryptedSnapshot = snapshotLines.find(
        (line) => line.trim().length > 0,
      );
      if (!encryptedSnapshot) throw new Error('snapshot record missing');
      snapshot = JSON.parse(
        decryptFileRecord(
          encryptedSnapshot,
          key,
          `snapshot:${session_id}`,
        ),
      ) as SessionSnapshot;
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError('invalid encrypted session snapshot');
    }
  }
  return DurableSession.import_({ session_id, events, snapshot });
  } finally {
    key.fill(0);
  }
}

/**
 * Append a single event to the log file (incremental persistence).
 * Use this for crash-safe writing after each session.append().
 */
export function appendEvent(
  event: SessionEvent,
  logPath: string,
  options: SessionFileEncryptionOptions,
  sessionId: string,
): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const key = validatedFileKey(options);
  const isNew = !existsSync(logPath);
  const descriptor = openSync(logPath, 'a', 0o600);
  try {
    if (isNew) {
      writeFileSync(descriptor, `${SESSION_FILE_HEADER}\n`, 'utf8');
    }
    writeFileSync(
      descriptor,
      `${encryptFileRecord(
        JSON.stringify(event),
        key,
        `event:${sessionId}:${event.seq}`,
      )}\n`,
      'utf8',
    );
    fsyncSync(descriptor);
  } finally {
    key.fill(0);
    closeSync(descriptor);
  }
}
