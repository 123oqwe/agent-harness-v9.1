/**
 * AH-CAPMAP-020: In-app notifications (local event queue, no push).
 * No external delivery (no email/push/SMS) in Phase 1.
 */
export type NotificationType = 'info' | 'warning' | 'error' | 'success' | 'approval_request';

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  created_at: string;
  read: boolean;
  expires_at: string;
  seq: number; // monotonic creation order for deterministic sort tie-break
}

export class NotificationError extends Error {
  constructor(message: string) { super(message); this.name = 'NotificationError'; Object.setPrototypeOf(this, NotificationError.prototype); }
}

const MAX_BODY = 500;
const DEFAULT_TTL_DAYS = 30;

function uid(): string { return 'n-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }

export class NotificationService {
  private readonly notifications = new Map<string, Notification>();
  private readonly userIndex = new Map<string, Set<string>>();
  private readonly ttlDays: number;
  private seq = 0;

  constructor(ttlDays = DEFAULT_TTL_DAYS) { this.ttlDays = ttlDays; }

  /** POST /notifications — requires authenticated user. */
  create(user_id: string, type: NotificationType, title: string, body: string): Notification {
    if (!user_id) throw new NotificationError('authenticated session required');
    if (body.length > MAX_BODY) throw new NotificationError(`body exceeds ${MAX_BODY} chars`);
    const now = new Date();
    const expires = new Date(now.getTime() + this.ttlDays * 86400_000);
    const n: Notification = { id: uid(), user_id, type, title, body, created_at: now.toISOString(), read: false, expires_at: expires.toISOString(), seq: ++this.seq };
    this.notifications.set(n.id, n);
    if (!this.userIndex.has(user_id)) this.userIndex.set(user_id, new Set());
    this.userIndex.get(user_id)!.add(n.id);
    return n;
  }

  /** GET /notifications — returns unread for user, sorted by created_at desc. */
  list(user_id: string, includeRead = false): Notification[] {
    const ids = this.userIndex.get(user_id);
    if (!ids) return [];
    const now = new Date().toISOString();
    return [...ids]
      .map(id => this.notifications.get(id)!)
      .filter(n => n && n.expires_at > now)
      .filter(n => includeRead || !n.read)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.seq - a.seq);
  }

  /** PATCH /notifications/{id} — mark as read. */
  markRead(user_id: string, id: string): void {
    const n = this.notifications.get(id);
    if (!n || n.user_id !== user_id) throw new NotificationError('not found or not owner');
    n.read = true;
  }

  /** DELETE /notifications/{id} — dismiss. */
  dismiss(user_id: string, id: string): void {
    const n = this.notifications.get(id);
    if (!n || n.user_id !== user_id) throw new NotificationError('not found or not owner');
    this.notifications.delete(id);
    this.userIndex.get(user_id)?.delete(id);
  }

  /** Purge expired notifications. */
  purgeExpired(): number {
    const now = new Date().toISOString();
    let purged = 0;
    for (const [id, n] of this.notifications) {
      if (n.expires_at <= now) { this.notifications.delete(id); this.userIndex.get(n.user_id)?.delete(id); purged++; }
    }
    return purged;
  }
}
