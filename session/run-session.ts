import { join } from 'node:path';

import type { RunPlan } from '../router/static-router.js';
import {
  DurableSession,
  type SessionEvent,
} from './durable-session.js';
import {
  SqliteSessionStore,
  type RunRecord,
} from './sqlite-session-store.js';

export interface RunSessionConfig {
  runId: string;
  goal: string;
  strategy: RunPlan['reasoning_strategy'] | undefined;
  clock: () => string;
  dataDir: string | undefined;
  masterKey: Uint8Array | undefined;
}

export interface OpenRunSession {
  store: SqliteSessionStore | null;
  session: DurableSession;
  existingEvents: readonly SessionEvent[];
  persistedRun: RunRecord | null;
}

export function openRunSession(config: RunSessionConfig): OpenRunSession {
  let store: SqliteSessionStore | null = null;
  try {
    if (config.dataDir !== undefined) {
      if (config.masterKey?.byteLength !== 32) {
        throw new Error(
          '32-byte sessionMasterKey is required for durable sessions',
        );
      }
      store = new SqliteSessionStore(join(config.dataDir, 'session.db'), {
        masterKey: config.masterKey,
      });
      store.createRun(config.runId, config.goal, config.strategy);
    }
    const existingEvents = store?.loadEvents(config.runId) ?? [];
    const latestSnapshot = store?.getLatestSnapshot(config.runId) ?? null;
    const eventHeadHash = existingEvents.at(-1)?.hash ?? '';
    const usableSnapshot =
      latestSnapshot !== null &&
      latestSnapshot.last_seq === existingEvents.length &&
      latestSnapshot.last_hash === eventHeadHash
        ? latestSnapshot
        : null;
    const persistedRun = store?.getRun(config.runId) ?? null;
    const options = {
      persistence: store ?? undefined,
      clock: config.clock,
    };
    const session = DurableSession.restore(
      {
        session_id: config.runId,
        events: existingEvents,
        snapshot: usableSnapshot,
      },
      options,
    );
    session.acquireWriter();
    return {
      store,
      session,
      existingEvents: Object.freeze([...existingEvents]),
      persistedRun,
    };
  } catch (error) {
    store?.close();
    throw error;
  }
}

export function isTerminalRun(
  opened: OpenRunSession,
): opened is OpenRunSession & { persistedRun: RunRecord } {
  return (
    opened.existingEvents.length > 0 &&
    opened.persistedRun !== null &&
    opened.persistedRun.status !== 'running'
  );
}
