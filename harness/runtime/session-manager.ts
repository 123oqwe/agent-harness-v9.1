/**
 * AH-RUNTIME-004: Session Manager + Steering Queue (P1-08, P1-07, P2-23, P2-24)
 *
 * Multi-turn conversation support with session tree (fork/branch, max depth).
 * Steering queues with per-queue size limits.
 */

export interface SessionTaskResult {
  task: string;
  result: string;
  timestamp: string;
  run_id: string;
}

export interface SessionRecord {
  id: string;
  parent_session_id: string | null;
  depth: number;
  created_at: string;
  tasks: SessionTaskResult[];
}

export interface SessionManagerOptions {
  maxContextItems: number;
  maxSessionDepth: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly options: SessionManagerOptions;

  constructor(options: Partial<SessionManagerOptions> = {}) {
    this.options = {
      maxContextItems: options.maxContextItems ?? 3,
      maxSessionDepth: options.maxSessionDepth ?? 3,
    };
  }

  createSession(parentSessionId?: string): string {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let depth = 0;
    if (parentSessionId) {
      const parent = this.sessions.get(parentSessionId);
      if (!parent) throw new Error(`Parent session '${parentSessionId}' not found`);
      depth = parent.depth + 1;
      if (depth > this.options.maxSessionDepth) {
        throw new Error(`Session tree max depth exceeded: ${depth} > ${this.options.maxSessionDepth} (P2-23)`);
      }
    }
    this.sessions.set(id, { id, parent_session_id: parentSessionId ?? null, depth, created_at: new Date().toISOString(), tasks: [] });
    return id;
  }

  addTaskResult(sessionId: string, result: SessionTaskResult): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);
    session.tasks.push(result);
  }

  getContext(sessionId: string, maxItems?: number): SessionTaskResult[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.tasks.slice(-(maxItems ?? this.options.maxContextItems));
  }

  getSession(sessionId: string): SessionRecord | undefined { return this.sessions.get(sessionId); }
  listSessions(): SessionRecord[] { return [...this.sessions.values()]; }
  fork(parentSessionId: string): string { return this.createSession(parentSessionId); }
  get maxSessionDepth(): number { return this.options.maxSessionDepth; }
}

export type SteeringQueueType = 'steer' | 'follow_up' | 'next_turn';

export interface SteeringQueueLimits {
  steer: number;
  follow_up: number;
  next_turn: number;
}

export const DEFAULT_STEERING_LIMITS: SteeringQueueLimits = { steer: 5, follow_up: 10, next_turn: 20 };

export class SteeringQueue {
  private readonly queues = new Map<SteeringQueueType, string[]>();
  private readonly limits: SteeringQueueLimits;

  constructor(limits: Partial<SteeringQueueLimits> = {}) {
    this.limits = { ...DEFAULT_STEERING_LIMITS, ...limits };
    this.queues.set('steer', []);
    this.queues.set('follow_up', []);
    this.queues.set('next_turn', []);
  }

  push(type: SteeringQueueType, message: string): { accepted: boolean; dropped?: string } {
    const queue = this.queues.get(type)!;
    const limit = this.limits[type];
    if (queue.length >= limit) {
      if (type === 'steer') {
        const dropped = queue.shift()!;
        queue.push(message);
        return { accepted: true, dropped };
      }
      return { accepted: false };
    }
    queue.push(message);
    return { accepted: true };
  }

  pop(type: SteeringQueueType): string | null {
    const queue = this.queues.get(type);
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }

  size(type: SteeringQueueType): number { return this.queues.get(type)?.length ?? 0; }
  clear(type?: SteeringQueueType): void {
    if (type) { this.queues.get(type)!.length = 0; }
    else { for (const q of this.queues.values()) q.length = 0; }
  }
}
