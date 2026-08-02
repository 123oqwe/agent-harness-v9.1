import Database from "better-sqlite3";
import { createHash } from "node:crypto";

import type { SessionEvent, SessionEventType } from "./durable-session.js";
import { hashSessionEvent, isSessionEventType } from "./session-event-codec.js";
import {
  decryptSessionString,
  deriveSessionRecordKey,
  insertCanonicalSessionEvent,
  insertCanonicalSessionRun,
  runImmediateTransaction,
} from "./sqlite-authority-internals.js";

export interface SessionTreeScopeValue {
  readonly tenant_id: string;
  readonly root_session_id: string;
}

export interface SessionTreeSecurityValue {
  readonly state_hash: string;
  readonly capability_ceiling_hash: string;
  readonly authorization_epoch: number;
}

export interface SecurityStateResolver {
  resolve(
    scope: SessionTreeScopeValue,
    sessionId: string,
    persisted: SessionTreeSecurityValue,
  ): SessionTreeSecurityValue;
  isNoBroaderThan(
    candidate: SessionTreeSecurityValue,
    ceiling: SessionTreeSecurityValue,
  ): boolean;
}

export interface SqliteSessionTreeAuthorityOptions {
  readonly masterKey: Uint8Array;
  readonly security_resolver: SecurityStateResolver;
  readonly limits?: Readonly<{
    max_tree_events?: number;
    max_session_events?: number;
    max_event_bytes?: number;
    max_depth?: number;
  }>;
}

interface SessionRow {
  readonly tenant_id: string;
  readonly root_session_id: string;
  readonly session_id: string;
  readonly storage_run_id: string;
  readonly parent_session_id: string | null;
  readonly depth: number;
  readonly security_json: string;
}

interface CommandRow {
  readonly fingerprint: string;
  readonly event_seq: number;
}

interface CommitRequest {
  readonly scope: SessionTreeScopeValue;
  readonly command_id: string;
  readonly operation: "branch" | "fork" | "rewind";
  readonly child_session_id: string;
  readonly source: SessionPoint;
  readonly source_head: SessionPoint;
  readonly expected_tree_head: Readonly<{ seq: number; hash: string }>;
  readonly event_type: "branch" | "fork";
  readonly data: unknown;
}

interface SessionPoint extends SessionTreeScopeValue {
  readonly session_id: string;
  readonly seq: number;
  readonly hash: string;
  readonly security: SessionTreeSecurityValue;
}

function sessionTreeSchema(): string {
  return `CREATE TABLE IF NOT EXISTS session_tree_scopes (
  tenant_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  tree_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, root_session_id)
);
CREATE TABLE IF NOT EXISTS session_tree_sessions (
  tenant_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  storage_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  parent_session_id TEXT,
  depth INTEGER NOT NULL,
  security_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, root_session_id, session_id),
  FOREIGN KEY (tenant_id, root_session_id)
    REFERENCES session_tree_scopes(tenant_id, root_session_id)
);
CREATE TABLE IF NOT EXISTS session_tree_commands (
  tenant_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, root_session_id, command_id),
  UNIQUE (tenant_id, root_session_id, child_session_id),
  FOREIGN KEY (tenant_id, root_session_id)
    REFERENCES session_tree_scopes(tenant_id, root_session_id)
);
`;
}

class SessionTreeAuthorityFault extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionTreeAuthorityFault";
    this.code = code;
  }
}

function fault(code: string, message: string): never {
  throw new SessionTreeAuthorityFault(code, message);
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

export class SqliteSessionTreeAuthority {
  readonly #db: Database.Database;
  readonly #recordKey: Buffer;
  readonly #resolver: SecurityStateResolver;
  readonly #limits: Required<NonNullable<SqliteSessionTreeAuthorityOptions["limits"]>>;
  #closed = false;

  constructor(dbPath: string, options: SqliteSessionTreeAuthorityOptions) {
    if (!options || !options.masterKey || options.masterKey.byteLength !== 32) {
      throw new Error("32-byte masterKey is required");
    }
    if (
      !options.security_resolver ||
      typeof options.security_resolver.resolve !== "function" ||
      typeof options.security_resolver.isNoBroaderThan !== "function"
    ) {
      throw new Error("security_resolver is required");
    }
    this.#resolver = options.security_resolver;
    this.#limits = {
      max_tree_events: options.limits?.max_tree_events ?? 100_000,
      max_session_events: options.limits?.max_session_events ?? 100_000,
      max_event_bytes: options.limits?.max_event_bytes ?? 4 * 1024 * 1024,
      max_depth: options.limits?.max_depth ?? 1_024,
    };
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
    this.#db = new Database(dbPath);
    try {
      this.#db.pragma("foreign_keys = ON");
      this.#db.pragma("busy_timeout = 5000");
      this.#db.exec(sessionTreeSchema());
      this.#db
        .prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES (?, '1')")
        .run("session_tree_schema_version");
      const schemaVersion = this.#db
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get("session_tree_schema_version") as { value: string } | undefined;
      if (!schemaVersion || schemaVersion.value !== "1") {
        throw new Error("unsupported session tree schema version");
      }
      this.#recordKey = deriveSessionRecordKey(this.#db, options.masterKey);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  bindRoot(
    scope: SessionTreeScopeValue,
    storageRunId: string,
    security: SessionTreeSecurityValue,
  ): void {
    this.#assertOpen();
    const run = this.#db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(storageRunId);
    if (!run) fault("SOURCE_NOT_FOUND", "root durable session does not exist");
    const securityJson = stable(this.#validatedSecurity(security));
    runImmediateTransaction(this.#db, () => {
      const existing = this.#db
        .prepare(
          "SELECT tree_run_id FROM session_tree_scopes WHERE tenant_id = ? AND root_session_id = ?",
        )
        .get(scope.tenant_id, scope.root_session_id) as
        | { tree_run_id: string }
        | undefined;
      if (existing && existing.tree_run_id !== storageRunId) {
        fault("SESSION_CONFLICT", "root scope is already bound");
      }
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO session_tree_scopes VALUES (?, ?, ?, ?)",
        )
        .run(scope.tenant_id, scope.root_session_id, storageRunId, new Date().toISOString());
      const prior = this.#session(scope, scope.root_session_id);
      if (prior && (prior.storage_run_id !== storageRunId || prior.security_json !== securityJson)) {
        fault("SESSION_CONFLICT", "root session binding conflicts");
      }
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO session_tree_sessions VALUES (?, ?, ?, ?, NULL, 0, ?, ?)",
        )
        .run(
          scope.tenant_id,
          scope.root_session_id,
          scope.root_session_id,
          storageRunId,
          securityJson,
          new Date().toISOString(),
        );
    });
  }

  async loadTree(scope: SessionTreeScopeValue) {
    this.#assertOpen();
    const treeRunId = this.#treeRunId(scope);
    const events = this.#verifiedEvents(treeRunId, this.#limits.max_tree_events);
    return { ...scope, events };
  }

  async readSessionHead(scope: SessionTreeScopeValue, sessionId: string) {
    this.#assertOpen();
    const row = this.#session(scope, sessionId);
    if (!row) return null;
    const events = this.#verifiedEvents(row.storage_run_id, this.#limits.max_session_events);
    return this.#point(scope, row, events.at(-1) ?? null);
  }

  async readSessionPoint(
    scope: SessionTreeScopeValue,
    sessionId: string,
    seq: number,
  ) {
    this.#assertOpen();
    const row = this.#session(scope, sessionId);
    if (!row) return null;
    const events = this.#verifiedEvents(row.storage_run_id, this.#limits.max_session_events);
    return this.#point(scope, row, events[seq - 1] ?? null);
  }

  async appendLineageEvent(request: CommitRequest) {
    this.#assertOpen();
    const expectedEventType = request.operation === "fork" ? "fork" : "branch";
    const expectedData = {
      version: 1,
      command_id: request.command_id,
      operation: request.operation,
      child_session_id: request.child_session_id,
      source: request.source,
      source_head: request.source_head,
      replay_policy: "lineage_only_no_effect_replay",
    };
    if (
      request.event_type !== expectedEventType ||
      stable(request.data) !== stable(expectedData)
    ) {
      fault(
        "AUTHORITY_VIOLATION",
        "lineage event does not match the authority commit request",
      );
    }
    const fingerprint = stable({
      operation: request.operation,
      child: request.child_session_id,
      source: request.source,
      source_head: request.source_head,
      event_type: request.event_type,
      data: request.data,
    });
    return runImmediateTransaction(this.#db, () => {
      const treeRunId = this.#treeRunId(request.scope);
      const existing = this.#db
        .prepare(
          "SELECT fingerprint, event_seq FROM session_tree_commands WHERE tenant_id = ? AND root_session_id = ? AND command_id = ?",
        )
        .get(
          request.scope.tenant_id,
          request.scope.root_session_id,
          request.command_id,
        ) as CommandRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          fault("COMMAND_CONFLICT", "command_id has a conflicting durable meaning");
        }
        const event = this.#verifiedEvents(treeRunId, this.#limits.max_tree_events)[
          existing.event_seq - 1
        ];
        if (!event) fault("CORRUPT_LOG", "idempotency index points to a missing event");
        return { event, duplicate: true };
      }

      const treeEvents = this.#verifiedEvents(treeRunId, this.#limits.max_tree_events);
      const actualHead = treeEvents.at(-1);
      if (
        request.expected_tree_head.seq !== treeEvents.length ||
        request.expected_tree_head.hash !== (actualHead?.hash ?? "")
      ) {
        fault("TREE_HEAD_CONFLICT", "session tree head advanced concurrently");
      }
      if (treeEvents.length >= this.#limits.max_tree_events) {
        fault("RESOURCE_LIMIT", "session tree event limit reached");
      }
      if (this.#session(request.scope, request.child_session_id)) {
        fault("SESSION_CONFLICT", "child session already exists");
      }
      const sourceRow = this.#session(request.scope, request.source.session_id);
      if (!sourceRow) fault("SOURCE_NOT_FOUND", "source session does not exist");
      if (sourceRow.depth >= this.#limits.max_depth) {
        fault("RESOURCE_LIMIT", "session tree depth limit reached");
      }
      const sourceEvents = this.#verifiedEvents(
        sourceRow.storage_run_id,
        this.#limits.max_session_events,
      );
      const sourceEvent = request.source.seq === 0 ? null : sourceEvents[request.source.seq - 1];
      const sourceHead = sourceEvents.at(-1) ?? null;
      if (
        request.source.seq !== (sourceEvent?.seq ?? 0) ||
        request.source.hash !== (sourceEvent?.hash ?? "") ||
        request.source_head.seq !== (sourceHead?.seq ?? 0) ||
        request.source_head.hash !== (sourceHead?.hash ?? "")
      ) {
        fault("STALE_SOURCE", "source session point changed");
      }
      const effective = this.#effectiveSecurity(request.scope, sourceRow);
      if (
        stable(request.source.security) !== stable(effective) ||
        stable(request.source_head.security) !== stable(effective)
      ) {
        fault("AUTHORITY_VIOLATION", "source security state is stale or broader");
      }
      if (
        Buffer.byteLength(stable(request.data)) >
        this.#limits.max_event_bytes
      ) {
        fault("RESOURCE_LIMIT", "session event payload limit exceeded");
      }

      const event = this.#newEvent(
        treeEvents.length + 1,
        request.event_type,
        request.data,
        actualHead?.hash ?? "",
      );
      const physicalChildId = `__session_tree__${createHash("sha256")
        .update(
          `${request.scope.tenant_id}\0${request.scope.root_session_id}\0${request.child_session_id}`,
        )
        .digest("hex")}`;
      insertCanonicalSessionRun(
        this.#db,
        this.#recordKey,
        physicalChildId,
        "session tree child",
        "session_tree",
        event.timestamp,
      );
      this.#insertEvent(treeRunId, event);
      const childEvent = this.#newEvent(1, request.event_type, request.data, "");
      this.#insertEvent(physicalChildId, childEvent);
      this.#db
        .prepare(
          "INSERT INTO session_tree_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          request.scope.tenant_id,
          request.scope.root_session_id,
          request.child_session_id,
          physicalChildId,
          request.source.session_id,
          sourceRow.depth + 1,
          stable(effective),
          event.timestamp,
        );
      this.#db
        .prepare(
          "INSERT INTO session_tree_commands VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          request.scope.tenant_id,
          request.scope.root_session_id,
          request.command_id,
          request.child_session_id,
          fingerprint,
          event.seq,
        );
      return { event, duplicate: false };
    });
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#db.close();
    } finally {
      this.#recordKey.fill(0);
      this.#closed = true;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("session tree authority is closed");
  }

  #treeRunId(scope: SessionTreeScopeValue): string {
    const row = this.#db
      .prepare(
        "SELECT tree_run_id FROM session_tree_scopes WHERE tenant_id = ? AND root_session_id = ?",
      )
      .get(scope.tenant_id, scope.root_session_id) as
      | { tree_run_id: string }
      | undefined;
    if (!row) fault("SOURCE_NOT_FOUND", "session tree scope does not exist");
    return row.tree_run_id;
  }

  #session(scope: SessionTreeScopeValue, sessionId: string): SessionRow | null {
    return (
      (this.#db
        .prepare(
          "SELECT * FROM session_tree_sessions WHERE tenant_id = ? AND root_session_id = ? AND session_id = ?",
        )
        .get(scope.tenant_id, scope.root_session_id, sessionId) as
        | SessionRow
        | undefined) ?? null
    );
  }

  #point(scope: SessionTreeScopeValue, row: SessionRow, event: SessionEvent | null) {
    const security = this.#effectiveSecurity(scope, row);
    return {
      ...scope,
      session_id: row.session_id,
      seq: event?.seq ?? 0,
      hash: event?.hash ?? "",
      security,
    };
  }

  #effectiveSecurity(scope: SessionTreeScopeValue, row: SessionRow) {
    let persisted: SessionTreeSecurityValue;
    try {
      persisted = this.#validatedSecurity(JSON.parse(row.security_json));
    } catch {
      fault("CORRUPT_LOG", "persisted security state is malformed");
    }
    const candidate = this.#validatedSecurity(
      this.#resolver.resolve(scope, row.session_id, persisted),
    );
    if (!this.#resolver.isNoBroaderThan(candidate, persisted)) {
      fault("AUTHORITY_VIOLATION", "security resolver attempted privilege expansion");
    }
    return candidate;
  }

  #validatedSecurity(value: SessionTreeSecurityValue): SessionTreeSecurityValue {
    if (
      !value ||
      !/^[0-9a-f]{64}$/.test(value.state_hash) ||
      !/^[0-9a-f]{64}$/.test(value.capability_ceiling_hash) ||
      !Number.isSafeInteger(value.authorization_epoch) ||
      value.authorization_epoch < 0
    ) {
      fault("AUTHORITY_VIOLATION", "security state is malformed");
    }
    return {
      state_hash: value.state_hash,
      capability_ceiling_hash: value.capability_ceiling_hash,
      authorization_epoch: value.authorization_epoch,
    };
  }

  #verifiedEvents(runId: string, limit: number): SessionEvent[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, type, timestamp, data_json, hash, prev_hash FROM events WHERE run_id = ? ORDER BY seq LIMIT ?",
      )
      .all(runId, limit + 1) as Array<{
      seq: number;
      type: SessionEventType;
      timestamp: string;
      data_json: string;
      hash: string;
      prev_hash: string;
    }>;
    if (rows.length > limit) fault("RESOURCE_LIMIT", "session event limit exceeded");
    let previousHash = "";
    return rows.map((row, index) => {
      if (
        row.seq !== index + 1 ||
        !isSessionEventType(row.type) ||
        typeof row.timestamp !== "string" ||
        row.timestamp.length === 0 ||
        row.prev_hash !== previousHash
      ) {
        fault("CORRUPT_LOG", `invalid session event envelope at ${index + 1}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(
          decryptSessionString(
            this.#recordKey,
            row.data_json,
            `events:${runId}:${row.seq}:data_json`,
          ),
        );
      } catch {
        fault("CORRUPT_LOG", `invalid session event data at ${index + 1}`);
      }
      if (Buffer.byteLength(stable(data)) > this.#limits.max_event_bytes) {
        fault("RESOURCE_LIMIT", "session event payload limit exceeded");
      }
      const event: SessionEvent = {
        seq: row.seq,
        type: row.type,
        timestamp: row.timestamp,
        data,
        hash: row.hash,
        prev_hash: row.prev_hash,
      };
      if (
        hashSessionEvent(
          event.seq,
          event.type,
          event.timestamp,
          event.data,
          event.prev_hash,
        ) !== row.hash
      ) {
        fault("CORRUPT_LOG", `session event hash mismatch at ${index + 1}`);
      }
      previousHash = row.hash;
      return event;
    });
  }

  #newEvent(
    seq: number,
    type: "branch" | "fork",
    data: unknown,
    prevHash: string,
  ): SessionEvent {
    const timestamp = new Date().toISOString();
    const eventWithoutHash = { seq, type, timestamp, data, prev_hash: prevHash };
    return {
      ...eventWithoutHash,
      hash: hashSessionEvent(seq, type, timestamp, data, prevHash),
    };
  }

  #insertEvent(runId: string, event: SessionEvent): void {
    insertCanonicalSessionEvent(this.#db, this.#recordKey, runId, event);
  }
}
