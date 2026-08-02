/**
 * AH-RUNTIME-SESSION-001: Session store interface + factory.
 *
 * The session store is the durable backend for DurableSession. It provides
 * immediate per-event persistence and idempotent operation tracking so that
 * crash recovery never duplicates confirmed side effects.
 */
export {
  SqliteSessionStore,
  SqliteSessionStore as SessionStore,
} from './sqlite-session-store.js';
export {
  SqliteSessionTreeAuthority,
  type SecurityStateResolver,
  type SessionTreeScopeValue,
  type SessionTreeSecurityValue,
  type SqliteSessionTreeAuthorityOptions,
} from './sqlite-session-tree-authority.js';
export type {
  OperationRecord,
  ReceiptRecord,
  RunRecord,
  SqliteSessionStoreOptions,
} from './sqlite-session-store.js';
