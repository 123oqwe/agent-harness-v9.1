/**
 * AH-RUNTIME-002: Event Bus (P1-06, P2-18)
 * Pub/sub for streaming agent activity to external consumers.
 * Events flow: loop → EventBus → SSE/WebSocket → UI.
 */
export type StreamEventType =
  | 'tool_call_start' | 'tool_result' | 'step_transition'
  | 'error_event' | 'run_state_change' | 'command_output'
  | 'plan_ready' | 'cost_estimate' | 'model_called' | 'paused' | 'resumed' | 'text_delta';

export interface BusEvent {
  readonly type: StreamEventType;
  readonly run_id: string;
  readonly step_id?: string | undefined;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

export type StreamMode = 'values' | 'updates' | 'messages' | 'custom' | 'debug';

export interface EventBusOptions {
  readonly mode?: StreamMode;
  readonly batchMs?: number;
}

export class EventBus {
  private readonly subscribers = new Set<(event: BusEvent) => void>();
  private readonly mode: StreamMode;
  private readonly batchMs: number;
  private readonly buffered: BusEvent[] = [];
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
      this.buffered.push(event);
      const now = Date.now();
      if (now - this.lastFlush >= this.batchMs) { this.lastFlush = now; this.flush(); }
    } else {
      for (const h of this.subscribers) { try { h(event); } catch { /* subscriber errors swallowed */ } }
    }
  }

  flush(): void {
    for (const e of this.buffered) {
      for (const h of this.subscribers) { try { h(e); } catch { /* */ } }
    }
    this.buffered.length = 0;
  }

  get events(): readonly BusEvent[] { return [...this.buffered]; }
}

export function createEvent(
  type: StreamEventType,
  runId: string,
  data: Record<string, unknown>,
  stepId?: string,
): BusEvent {
  return {
    type,
    run_id: runId,
    timestamp: new Date().toISOString(),
    data,
    ...(stepId !== undefined ? { step_id: stepId } : {}),
  };
}
