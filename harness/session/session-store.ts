/**
 * AH-RUNTIME-SESSION-001: Session store interface + factory.
 *
 * The session store is the durable backend for DurableSession. It provides
 * immediate per-event persistence and idempotent operation tracking so that
 * crash recovery never duplicates confirmed side effects.
 */
export type { SqliteSessionStore, OperationRecord, ReceiptRecord } from './sqlite-session-store.js';
export { SqliteSessionStore as SessionStore } from './sqlite-session-store.js';
