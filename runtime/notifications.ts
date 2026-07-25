/**
 * AH-CAPMAP-020: In-app notifications (local event queue, no push).
 * No external delivery (no email/push/SMS) in Phase 1.
 */
import { randomUUID } from 'node:crypto';

export type NotificationType =
  | 'info'
  | 'warning'
  | 'error'
  | 'success'
  | 'approval_request';

export interface Notification {
  readonly id: string;
  readonly user_id: string;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly created_at: string;
  readonly read: boolean;
  readonly expires_at: string;
  readonly seq: number;
}

export interface NotificationServiceOptions {
  readonly ttlDays?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class NotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationError';
    Object.setPrototypeOf(this, NotificationError.prototype);
  }
}

const MAX_BODY = 500;
const DEFAULT_TTL_DAYS = 30;
const DAY_MS = 86_400_000;
const TYPES = new Set<NotificationType>([
  'info',
  'warning',
  'error',
  'success',
  'approval_request',
]);

function publicNotification(value: Notification): Notification {
  return Object.freeze({ ...value });
}

export class NotificationService {
  private readonly notifications = new Map<string, Notification>();
  private readonly userIndex = new Map<string, Set<string>>();
  private readonly ttlDays: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private seq = 0;

  constructor(options: number | NotificationServiceOptions = {}) {
    const normalized =
      typeof options === 'number' ? { ttlDays: options } : options;
    const ttlDays = normalized.ttlDays ?? DEFAULT_TTL_DAYS;
    if (!Number.isFinite(ttlDays) || ttlDays < 0) {
      throw new NotificationError('ttlDays must be a non-negative number');
    }
    this.ttlDays = ttlDays;
    this.now = normalized.now ?? (() => new Date());
    this.createId = normalized.createId ?? randomUUID;
  }

  create(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
  ): Notification {
    if (userId.trim().length === 0) {
      throw new NotificationError('authenticated session required');
    }
    if (!TYPES.has(type)) {
      throw new NotificationError('unsupported notification type');
    }
    if (title.trim().length === 0) {
      throw new NotificationError('title is required');
    }
    if (body.length > MAX_BODY) {
      throw new NotificationError(`body exceeds ${MAX_BODY} chars`);
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new NotificationError('clock returned an invalid date');
    }
    const id = this.createId();
    if (id.trim().length === 0 || this.notifications.has(id)) {
      throw new NotificationError('notification id must be non-empty and unique');
    }
    const value: Notification = Object.freeze({
      id,
      user_id: userId,
      type,
      title,
      body,
      created_at: now.toISOString(),
      read: false,
      expires_at: new Date(now.getTime() + this.ttlDays * DAY_MS).toISOString(),
      seq: ++this.seq,
    });
    this.notifications.set(id, value);
    const ids = this.userIndex.get(userId) ?? new Set<string>();
    ids.add(id);
    this.userIndex.set(userId, ids);
    return publicNotification(value);
  }

  list(userId: string, includeRead = false): Notification[] {
    const ids = this.userIndex.get(userId);
    if (ids === undefined) return [];
    const now = this.now().getTime();
    return [...ids]
      .map((id) => this.notifications.get(id))
      .filter(
        (value): value is Notification =>
          value !== undefined && Date.parse(value.expires_at) > now,
      )
      .filter((value) => includeRead || !value.read)
      .sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at) ||
          right.seq - left.seq,
      )
      .map(publicNotification);
  }

  markRead(userId: string, id: string): void {
    const value = this.owned(userId, id);
    this.notifications.set(id, Object.freeze({ ...value, read: true }));
  }

  dismiss(userId: string, id: string): void {
    this.owned(userId, id);
    this.notifications.delete(id);
    const ids = this.userIndex.get(userId)!;
    ids.delete(id);
    if (ids.size === 0) this.userIndex.delete(userId);
  }

  purgeExpired(): number {
    const now = this.now().getTime();
    let purged = 0;
    for (const [id, value] of this.notifications) {
      if (Date.parse(value.expires_at) <= now) {
        this.notifications.delete(id);
        const ids = this.userIndex.get(value.user_id);
        ids?.delete(id);
        if (ids?.size === 0) this.userIndex.delete(value.user_id);
        purged += 1;
      }
    }
    return purged;
  }

  private owned(userId: string, id: string): Notification {
    const value = this.notifications.get(id);
    if (value === undefined || value.user_id !== userId) {
      throw new NotificationError('not found or not owner');
    }
    return value;
  }
}
