/**
 * AH-RUNTIME-002: Event Bus (P1-06, P1-07)
 *
 * Pub/sub event system for streaming agent activity to external consumers.
 * Replaces direct _log_iteration calls with publish/subscribe pattern.
 * Events flow: kernel -> EventBus -> SSE/WebSocket -> UI.
 */

export type StreamEventType =
  | 'tool_call_start'
  | 'tool_result'
  | 'step_transition'
  | 'error_event'
  | 'run_state_change'
  | 'command_output'
  | 'plan_ready'
  | 'cost_estimate'
  | 'model_called'
  | 'paused'
  | 'resumed';

export interface BusEvent {
  type: StreamEventType;
  run_id: string;
  step_id?: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export type StreamMode = 'values' | 'updates' | 'messages' | 'custom' | 'debug';

export interface EventBusOptions {
  mode?: StreamMode;
  batchMs?: number;
}

export class EventBus {
  private readonly subscribers = new Set<(event: BusEvent) => void>();
  private readonly bufferedEvents: BusEvent[] = [];
  private readonly mode: StreamMode;
  private readonly batchMs: number;
  private lastFlush = Date.now();

  constructor(opts: EventBusOptions = {}) {
    this.mode = opts.mode ?? 'updates';
    this.batchMs = opts.batchMs ?? 50;
  }

  subscribe(handler: (event: BusEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => { this.subscribers.delete(handler); };
  }

  publish(event: BusEvent): void {
    if (this.mode === 'values') {
      this.bufferedEvents.push(event);
      this.maybeFlush();
    } else {
      this.emit(event);
    }
  }

  get events(): readonly BusEvent[] {
    return [...this.bufferedEvents];
  }

  private emit(event: BusEvent): void {
    for (const handler of this.subscribers) {
      try { handler(event); } catch { /* subscriber errors swallowed */ }
    }
  }

  private maybeFlush(): void {
    const now = Date.now();
    if (now - this.lastFlush >= this.batchMs) {
      this.lastFlush = now;
      this.flush();
    }
  }

  flush(): void {
    for (const event of this.bufferedEvents) { this.emit(event); }
    this.bufferedEvents.length = 0;
  }
}

export function createEvent(
  type: StreamEventType,
  runId: string,
  data: Record<string, unknown>,
  stepId?: string,
): BusEvent {
  return { type, run_id: runId, step_id: stepId, timestamp: new Date().toISOString(), data };
}
