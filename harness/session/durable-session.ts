/**
 * AH-SESSION-001: Durable Session
 *
 * Append-only event log with versioned snapshots, corruption/truncation
 * detection, and deterministic crash restore. Every state change appends
 * an event before publishing results.
 *
 * Invariants:
 *  - Events are append-only (never modified or deleted)
 *  - Snapshots are versioned and immutable
 *  - Corrupt/truncated events are detected and rejected
 *  - Restore is deterministic from the event log
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventType =
  | 'run_created' | 'run_started' | 'run_completed' | 'run_failed' | 'run_cancelled'
  | 'step_created' | 'step_started' | 'step_completed' | 'step_failed'
  | 'attempt_created' | 'attempt_started' | 'attempt_completed' | 'attempt_failed'
  | 'action_proposed' | 'action_authorized' | 'action_denied'
  | 'action_executed' | 'action_observed'
  | 'model_called' | 'tool_called' | 'skill_activated'
  | 'checkpoint_created' | 'checkpoint_restored'
  | 'snapshot_created';

export interface SessionEvent {
  seq: number;
  type: EventType;
  run_id: string;
  step_id?: string;
  attempt_id?: string;
  timestamp: string;
  data: Record<string, unknown>;
  prev_hash: string;
  event_hash: string;
}

export interface SessionSnapshot {
  version: number;
  run_id: string;
  created_at: string;
  last_seq: number;
  state: Record<string, unknown>;
  hash: string;
}

export interface RestoreResult {
  restored: boolean;
  events_replayed: number;
  last_seq: number;
  state: Record<string, unknown>;
  corrupt_events: number;
}

// ---------------------------------------------------------------------------
// Durable Session
// ---------------------------------------------------------------------------

export class DurableSession {
  private readonly events: SessionEvent[] = [];
  private readonly snapshots: SessionSnapshot[] = [];
  private seqCounter = 0;
  private lastHash = '';
  private readonly state = new Map<string, unknown>();
  private corruptCount = 0;

  constructor(runId: string) {
    this.append({
      type: 'run_created',
      run_id: runId,
      data: { run_id: runId },
    });
  }

  append(input: Omit<SessionEvent, 'seq' | 'timestamp' | 'prev_hash' | 'event_hash'>): SessionEvent {
    const seq = ++this.seqCounter;
    const timestamp = new Date().toISOString();
    const prevHash = this.lastHash;

    const event: SessionEvent = {
      ...input,
      seq,
      timestamp,
      prev_hash: prevHash,
      event_hash: '',
    };

    event.event_hash = this.hashEvent(event);
    this.events.push(event);
    this.lastHash = event.event_hash;

    // Update state
    this.applyEvent(event);

    return event;
  }

  snapshot(version?: number): SessionSnapshot {
    const ver = version ?? this.snapshots.length + 1;
    const snap: SessionSnapshot = {
      version: ver,
      run_id: this.events[0]?.run_id ?? '',
      created_at: new Date().toISOString(),
      last_seq: this.seqCounter,
      state: Object.fromEntries(this.state),
      hash: '',
    };
    snap.hash = this.hashSnapshot(snap);
    this.snapshots.push(snap);

    this.append({
      type: 'snapshot_created',
      run_id: snap.run_id,
      data: { version: ver, last_seq: snap.last_seq },
    });

    return snap;
  }

  getSnapshot(version: number): SessionSnapshot | undefined {
    return this.snapshots.find((s) => s.version === version);
  }

  getLatestSnapshot(): SessionSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  restore(fromSeq?: number): RestoreResult {
    const startSeq = fromSeq ?? 0;
    let replayed = 0;

    // Reset state
    this.state.clear();
    this.corruptCount = 0;

    // If restoring from a snapshot, apply snapshot state first
    if (fromSeq !== undefined) {
      const snap = this.snapshots.filter((s) => s.last_seq <= fromSeq).pop();
      if (snap) {
        for (const [key, value] of Object.entries(snap.state)) {
          this.state.set(key, value);
        }
      }
    }

    // Replay events from startSeq
    for (const event of this.events) {
      if (event.seq <= startSeq) continue;

      // Verify event hash chain
      const expectedHash = this.hashEvent(event);
      if (event.event_hash !== expectedHash) {
        this.corruptCount++;
        continue;
      }

      // Verify prev_hash chain
      if (event.seq > 1 && replayed > 0) {
        const prevEvent = this.events[event.seq - 2];
        if (prevEvent && event.prev_hash !== prevEvent.event_hash) {
          this.corruptCount++;
          continue;
        }
      }

      this.applyEvent(event);
      replayed++;
    }

    return {
      restored: true,
      events_replayed: replayed,
      last_seq: this.seqCounter,
      state: Object.fromEntries(this.state),
      corrupt_events: this.corruptCount,
    };
  }

  getEvents(): readonly SessionEvent[] {
    return [...this.events];
  }

  getEventsByType(type: EventType): SessionEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  getEventsByRun(runId: string): SessionEvent[] {
    return this.events.filter((e) => e.run_id === runId);
  }

  get lastSeq(): number {
    return this.seqCounter;
  }

  get eventCount(): number {
    return this.events.length;
  }

  get snapshotCount(): number {
    return this.snapshots.length;
  }

  getState(key: string): unknown {
    return this.state.get(key);
  }

  setState(key: string, value: unknown): void {
    this.state.set(key, value);
  }

  verifyIntegrity(): { valid: boolean; broken_chain_at: number | null } {
    for (let i = 1; i < this.events.length; i++) {
      if (this.events[i].prev_hash !== this.events[i - 1].event_hash) {
        return { valid: false, broken_chain_at: this.events[i].seq };
      }
    }
    return { valid: true, broken_chain_at: null };
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'run_created':
        this.state.set('run_id', event.run_id);
        this.state.set('status', 'created');
        break;
      case 'run_started':
        this.state.set('status', 'running');
        break;
      case 'run_completed':
        this.state.set('status', 'completed');
        break;
      case 'run_failed':
        this.state.set('status', 'failed');
        break;
      case 'run_cancelled':
        this.state.set('status', 'cancelled');
        break;
      case 'step_created':
        this.state.set(`step:${event.step_id}:status`, 'created');
        break;
      case 'step_started':
        this.state.set(`step:${event.step_id}:status`, 'running');
        break;
      case 'step_completed':
        this.state.set(`step:${event.step_id}:status`, 'completed');
        break;
      case 'step_failed':
        this.state.set(`step:${event.step_id}:status`, 'failed');
        break;
      case 'action_executed': {
        // Track executed actions for replay detection
        const executed = (this.state.get('executed_actions') as string[]) ?? [];
        executed.push(event.data.tool_name as string);
        this.state.set('executed_actions', executed);
        break;
      }
      default:
        // Other event types don't modify state directly
        break;
    }
  }

  private hashEvent(event: SessionEvent): string {
    const payload = JSON.stringify({
      seq: event.seq,
      type: event.type,
      run_id: event.run_id,
      step_id: event.step_id ?? null,
      attempt_id: event.attempt_id ?? null,
      data: event.data,
      prev_hash: event.prev_hash,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private hashSnapshot(snap: SessionSnapshot): string {
    const payload = JSON.stringify({
      version: snap.version,
      run_id: snap.run_id,
      last_seq: snap.last_seq,
      state: snap.state,
    });
    return createHash('sha256').update(payload).digest('hex');
  }
}
