/** AH-UI-PRIVACY-001: Privacy UI State Adapter */
import type { DurableSession } from '../session/durable-session.js';
import type { SecretsBroker } from '../security/secrets-broker.js';

export type UIState = 'loading' | 'ready' | 'empty' | 'denied' | 'error' | 'cancelled' | 'stale';

export interface PrivacyUIState {
  state: UIState;
  data: Record<string, unknown>;
  error?: string;
  timestamp: string;
}

export function getPrivacyUIState(session: DurableSession, secretsBroker?: SecretsBroker): PrivacyUIState {
  const status = session.getState('status') as string | undefined;
  const events = session.getEvents();
  
  let state: UIState = 'ready';
  if (!status || status === 'created') state = 'loading';
  else if (status === 'running') state = 'ready';
  else if (status === 'completed') state = 'ready';
  else if (status === 'failed') state = 'error';
  else if (status === 'cancelled') state = 'cancelled';
  
  const data: Record<string, unknown> = { status, event_count: events.length };
  
  if (secretsBroker) {
    const redactedData = secretsBroker.redact(data) as Record<string, unknown>;
    return { state, data: redactedData, timestamp: new Date().toISOString() };
  }
  
  return { state, data, timestamp: new Date().toISOString() };
}
