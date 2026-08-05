/**
 * AH-RUNTIME-002: Event Bus (P1-06, P2-18)
 * Pub/sub for streaming agent activity. Events flow: loop -> EventBus -> UI.
 */
export type StreamEventType =
  | 'tool_call_start' | 'tool_result' | 'step_transition'
  | 'error_event' | 'run_state_change' | 'command_output'
  | 'plan_ready' | 'cost_estimate' | 'model_called' | 'paused' | 'resumed';

export interface BusEvent {
  type: StreamEventType;
  run_id: string;
  step_id?: string | undefined;
  timestamp: string;
  data: Record<string, unknown>;
}

export type StreamMode = 'values' | 'updates' | 'messages' | 'custom' | 'debug';

export class EventBus {
  private readonly subscribers = new Set<(event: BusEvent) => void>();
  private readonly mode: StreamMode;
  private readonly batchMs: number;
  private readonly buffered: BusEvent[] = [];
  private lastFlush = Date.now();

  constructor(opts: { mode?: StreamMode; batchMs?: number } = {}) {
    this.mode = opts.mode ?? 'updates';
    this.batchMs = opts.batchMs ?? 50;
  }

  subscribe(handler: (event: BusEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => { this.subscribers.delete(handler); };
  }

  publish(event: BusEvent): void {
    if (this.mode === 'values') {
      this.buffered.push(event);
      const now = Date.now();
      if (now - this.lastFlush >= this.batchMs) { this.lastFlush = now; this.flush(); }
    } else {
      for (const h of this.subscribers) { try { h(event); } catch { /* swallow */ } }
    }
  }

  flush(): void {
    for (const e of this.buffered) for (const h of this.subscribers) { try { h(e); } catch { /* */ } }
    this.buffered.length = 0;
  }

  get events(): readonly BusEvent[] { return [...this.buffered]; }
}

export function createEvent(type: StreamEventType, runId: string, data: Record<string, unknown>, stepId?: string): BusEvent {
  const event: BusEvent = { type, run_id: runId, timestamp: new Date().toISOString(), data };
  if (stepId !== undefined) event.step_id = stepId;
  return event;
}
