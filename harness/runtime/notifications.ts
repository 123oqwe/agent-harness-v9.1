/**
 * AH-RUNTIME-001: Notifications
 *
 * Local event queue derived from session events. Not a second state store.
 * Notifications are derived views, not authoritative state.
 */

import type { SessionEvent } from '../session/durable-session.js';

export type NotificationLevel = 'info' | 'warning' | 'error';
export type NotificationCategory = 'run' | 'step' | 'action' | 'model' | 'tool' | 'security' | 'budget';

export interface Notification {
  id: string;
  level: NotificationLevel;
  category: NotificationCategory;
  message: string;
  run_id: string;
  step_id?: string;
  timestamp: string;
  source_event_seq: number;
}

export class NotificationQueue {
  private readonly notifications: Notification[] = [];
  private seqCounter = 0;

  fromEvent(event: SessionEvent): Notification | null {
    const mapping = this.mapEventToNotification(event);
    if (!mapping) return null;

    const notification: Notification = {
      id: `notif-${++this.seqCounter}`,
      level: mapping.level,
      category: mapping.category,
      message: mapping.message,
      run_id: event.run_id,
      step_id: event.step_id,
      timestamp: event.timestamp,
      source_event_seq: event.seq,
    };

    this.notifications.push(notification);
    return notification;
  }

  fromEvents(events: readonly SessionEvent[]): Notification[] {
    const results: Notification[] = [];
    for (const event of events) {
      const notif = this.fromEvent(event);
      if (notif) results.push(notif);
    }
    return results;
  }

  get all(): readonly Notification[] {
    return [...this.notifications];
  }

  get count(): number {
    return this.notifications.length;
  }

  getByLevel(level: NotificationLevel): Notification[] {
    return this.notifications.filter((n) => n.level === level);
  }

  getByCategory(category: NotificationCategory): Notification[] {
    return this.notifications.filter((n) => n.category === category);
  }

  clear(): void {
    this.notifications.length = 0;
  }

  private mapEventToNotification(event: SessionEvent): {
    level: NotificationLevel;
    category: NotificationCategory;
    message: string;
  } | null {
    switch (event.type) {
      case 'run_created':
        return { level: 'info', category: 'run', message: `Run ${event.run_id} created` };
      case 'run_started':
        return { level: 'info', category: 'run', message: `Run ${event.run_id} started` };
      case 'run_completed':
        return { level: 'info', category: 'run', message: `Run ${event.run_id} completed` };
      case 'run_failed':
        return { level: 'error', category: 'run', message: `Run ${event.run_id} failed` };
      case 'run_cancelled':
        return { level: 'warning', category: 'run', message: `Run ${event.run_id} cancelled` };
      case 'step_started':
        return { level: 'info', category: 'step', message: `Step ${event.step_id} started` };
      case 'step_completed':
        return { level: 'info', category: 'step', message: `Step ${event.step_id} completed` };
      case 'step_failed':
        return { level: 'error', category: 'step', message: `Step ${event.step_id} failed` };
      case 'action_authorized':
        return { level: 'info', category: 'security', message: `Action authorized for ${event.data.tool_name}` };
      case 'action_denied':
        return { level: 'warning', category: 'security', message: `Action denied for ${event.data.tool_name}: ${event.data.reason}` };
      case 'action_executed':
        return { level: 'info', category: 'tool', message: `Tool ${event.data.tool_name} executed` };
      case 'model_called':
        return { level: 'info', category: 'model', message: `Model called (${event.data.model})` };
      default:
        return null;
    }
  }
}
