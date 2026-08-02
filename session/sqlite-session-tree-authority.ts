import Database from "better-sqlite3";
import { createHash, createHmac } from "node:crypto";

import {
  DurableSession,
  type SessionEvent,
  type SessionEventType,
  type SessionPersistencePort,
  type SessionSnapshot,
} from "./durable-session.js";
import { hashSessionEvent, isSessionEventType } from "./session-event-codec.js";
import {
  FileSessionTreeCheckpoint,
  type SessionTreeCheckpointHeads,
  type SessionTreeCheckpointPort,
} from "./session-tree-checkpoint.js";
import {
  decryptSessionString,
  deriveSessionRecordKey,
  authenticateSessionRecordKey,
  encodeLengthPrefixedIdentifiers,
  encryptSessionString,
  insertCanonicalSessionEvent,
  insertCanonicalSessionRun,
  runImmediateTransaction,
  validateDurableIdentifier,
} from "./sqlite-authority-internals.js";
import {
  assertSessionDatabaseIdentity,
  preflightExistingSessionDatabase,
} from "./sqlite-session-store.js";
import type { TrustedSessionStateRoot } from "./session-state-root.js";

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
  readonly state_root: TrustedSessionStateRoot;
  readonly security_resolver: SecurityStateResolver;
  readonly checkpoint?: SessionTreeCheckpointPort;
  readonly limits?: Readonly<{
    max_tree_events?: number;
    max_session_events?: number;
    max_event_bytes?: number;
    max_snapshot_bytes?: number;
    max_session_bytes?: number;
    max_tree_bytes?: number;
    max_recovery_bytes?: number;
    max_recovery_rows?: number;
    max_depth?: number;
  }>;
  /** Test seam exposes only whether constructor-failure disposal zeroed the key. */
  readonly _test_on_record_key_disposed?: (allZero: boolean) => void;
}

export interface LogicalSessionHandle {
  readonly logical_session_id: string;
  readonly session: DurableSession;
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
  readonly child_session_id: string;
  readonly fingerprint: string;
  readonly event_seq: number;
}

interface PersistedEventRow {
  readonly run_id: string;
  readonly seq: number;
  readonly type: SessionEventType;
  readonly timestamp: string;
  readonly data_json: string;
  readonly hash: string;
  readonly prev_hash: string;
}

interface SessionRecoveryProjection {
  readonly sessions: ReadonlyMap<string, SessionRow>;
  readonly events: ReadonlyMap<string, readonly PersistedEventRow[]>;
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

const SESSION_TREE_TABLES = [
  "session_tree_scopes",
  "session_tree_sessions",
  "session_tree_commands",
] as const;

type TableColumn = Readonly<{
  name: string;
  type: string;
  notnull: number;
  pk: number;
}>;

const EXPECTED_COLUMNS: Readonly<Record<(typeof SESSION_TREE_TABLES)[number], readonly TableColumn[]>> = {
  session_tree_scopes: [
    { name: "tenant_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "root_session_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "tree_run_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  session_tree_sessions: [
    { name: "tenant_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "root_session_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "session_id", type: "TEXT", notnull: 1, pk: 3 },
    { name: "storage_run_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "parent_session_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "depth", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "security_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  session_tree_commands: [
    { name: "tenant_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "root_session_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "command_id", type: "TEXT", notnull: 1, pk: 3 },
    { name: "child_session_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "fingerprint", type: "TEXT", notnull: 1, pk: 0 },
    { name: "event_seq", type: "INTEGER", notnull: 1, pk: 0 },
  ],
};

function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session_tree_%'",
      )
      .all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function uniqueIndexExists(
  db: Database.Database,
  table: string,
  columns: readonly string[],
): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
  }>;
  return indexes.some((index) => {
    if (index.unique !== 1) return false;
    const actual = (
      db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{
        seqno: number;
        name: string;
      }>
    )
      .sort((left, right) => left.seqno - right.seqno)
      .map((entry) => entry.name);
    return stable(actual) === stable(columns);
  });
}

function foreignKeyExists(
  db: Database.Database,
  table: string,
  target: string,
  from: readonly string[],
  to: readonly string[],
): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
  }>;
  const grouped = new Map<number, typeof rows>();
  rows.forEach((row) => grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]));
  return [...grouped.values()].some((group) => {
    const ordered = [...group].sort((left, right) => left.seq - right.seq);
    return (
      ordered[0]?.table === target &&
      stable(ordered.map((entry) => entry.from)) === stable(from) &&
      stable(ordered.map((entry) => entry.to)) === stable(to)
    );
  });
}

function validateSessionTreeSchema(db: Database.Database): void {
  const names = tableNames(db);
  if (
    names.size !== SESSION_TREE_TABLES.length ||
    SESSION_TREE_TABLES.some((name) => !names.has(name))
  ) {
    throw new Error("session tree schema is malformed");
  }
  for (const table of SESSION_TREE_TABLES) {
    const columns = (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<TableColumn & { cid: number }>
    ).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
    if (stable(columns) !== stable(EXPECTED_COLUMNS[table])) {
      throw new Error("session tree schema is malformed");
    }
  }
  if (
    !uniqueIndexExists(db, "session_tree_scopes", ["tree_run_id"]) ||
    !uniqueIndexExists(db, "session_tree_sessions", ["storage_run_id"]) ||
    !uniqueIndexExists(db, "session_tree_commands", [
      "tenant_id",
      "root_session_id",
      "child_session_id",
    ]) ||
    !foreignKeyExists(db, "session_tree_scopes", "runs", ["tree_run_id"], ["run_id"]) ||
    !foreignKeyExists(db, "session_tree_sessions", "runs", ["storage_run_id"], ["run_id"]) ||
    !foreignKeyExists(
      db,
      "session_tree_sessions",
      "session_tree_scopes",
      ["tenant_id", "root_session_id"],
      ["tenant_id", "root_session_id"],
    ) ||
    !foreignKeyExists(
      db,
      "session_tree_commands",
      "session_tree_scopes",
      ["tenant_id", "root_session_id"],
      ["tenant_id", "root_session_id"],
    )
  ) {
    throw new Error("session tree schema is malformed");
  }
  const canonical = new Database(":memory:");
  let expected: unknown;
  try {
    canonical.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY)");
    canonical.exec(sessionTreeSchema());
    expected = canonical
      .prepare(
        "SELECT type, name, tbl_name, replace(replace(replace(trim(sql), char(10), ' '), char(13), ' '), char(9), ' ') AS sql FROM sqlite_master WHERE sql IS NOT NULL AND (name LIKE 'session_tree_%' OR tbl_name LIKE 'session_tree_%') ORDER BY type, name",
      )
      .all();
  } finally {
    canonical.close();
  }
  const actual = db
    .prepare(
      "SELECT type, name, tbl_name, replace(replace(replace(trim(sql), char(10), ' '), char(13), ' '), char(9), ' ') AS sql FROM sqlite_master WHERE sql IS NOT NULL AND (name LIKE 'session_tree_%' OR tbl_name LIKE 'session_tree_%') ORDER BY type, name",
    )
    .all();
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/ +/gu, " "));
  if (stable(normalize(actual)) !== stable(normalize(expected))) {
    throw new Error("session tree schema is malformed");
  }
}

function validateScope(scope: SessionTreeScopeValue): void {
  if (!scope || typeof scope !== "object") {
    throw new Error("session tree scope is malformed");
  }
  validateDurableIdentifier("tenant_id", scope.tenant_id);
  validateDurableIdentifier("root_session_id", scope.root_session_id);
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

function stableHash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export class SqliteSessionTreeAuthority {
  readonly #db: Database.Database;
  readonly #recordKey: Buffer;
  readonly #resolver: SecurityStateResolver;
  readonly #checkpoint: SessionTreeCheckpointPort;
  readonly #ownsCheckpoint: boolean;
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
      max_snapshot_bytes: options.limits?.max_snapshot_bytes ?? 4 * 1024 * 1024,
      max_session_bytes: options.limits?.max_session_bytes ?? 256 * 1024 * 1024,
      max_tree_bytes: options.limits?.max_tree_bytes ?? 256 * 1024 * 1024,
      max_recovery_bytes: options.limits?.max_recovery_bytes ?? 512 * 1024 * 1024,
      max_recovery_rows: options.limits?.max_recovery_rows ?? 1_000_000,
      max_depth: options.limits?.max_depth ?? 1_024,
    };
    const hardLimits: Readonly<Record<string, number>> = {
      max_tree_events: 1_000_000,
      max_session_events: 1_000_000,
      max_event_bytes: 2 * 1024 * 1024 * 1024,
      max_snapshot_bytes: 2 * 1024 * 1024 * 1024,
      max_session_bytes: 2 * 1024 * 1024 * 1024,
      max_tree_bytes: 2 * 1024 * 1024 * 1024,
      max_recovery_bytes: 2 * 1024 * 1024 * 1024,
      max_recovery_rows: 1_000_000,
      max_depth: 4_096,
    };
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
      }
      if (value > hardLimits[name]! || value >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`${name} exceeds safe query headroom`);
      }
    }
    const expectedIdentity = preflightExistingSessionDatabase(
      dbPath,
      options.masterKey,
      options.state_root,
    );
    this.#db = new Database(dbPath);
    let derivedRecordKey: Buffer | undefined;
    try {
      assertSessionDatabaseIdentity(dbPath, options.state_root, expectedIdentity);
      this.#db.pragma("foreign_keys = ON");
      this.#db.pragma("busy_timeout = 5000");
      derivedRecordKey = deriveSessionRecordKey(this.#db, options.masterKey);
      this.#recordKey = derivedRecordKey;
      authenticateSessionRecordKey(this.#db, this.#recordKey);
      const existingTables = tableNames(this.#db);
      const schemaVersion = this.#db
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get("session_tree_schema_version") as { value: string } | undefined;
      if (schemaVersion?.value === "1") {
        throw new Error("legacy plaintext session tree security state rejected");
      }
      if (schemaVersion && schemaVersion.value !== "2") {
        throw new Error("unsupported session tree schema version");
      }
      if (!schemaVersion) {
        if (existingTables.size !== 0) {
          throw new Error("session tree schema version is missing");
        }
        runImmediateTransaction(this.#db, () => {
          this.#db.exec(sessionTreeSchema());
          this.#db
            .prepare("INSERT INTO metadata (key, value) VALUES (?, '2')")
            .run("session_tree_schema_version");
        });
      }
      validateSessionTreeSchema(this.#db);
      this.#checkpoint =
        options.checkpoint ??
        new FileSessionTreeCheckpoint(
          `${dbPath}.session-tree-checkpoints`,
          options.masterKey,
        );
      this.#ownsCheckpoint = options.checkpoint === undefined;
      const scopes = this.#db
        .prepare(
          "SELECT tenant_id, root_session_id FROM session_tree_scopes ORDER BY tenant_id, root_session_id",
        )
        .all() as SessionTreeScopeValue[];
      for (const scope of scopes) this.#assertCheckpoint(scope);
    } catch (error) {
      if (derivedRecordKey) {
        derivedRecordKey.fill(0);
        options._test_on_record_key_disposed?.(
          derivedRecordKey.every((value) => value === 0),
        );
      }
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
    validateScope(scope);
    validateDurableIdentifier("storage_run_id", storageRunId);
    const validatedSecurity = this.#validatedSecurity(security);
    const treeRunId = this.#physicalTreeRunId(scope);
    this.#mutateWithCheckpoint(
      scope,
      `bind:${scope.tenant_id}:${scope.root_session_id}`,
      () => {
      if (storageRunId !== scope.root_session_id) {
        fault("AUTHORITY_VIOLATION", "root durable identity does not match scope");
      }
      const owner = this.#db
        .prepare(
          "SELECT tenant_id, root_session_id, kind FROM run_scopes WHERE run_id = ?",
        )
        .get(storageRunId) as
        | { tenant_id: string; root_session_id: string; kind: string }
        | undefined;
      if (
        !owner ||
        owner.tenant_id !== scope.tenant_id ||
        owner.root_session_id !== scope.root_session_id ||
        owner.kind !== "root"
      ) {
        fault("AUTHORITY_VIOLATION", "root durable session is not owned by scope");
      }
      const existing = this.#db
        .prepare(
          "SELECT tree_run_id FROM session_tree_scopes WHERE tenant_id = ? AND root_session_id = ?",
        )
        .get(scope.tenant_id, scope.root_session_id) as
        | { tree_run_id: string }
        | undefined;
      if (existing && existing.tree_run_id !== treeRunId) {
        fault("SESSION_CONFLICT", "root scope is already bound");
      }
      if (!existing) {
        const timestamp = new Date().toISOString();
        insertCanonicalSessionRun(
          this.#db,
          this.#recordKey,
          treeRunId,
          "session tree lineage",
          "session_tree_lineage",
          timestamp,
        );
        this.#db
          .prepare("INSERT INTO session_tree_scopes VALUES (?, ?, ?, ?)")
          .run(scope.tenant_id, scope.root_session_id, treeRunId, timestamp);
      }
      const prior = this.#session(scope, scope.root_session_id);
      if (
        prior &&
        (prior.storage_run_id !== storageRunId ||
          stable(this.#persistedSecurity(scope, prior)) !== stable(validatedSecurity))
      ) {
        fault("SESSION_CONFLICT", "root session binding conflicts");
      }
      if (!prior) {
        this.#db
          .prepare(
            "INSERT INTO session_tree_sessions VALUES (?, ?, ?, ?, NULL, 0, ?, ?)",
          )
          .run(
            scope.tenant_id,
            scope.root_session_id,
            scope.root_session_id,
            storageRunId,
            this.#encryptedSecurity(scope, scope.root_session_id, validatedSecurity),
            new Date().toISOString(),
          );
      }
      },
    );
  }

  async loadTree(scope: SessionTreeScopeValue) {
    this.#assertOpen();
    validateScope(scope);
    this.#assertCheckpoint(scope);
    const treeRunId = this.#treeRunId(scope);
    const events = this.#verifiedEvents(
      treeRunId,
      this.#limits.max_tree_events,
      this.#limits.max_tree_bytes,
    );
    return { ...scope, events };
  }

  async readSessionHead(scope: SessionTreeScopeValue, sessionId: string) {
    this.#assertOpen();
    validateScope(scope);
    validateDurableIdentifier("session_id", sessionId);
    this.#assertCheckpoint(scope);
    const row = this.#session(scope, sessionId);
    if (!row) return null;
    const events = this.#logicalEvents(scope, row);
    return this.#point(scope, row, events.at(-1) ?? null);
  }

  async readSessionPoint(
    scope: SessionTreeScopeValue,
    sessionId: string,
    seq: number,
  ) {
    this.#assertOpen();
    validateScope(scope);
    validateDurableIdentifier("session_id", sessionId);
    this.#assertCheckpoint(scope);
    const row = this.#session(scope, sessionId);
    if (!row) return null;
    const events = this.#logicalEvents(scope, row);
    return this.#point(scope, row, events[seq - 1] ?? null);
  }

  openSession(
    scope: SessionTreeScopeValue,
    sessionId: string,
  ): LogicalSessionHandle {
    this.#assertOpen();
    validateScope(scope);
    validateDurableIdentifier("session_id", sessionId);
    this.#assertCheckpoint(scope);
    const row = this.#session(scope, sessionId);
    if (!row) fault("SOURCE_NOT_FOUND", "logical session does not exist");
    this.#effectiveSecurity(scope, row);
    const events = this.#logicalEvents(scope, row);
    const snapshot = this.#loadSnapshot(row, sessionId);
    const persistence: SessionPersistencePort = {
      appendEvent: (_logicalSessionId, event) => {
        this.#appendLogicalEvent(scope, row, sessionId, event);
      },
      saveSnapshot: (_logicalSessionId, value) => {
        this.#saveLogicalSnapshot(scope, row, sessionId, value);
      },
    };
    return Object.freeze({
      logical_session_id: sessionId,
      session: DurableSession.restore(
        { session_id: sessionId, events, snapshot },
        { persistence },
      ),
    });
  }

  async appendLineageEvent(request: CommitRequest) {
    this.#assertOpen();
    validateScope(request.scope);
    validateDurableIdentifier("command_id", request.command_id);
    validateDurableIdentifier("child_session_id", request.child_session_id);
    validateDurableIdentifier("session_id", request.source.session_id);
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
    const fingerprint = stableHash({
      operation: request.operation,
      child: request.child_session_id,
      source: request.source,
      source_head: request.source_head,
      event_type: request.event_type,
      data: request.data,
    });
    return this.#mutateWithCheckpoint(
      request.scope,
      `lineage:${request.command_id}`,
      () => {
      const treeRunId = this.#treeRunId(request.scope);
      const existing = this.#db
        .prepare(
          "SELECT child_session_id, fingerprint, event_seq FROM session_tree_commands WHERE tenant_id = ? AND root_session_id = ? AND command_id = ?",
        )
        .get(
          request.scope.tenant_id,
          request.scope.root_session_id,
          request.command_id,
        ) as CommandRow | undefined;
      if (existing) {
        const event = this.#verifiedEvents(
          treeRunId,
          this.#limits.max_tree_events,
          this.#limits.max_tree_bytes,
        )[
          existing.event_seq - 1
        ];
        if (!event) fault("CORRUPT_LOG", "idempotency index points to a missing event");
        const data = event.data as Partial<{
          command_id: string;
          operation: "branch" | "fork" | "rewind";
          child_session_id: string;
          source: SessionPoint;
          source_head: SessionPoint;
        }>;
        const indexedFingerprint = stableHash({
          operation: data.operation,
          child: data.child_session_id,
          source: data.source,
          source_head: data.source_head,
          event_type: event.type,
          data: event.data,
        });
        if (
          data.command_id !== request.command_id ||
          data.child_session_id !== existing.child_session_id ||
          (data.operation === "fork" ? "fork" : "branch") !== event.type ||
          existing.fingerprint !== indexedFingerprint ||
          event.seq !== existing.event_seq
        ) {
          fault("CORRUPT_LOG", "idempotency index disagrees with its lineage event");
        }
        if (existing.fingerprint !== fingerprint) {
          fault("COMMAND_CONFLICT", "command_id has a conflicting durable meaning");
        }
        return { event, duplicate: true };
      }

      const treeEvents = this.#verifiedEvents(
        treeRunId,
        this.#limits.max_tree_events,
        this.#limits.max_tree_bytes,
      );
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
      const sourceEvents = this.#logicalEvents(request.scope, sourceRow);
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
      if (request.source.seq + 1 > this.#limits.max_session_events) {
        fault("RESOURCE_LIMIT", "session event limit reached");
      }
      const inheritedBytes = sourceEvents
        .slice(0, request.source.seq)
        .reduce(
          (sum, sourceEventValue) =>
            sum + Buffer.byteLength(stable(sourceEventValue.data)),
          0,
        );
      if (
        inheritedBytes + Buffer.byteLength(stable(request.data)) >
        this.#limits.max_session_bytes
      ) {
        fault("RESOURCE_LIMIT", "session byte limit reached");
      }

      const event = this.#newEvent(
        treeEvents.length + 1,
        request.event_type,
        request.data,
        actualHead?.hash ?? "",
      );
      const physicalChildId = `__session_tree__${createHmac("sha256", this.#recordKey)
        .update(
          encodeLengthPrefixedIdentifiers([
            request.scope.tenant_id,
            request.scope.root_session_id,
            request.child_session_id,
          ]),
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
          this.#encryptedSecurity(
            request.scope,
            request.child_session_id,
            effective,
          ),
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
      },
    );
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#db.close();
    } finally {
      if (this.#ownsCheckpoint) this.#checkpoint.close?.();
      this.#recordKey.fill(0);
      this.#closed = true;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("session tree authority is closed");
  }

  #assertCheckpoint(scope: SessionTreeScopeValue): number {
    const heads = this.#checkpointHeads(scope);
    try {
      return this.#checkpoint.reconcile(scope, heads).revision;
    } catch (error) {
      fault(
        "CORRUPT_LOG",
        `session tree checkpoint mismatch: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  #mutateWithCheckpoint<T>(
    scope: SessionTreeScopeValue,
    operationId: string,
    operation: () => T,
  ): T {
    const oldHeads = this.#checkpointHeads(scope);
    if (this.#checkpoint.transition) {
      let operationFailure: unknown;
      try {
        return this.#checkpoint.transition(
          scope,
          oldHeads,
          operationId,
          (_revision, stage) =>
            runImmediateTransaction(this.#db, () => {
              try {
                const value = operation();
                stage(this.#checkpointHeads(scope));
                return value;
              } catch (error) {
                operationFailure = error;
                throw error;
              }
            }),
        );
      } catch (error) {
        if (operationFailure === error) throw error;
        fault(
          "CORRUPT_LOG",
          `session tree checkpoint mismatch: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }
    const oldRevision = this.#assertCheckpoint(scope);
    let prepared = false;
    let result: T;
    try {
      result = runImmediateTransaction(this.#db, () => {
        const value = operation();
        const newHeads = this.#checkpointHeads(scope);
        this.#checkpoint.prepare(scope, {
          operation_id: operationId,
          old_revision: oldRevision,
          new_revision: oldRevision + 1,
          old_heads: oldHeads,
          new_heads: newHeads,
        });
        prepared = true;
        return value;
      });
    } catch (error) {
      if (prepared) this.#assertCheckpoint(scope);
      throw error;
    }
    try {
      this.#checkpoint.commit(scope, operationId);
    } catch {
      this.#assertCheckpoint(scope);
    }
    return result;
  }

  #checkpointHeads(scope: SessionTreeScopeValue): SessionTreeCheckpointHeads {
    const scopeRow = this.#db
      .prepare(
        "SELECT tree_run_id FROM session_tree_scopes WHERE tenant_id = ? AND root_session_id = ?",
      )
      .get(scope.tenant_id, scope.root_session_id) as
      | { tree_run_id: string }
      | undefined;
    if (!scopeRow) {
      const empty = createHash("sha256")
        .update(stable([scope.tenant_id, scope.root_session_id, "unbound"]))
        .digest("hex");
      return {
        version: 1,
        bound: false,
        tree: { seq: 0, hash: "" },
        session_count: 0,
        command_count: 0,
        sessions_hash: empty,
        security_hash: empty,
        snapshot_hash: empty,
        ownership_hash: empty,
        state_hash: empty,
      };
    }
    this.#assertRecoveryLedger(scope, scopeRow.tree_run_id);
    const rows = this.#db
      .prepare(
        "SELECT * FROM session_tree_sessions WHERE tenant_id = ? AND root_session_id = ? ORDER BY session_id LIMIT ?",
      )
      .all(
        scope.tenant_id,
        scope.root_session_id,
        this.#limits.max_recovery_rows + 1,
      ) as SessionRow[];
    if (rows.length > this.#limits.max_recovery_rows) {
      fault("RESOURCE_LIMIT", "session recovery row limit exceeded");
    }
    const eventRows = this.#db.prepare(`
      WITH scoped_runs(run_id) AS (
        SELECT storage_run_id FROM session_tree_sessions
          WHERE tenant_id = ? AND root_session_id = ?
        UNION SELECT ?
      )
      SELECT e.run_id, e.seq, e.type, e.timestamp, e.data_json, e.hash, e.prev_hash
      FROM events e JOIN scoped_runs s ON s.run_id = e.run_id
      ORDER BY e.run_id, e.seq LIMIT ?
    `).all(
      scope.tenant_id,
      scope.root_session_id,
      scopeRow.tree_run_id,
      this.#limits.max_recovery_rows + 1,
    ) as PersistedEventRow[];
    if (eventRows.length > this.#limits.max_recovery_rows) {
      fault("RESOURCE_LIMIT", "session recovery row limit exceeded");
    }
    const eventsByRun = new Map<string, PersistedEventRow[]>();
    eventRows.forEach((event) => {
      const bucket = eventsByRun.get(event.run_id);
      if (bucket) bucket.push(event);
      else eventsByRun.set(event.run_id, [event]);
    });
    const snapshotRows = this.#db.prepare(`
      SELECT s.run_id, s.version, s.last_seq, s.last_hash, s.created_at, s.summary_json
      FROM snapshots s
      JOIN session_tree_sessions t ON t.storage_run_id = s.run_id
      WHERE t.tenant_id = ? AND t.root_session_id = ?
      ORDER BY s.run_id, s.version LIMIT ?
    `).all(
      scope.tenant_id,
      scope.root_session_id,
      this.#limits.max_recovery_rows + 1,
    ) as Array<Record<string, unknown> & { run_id: string }>;
    if (snapshotRows.length > this.#limits.max_recovery_rows) {
      fault("RESOURCE_LIMIT", "session recovery row limit exceeded");
    }
    const snapshotsByRun = new Map<string, unknown[]>();
    snapshotRows.forEach(({ run_id, ...snapshot }) => {
      const bucket = snapshotsByRun.get(run_id);
      if (bucket) bucket.push(snapshot);
      else snapshotsByRun.set(run_id, [snapshot]);
    });
    const treeEvents = this.#decodeVerifiedEventRows(
      scopeRow.tree_run_id,
      eventsByRun.get(scopeRow.tree_run_id) ?? [],
      this.#limits.max_tree_events,
      this.#limits.max_tree_bytes,
    );
    const sessions = rows.map((row) => {
      const events = this.#decodeVerifiedEventRows(
        row.storage_run_id,
        eventsByRun.get(row.storage_run_id) ?? [],
        this.#limits.max_session_events,
        this.#limits.max_session_bytes,
      );
      return {
        session_id: row.session_id,
        storage_run_id: row.storage_run_id,
        parent_session_id: row.parent_session_id,
        depth: row.depth,
        head: {
          seq: events.length,
          hash: events.at(-1)?.hash ?? "",
        },
      };
    });
    const securities = rows.map((row) => ({
        session_id: row.session_id,
        security: this.#persistedSecurity(scope, row),
      }));
    const snapshots = rows.map((row) => ({
        session_id: row.session_id,
        rows: snapshotsByRun.get(row.storage_run_id) ?? [],
      }));
    const commands = this.#db
      .prepare(
        "SELECT command_id, child_session_id, fingerprint, event_seq FROM session_tree_commands WHERE tenant_id = ? AND root_session_id = ? ORDER BY command_id LIMIT ?",
      )
      .all(
        scope.tenant_id,
        scope.root_session_id,
        this.#limits.max_recovery_rows + 1,
      );
    const sessionsHash = stableHash(sessions);
    const securityHash = stableHash(securities);
    const snapshotHash = stableHash(snapshots);
    const ownership = {
      scope: this.#db
        .prepare(
          "SELECT tenant_id, root_session_id, run_id, kind FROM run_scopes WHERE run_id = ?",
        )
        .get(scope.root_session_id) ?? null,
      runs: this.#db
        .prepare(
          "SELECT r.run_id, r.strategy, r.status FROM runs r WHERE r.run_id = ? OR r.run_id IN (SELECT storage_run_id FROM session_tree_sessions WHERE tenant_id = ? AND root_session_id = ?) ORDER BY r.run_id LIMIT ?",
        )
        .all(
          scopeRow.tree_run_id,
          scope.tenant_id,
          scope.root_session_id,
          this.#limits.max_recovery_rows + 1,
        ),
    };
    const ownershipHash = stableHash(ownership);
    const tree = {
      seq: treeEvents.length,
      hash: treeEvents.at(-1)?.hash ?? "",
    };
    return {
      version: 1,
      bound: true,
      tree,
      session_count: rows.length,
      command_count: commands.length,
      sessions_hash: sessionsHash,
      security_hash: securityHash,
      snapshot_hash: snapshotHash,
      ownership_hash: ownershipHash,
      state_hash: stableHash({
        scope,
        tree_run_id: scopeRow.tree_run_id,
        tree,
        sessionsHash,
        securityHash,
        snapshotHash,
        ownershipHash,
        commands,
      }),
    };
  }

  #assertRecoveryLedger(scope: SessionTreeScopeValue, treeRunId: string): void {
    let rows = 0;
    let bytes = 0;
    const add = (value: { count: number; bytes: number }) => {
      rows += value.count;
      bytes += value.bytes;
      if (!Number.isSafeInteger(rows) || rows > this.#limits.max_recovery_rows) {
        fault("RESOURCE_LIMIT", "session recovery row limit exceeded");
      }
      if (!Number.isSafeInteger(bytes) || bytes > this.#limits.max_recovery_bytes) {
        fault("RESOURCE_LIMIT", "session recovery byte limit exceeded");
      }
    };
    const ledger = this.#db.prepare(`
      WITH scoped_runs(run_id) AS (
        SELECT storage_run_id FROM session_tree_sessions
          WHERE tenant_id = ? AND root_session_id = ?
        UNION SELECT ?
      ), ledger(category, count, bytes) AS (
        SELECT 'sessions', COUNT(*), COALESCE(SUM(
          length(CAST(session_id AS BLOB)) + length(CAST(storage_run_id AS BLOB)) +
          length(CAST(COALESCE(parent_session_id, '') AS BLOB)) +
          length(CAST(security_json AS BLOB)) + length(CAST(created_at AS BLOB))
        ), 0) FROM session_tree_sessions WHERE tenant_id = ? AND root_session_id = ?
        UNION ALL
        SELECT 'scopes', COUNT(*), COALESCE(SUM(
          length(CAST(tenant_id AS BLOB)) + length(CAST(root_session_id AS BLOB)) +
          length(CAST(run_id AS BLOB)) + length(CAST(kind AS BLOB))
        ), 0) FROM run_scopes WHERE run_id IN (SELECT run_id FROM scoped_runs)
        UNION ALL
        SELECT 'runs', COUNT(*), COALESCE(SUM(
          length(CAST(r.run_id AS BLOB)) + length(CAST(r.goal AS BLOB)) +
          length(CAST(r.strategy AS BLOB)) + length(CAST(r.status AS BLOB)) +
          length(CAST(r.created_at AS BLOB))
        ), 0) FROM runs r JOIN scoped_runs s ON s.run_id = r.run_id
        UNION ALL
        SELECT 'events', COUNT(*), COALESCE(SUM(
          length(CAST(e.type AS BLOB)) + length(CAST(e.timestamp AS BLOB)) +
          length(CAST(e.data_json AS BLOB)) + length(CAST(e.hash AS BLOB)) +
          length(CAST(e.prev_hash AS BLOB))
        ), 0) FROM events e JOIN scoped_runs s ON s.run_id = e.run_id
        UNION ALL
        SELECT 'snapshots', COUNT(*), COALESCE(SUM(
          length(CAST(s.last_hash AS BLOB)) + length(CAST(s.created_at AS BLOB)) +
          length(CAST(COALESCE(s.summary_json, '') AS BLOB))
        ), 0) FROM snapshots s JOIN scoped_runs r ON r.run_id = s.run_id
        UNION ALL
        SELECT 'commands', COUNT(*), COALESCE(SUM(
          length(CAST(command_id AS BLOB)) + length(CAST(child_session_id AS BLOB)) +
          length(CAST(fingerprint AS BLOB))
        ), 0) FROM session_tree_commands WHERE tenant_id = ? AND root_session_id = ?
      )
      SELECT category, SUM(count) AS count, SUM(bytes) AS bytes
      FROM ledger GROUP BY category ORDER BY category
    `).all(
      scope.tenant_id,
      scope.root_session_id,
      treeRunId,
      scope.tenant_id,
      scope.root_session_id,
      scope.tenant_id,
      scope.root_session_id,
    ) as Array<{ category: string; count: number; bytes: number }>;
    ledger.forEach(add);
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

  #physicalTreeRunId(scope: SessionTreeScopeValue): string {
    return `__session_tree_lineage__${createHmac("sha256", this.#recordKey)
      .update(
        encodeLengthPrefixedIdentifiers([
          scope.tenant_id,
          scope.root_session_id,
        ]),
      )
      .digest("hex")}`;
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
    const persisted = this.#persistedSecurity(scope, row);
    let candidate: SessionTreeSecurityValue;
    let noBroader: boolean;
    try {
      candidate = this.#validatedSecurity(
        this.#resolver.resolve(scope, row.session_id, persisted),
      );
      noBroader = this.#resolver.isNoBroaderThan(candidate, persisted);
    } catch {
      fault("AUTHORITY_VIOLATION", "security resolver violated its authority");
    }
    if (
      candidate.authorization_epoch < persisted.authorization_epoch ||
      !noBroader
    ) {
      fault("AUTHORITY_VIOLATION", "security resolver attempted privilege expansion");
    }
    return candidate;
  }

  #securityAssociatedData(
    scope: SessionTreeScopeValue,
    sessionId: string,
  ): string {
    return stable([
      "session_tree_security",
      scope.tenant_id,
      scope.root_session_id,
      sessionId,
    ]);
  }

  #encryptedSecurity(
    scope: SessionTreeScopeValue,
    sessionId: string,
    security: SessionTreeSecurityValue,
  ): string {
    return encryptSessionString(
      this.#recordKey,
      stable(security),
      this.#securityAssociatedData(scope, sessionId),
    );
  }

  #persistedSecurity(
    scope: SessionTreeScopeValue,
    row: SessionRow,
  ): SessionTreeSecurityValue {
    try {
      return this.#validatedSecurity(
        JSON.parse(
          decryptSessionString(
            this.#recordKey,
            row.security_json,
            this.#securityAssociatedData(scope, row.session_id),
          ),
        ) as SessionTreeSecurityValue,
      );
    } catch {
      fault("CORRUPT_LOG", "persisted security state is malformed");
    }
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
    return Object.freeze({
      state_hash: value.state_hash,
      capability_ceiling_hash: value.capability_ceiling_hash,
      authorization_epoch: value.authorization_epoch,
    });
  }

  #verifiedEvents(runId: string, limit: number, byteLimit: number): SessionEvent[] {
    const aggregate = this.#db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(length(data_json)), 0) AS bytes FROM events WHERE run_id = ?",
      )
      .get(runId) as { count: number; bytes: number };
    if (aggregate.count > limit) {
      fault("RESOURCE_LIMIT", "session event limit exceeded");
    }
    if (aggregate.bytes > this.#limits.max_recovery_bytes) {
      fault("RESOURCE_LIMIT", "session recovery byte limit exceeded");
    }
    const rows = this.#db
      .prepare(
        "SELECT seq, type, timestamp, data_json, hash, prev_hash FROM events WHERE run_id = ? ORDER BY seq LIMIT ?",
      )
      .all(runId, limit + 1) as PersistedEventRow[];
    return this.#decodeVerifiedEventRows(runId, rows, limit, byteLimit);
  }

  #decodeVerifiedEventRows(
    runId: string,
    rows: readonly PersistedEventRow[],
    limit: number,
    byteLimit: number,
  ): SessionEvent[] {
    if (rows.length > limit) fault("RESOURCE_LIMIT", "session event limit exceeded");
    let previousHash = "";
    let decodedBytes = 0;
    return rows.map((row, index) => {
      if (
        row.seq !== index + 1 ||
        !isSessionEventType(row.type) ||
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
      decodedBytes += Buffer.byteLength(stable(data));
      if (decodedBytes > byteLimit) {
        fault("RESOURCE_LIMIT", "session byte limit reached");
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

  #logicalEvents(
    scope: SessionTreeScopeValue,
    row: SessionRow,
    ancestors = new Set<string>(),
    projection = this.#sessionRecoveryProjection(scope),
  ): SessionEvent[] {
    if (ancestors.has(row.session_id)) {
      fault("CORRUPT_LOG", "logical session parent cycle detected");
    }
    const nextAncestors = new Set(ancestors).add(row.session_id);
    const local = this.#decodeVerifiedEventRows(
      row.storage_run_id,
      projection.events.get(row.storage_run_id) ?? [],
      this.#limits.max_session_events,
      this.#limits.max_session_bytes,
    );
    let inherited: SessionEvent[] = [];
    if (row.parent_session_id !== null) {
      const lineage = local[0]?.data as Partial<{
        source: { session_id: string; seq: number };
      }> | undefined;
      if (
        !lineage?.source ||
        lineage.source.session_id !== row.parent_session_id ||
        !Number.isSafeInteger(lineage.source.seq) ||
        lineage.source.seq < 0
      ) {
        fault("CORRUPT_LOG", "logical session lineage source is malformed");
      }
      const parent = projection.sessions.get(row.parent_session_id);
      if (!parent) fault("CORRUPT_LOG", "logical session parent is missing");
      const parentEvents = this.#logicalEvents(scope, parent, nextAncestors, projection);
      if (lineage.source.seq > parentEvents.length) {
        fault("CORRUPT_LOG", "logical session source exceeds parent history");
      }
      inherited = parentEvents.slice(0, lineage.source.seq);
    }
    const logicalSource = [...inherited, ...local];
    if (logicalSource.length > this.#limits.max_session_events) {
      fault("RESOURCE_LIMIT", "session event limit exceeded");
    }
    let previousHash = "";
    let decodedBytes = 0;
    return logicalSource.map((event, index) => {
      decodedBytes += Buffer.byteLength(stable(event.data));
      if (decodedBytes > this.#limits.max_session_bytes) {
        fault("RESOURCE_LIMIT", "session byte limit reached");
      }
      const logical: SessionEvent = {
        seq: index + 1,
        type: event.type,
        timestamp: event.timestamp,
        data: event.data,
        prev_hash: previousHash,
        hash: hashSessionEvent(
          index + 1,
          event.type,
          event.timestamp,
          event.data,
          previousHash,
        ),
      };
      previousHash = logical.hash;
      return logical;
    });
  }

  #sessionRecoveryProjection(
    scope: SessionTreeScopeValue,
  ): SessionRecoveryProjection {
    const rows = this.#db
      .prepare(
        "SELECT * FROM session_tree_sessions WHERE tenant_id = ? AND root_session_id = ? ORDER BY session_id LIMIT ?",
      )
      .all(
        scope.tenant_id,
        scope.root_session_id,
        this.#limits.max_recovery_rows + 1,
      ) as SessionRow[];
    if (rows.length > this.#limits.max_recovery_rows) {
      fault("RESOURCE_LIMIT", "session recovery row limit exceeded");
    }
    const eventRows = this.#db.prepare(`
      SELECT e.run_id, e.seq, e.type, e.timestamp, e.data_json, e.hash, e.prev_hash
      FROM events e
      JOIN session_tree_sessions s ON s.storage_run_id = e.run_id
      WHERE s.tenant_id = ? AND s.root_session_id = ?
      ORDER BY e.run_id, e.seq LIMIT ?
    `).all(
      scope.tenant_id,
      scope.root_session_id,
      this.#limits.max_recovery_rows + 1,
    ) as PersistedEventRow[];
    if (eventRows.length > this.#limits.max_recovery_rows) {
      fault("RESOURCE_LIMIT", "session recovery row limit exceeded");
    }
    const sessions = new Map(rows.map((value) => [value.session_id, value]));
    const events = new Map<string, PersistedEventRow[]>();
    eventRows.forEach((event) => {
      const bucket = events.get(event.run_id);
      if (bucket) bucket.push(event);
      else events.set(event.run_id, [event]);
    });
    return { sessions, events };
  }

  #loadSnapshot(row: SessionRow, logicalSessionId: string): SessionSnapshot | null {
    const value = this.#db
      .prepare(
        "SELECT version, last_seq, last_hash, created_at, summary_json FROM snapshots WHERE run_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(row.storage_run_id) as
      | {
          version: number;
          last_seq: number;
          last_hash: string;
          created_at: string;
          summary_json: string | null;
        }
      | undefined;
    if (!value) return null;
    try {
      if (value.summary_json === null) {
        fault("CORRUPT_LOG", "logical session snapshot is malformed");
      }
      return {
        session_id: logicalSessionId,
        version: value.version,
        last_seq: value.last_seq,
        last_hash: value.last_hash,
        created_at: value.created_at,
        summary: (() => {
          const plaintext = decryptSessionString(
            this.#recordKey,
            value.summary_json,
            `snapshots:${row.storage_run_id}:${value.version}:summary_json`,
          );
          if (Buffer.byteLength(plaintext) > this.#limits.max_snapshot_bytes) {
            fault("RESOURCE_LIMIT", "snapshot byte limit exceeded");
          }
          return JSON.parse(plaintext);
        })(),
      };
    } catch (error) {
      if (error instanceof SessionTreeAuthorityFault) throw error;
      fault("CORRUPT_LOG", "logical session snapshot is malformed");
    }
  }

  #appendLogicalEvent(
    scope: SessionTreeScopeValue,
    row: SessionRow,
    expectedLogicalId: string,
    event: SessionEvent,
  ): void {
    this.#assertOpen();
    this.#mutateWithCheckpoint(
      scope,
      `append:${expectedLogicalId}:${event.seq}:${event.hash}`,
      () => {
      const current = this.#session(scope, expectedLogicalId);
      if (!current || current.storage_run_id !== row.storage_run_id) {
        fault("AUTHORITY_VIOLATION", "logical session mapping changed");
      }
      this.#effectiveSecurity(scope, current);
      const events = this.#logicalEvents(scope, current);
      const head = events.at(-1);
      if (
        event.seq !== events.length + 1 ||
        event.prev_hash !== (head?.hash ?? "") ||
        hashSessionEvent(
          event.seq,
          event.type,
          event.timestamp,
          event.data,
          event.prev_hash,
        ) !== event.hash
      ) {
        fault("STALE_SOURCE", "logical session head advanced concurrently");
      }
      if (events.length >= this.#limits.max_session_events) {
        fault("RESOURCE_LIMIT", "session event limit reached");
      }
      if (Buffer.byteLength(stable(event.data)) > this.#limits.max_event_bytes) {
        fault("RESOURCE_LIMIT", "session event payload limit exceeded");
      }
      const totalBytes =
        events.reduce((sum, value) => sum + Buffer.byteLength(stable(value.data)), 0) +
        Buffer.byteLength(stable(event.data));
      if (totalBytes > this.#limits.max_session_bytes) {
        fault("RESOURCE_LIMIT", "session byte limit reached");
      }
      const localEvents = this.#verifiedEvents(
        current.storage_run_id,
        this.#limits.max_session_events,
        this.#limits.max_session_bytes,
      );
      const localHead = localEvents.at(-1);
      const physicalEvent: SessionEvent = {
        seq: localEvents.length + 1,
        type: event.type,
        timestamp: event.timestamp,
        data: event.data,
        prev_hash: localHead?.hash ?? "",
        hash: hashSessionEvent(
          localEvents.length + 1,
          event.type,
          event.timestamp,
          event.data,
          localHead?.hash ?? "",
        ),
      };
      insertCanonicalSessionEvent(
        this.#db,
        this.#recordKey,
        current.storage_run_id,
        physicalEvent,
      );
      },
    );
  }

  #saveLogicalSnapshot(
    scope: SessionTreeScopeValue,
    row: SessionRow,
    expectedLogicalId: string,
    snapshot: SessionSnapshot,
  ): void {
    this.#assertOpen();
    this.#mutateWithCheckpoint(
      scope,
      `snapshot:${expectedLogicalId}:${snapshot.version}:${snapshot.last_hash}`,
      () => {
      const current = this.#session(scope, expectedLogicalId);
      if (!current || current.storage_run_id !== row.storage_run_id) {
        fault("AUTHORITY_VIOLATION", "logical session mapping changed");
      }
      this.#effectiveSecurity(scope, current);
      const events = this.#logicalEvents(scope, current);
      const head = events.at(-1);
      if (
        snapshot.last_seq !== events.length ||
        snapshot.last_hash !== (head?.hash ?? "")
      ) {
        fault("STALE_SOURCE", "logical snapshot does not match the durable head");
      }
      const summary = stable(snapshot.summary);
      if (Buffer.byteLength(summary) > this.#limits.max_snapshot_bytes) {
        fault("RESOURCE_LIMIT", "snapshot byte limit exceeded");
      }
      this.#db
        .prepare(
          "INSERT INTO snapshots (run_id, version, last_seq, last_hash, created_at, summary_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          current.storage_run_id,
          snapshot.version,
          snapshot.last_seq,
          snapshot.last_hash,
          snapshot.created_at,
          encryptSessionString(
            this.#recordKey,
            summary,
            `snapshots:${current.storage_run_id}:${snapshot.version}:summary_json`,
          ),
        );
      },
    );
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
