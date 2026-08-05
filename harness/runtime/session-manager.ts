/**
 * AH-RUNTIME-004: Session Manager + Steering Queue (P1-08, P2-23, P2-24)
 */
export interface SessionTaskResult { task: string; result: string; timestamp: string; run_id: string }
export interface SessionRecord { id: string; parent_session_id: string | null; depth: number; created_at: string; tasks: SessionTaskResult[] }

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly maxContextItems: number;
  private readonly maxSessionDepth: number;

  constructor(opts: { maxContextItems?: number; maxSessionDepth?: number } = {}) {
    this.maxContextItems = opts.maxContextItems ?? 3;
    this.maxSessionDepth = opts.maxSessionDepth ?? 3;
  }

  createSession(parentSessionId?: string): string {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let depth = 0;
    if (parentSessionId) {
      const parent = this.sessions.get(parentSessionId);
      if (!parent) throw new Error(`Parent session '${parentSessionId}' not found`);
      depth = parent.depth + 1;
      if (depth > this.maxSessionDepth) throw new Error(`Session tree max depth exceeded: ${depth} > ${this.maxSessionDepth}`);
    }
    this.sessions.set(id, { id, parent_session_id: parentSessionId ?? null, depth, created_at: new Date().toISOString(), tasks: [] });
    return id;
  }

  addTaskResult(sessionId: string, result: SessionTaskResult): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session '${sessionId}' not found`);
    s.tasks.push(result);
  }

  getContext(sessionId: string, maxItems?: number): SessionTaskResult[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return s.tasks.slice(-(maxItems ?? this.maxContextItems));
  }

  getSession(id: string): SessionRecord | undefined { return this.sessions.get(id); }
  fork(parentId: string): string { return this.createSession(parentId); }
}

export type SteeringQueueType = 'steer' | 'follow_up' | 'next_turn';
export const DEFAULT_STEERING_LIMITS = { steer: 5, follow_up: 10, next_turn: 20 };

export class SteeringQueue {
  private readonly queues = new Map<SteeringQueueType, string[]>();
  private readonly limits: typeof DEFAULT_STEERING_LIMITS;

  constructor(limits: Partial<typeof DEFAULT_STEERING_LIMITS> = {}) {
    this.limits = { ...DEFAULT_STEERING_LIMITS, ...limits };
    for (const t of ['steer', 'follow_up', 'next_turn'] as SteeringQueueType[]) this.queues.set(t, []);
  }

  push(type: SteeringQueueType, msg: string): { accepted: boolean; dropped?: string } {
    const q = this.queues.get(type)!;
    if (q.length >= this.limits[type]) {
      if (type === 'steer') { const dropped = q.shift()!; q.push(msg); return { accepted: true, dropped }; }
      return { accepted: false };
    }
    q.push(msg);
    return { accepted: true };
  }

  pop(type: SteeringQueueType): string | null {
    const q = this.queues.get(type);
    if (!q || q.length === 0) return null;
    return q.shift()!;
  }

  size(type: SteeringQueueType): number { return this.queues.get(type)?.length ?? 0; }
}
