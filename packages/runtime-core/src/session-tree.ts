/**
 * AH-RUNTIME-SESSIONTREE-001
 *
 * SessionTree is a command validator and a projection over an existing
 * append-only session event authority. It intentionally does not hash,
 * persist, replay, or execute session events. An adapter backed by the
 * existing DurableSession/receipt authority must implement the port below.
 */

export type SessionTreeOperation = "branch" | "fork" | "rewind";

export type SessionTreeAuthorityEventType =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "compaction"
  | "branch"
  | "fork"
  | "steer"
  | "system"
  | "error"
  | "summary";

export interface SessionTreeScope {
  readonly tenant_id: string;
  readonly root_session_id: string;
}

export interface SessionTreeSecurityAnchor {
  readonly state_hash: string;
  readonly capability_ceiling_hash: string;
  readonly authorization_epoch: number;
}

export interface SessionTreeSessionPoint extends SessionTreeScope {
  readonly session_id: string;
  readonly seq: number;
  readonly hash: string;
  /**
   * Effective security state supplied by the authorization/session authority.
   * For a historical point this must already reflect current revocations and
   * be equal to or more restrictive than the parent ceiling.
   */
  readonly security: SessionTreeSecurityAnchor;
}

export interface SessionTreeAuthorityEvent {
  readonly seq: number;
  readonly type: SessionTreeAuthorityEventType;
  readonly timestamp: string;
  readonly data: unknown;
  readonly hash: string;
  readonly prev_hash: string;
}

export interface SessionTreeAuthorityLog extends SessionTreeScope {
  /** The complete, authority-verified event chain, not a filtered copy. */
  readonly events: readonly SessionTreeAuthorityEvent[];
}

export interface SessionTreeLineageData {
  readonly version: 1;
  readonly command_id: string;
  readonly operation: SessionTreeOperation;
  readonly child_session_id: string;
  readonly source: SessionTreeSessionPoint;
  readonly source_head: SessionTreeSessionPoint;
  readonly replay_policy: "lineage_only_no_effect_replay";
}

export interface SessionTreeCommitRequest {
  readonly scope: SessionTreeScope;
  readonly command_id: string;
  readonly operation: SessionTreeOperation;
  readonly child_session_id: string;
  readonly source: SessionTreeSessionPoint;
  readonly source_head: SessionTreeSessionPoint;
  readonly expected_tree_head: Readonly<{ seq: number; hash: string }>;
  readonly event_type: "branch" | "fork";
  readonly data: SessionTreeLineageData;
}

export interface SessionTreeCommitResult {
  readonly event: SessionTreeAuthorityEvent;
  readonly duplicate: boolean;
}

/**
 * Port into the existing durable session authority.
 *
 * Implementations MUST:
 * - scope every read/write by tenant and root session;
 * - verify the complete persisted hash chain before returning it;
 * - atomically compare `expected_tree_head`, validate the source point, create
 *   the child session, and append the lineage event through the existing
 *   session writer;
 * - make `command_id` idempotent and reject a conflicting payload;
 * - reject duplicate child IDs under the same scope;
 * - copy no tool results and execute no operation while forking/rewinding.
 *
 * SessionTree never substitutes for the session writer, effect journal, or
 * receipt authority.
 */
export interface SessionTreeAuthorityPort {
  loadTree(scope: SessionTreeScope): Promise<SessionTreeAuthorityLog>;
  readSessionHead(
    scope: SessionTreeScope,
    sessionId: string,
  ): Promise<SessionTreeSessionPoint | null>;
  readSessionPoint(
    scope: SessionTreeScope,
    sessionId: string,
    seq: number,
  ): Promise<SessionTreeSessionPoint | null>;
  appendLineageEvent(
    request: SessionTreeCommitRequest,
  ): Promise<SessionTreeCommitResult>;
}

export interface SessionTreeSourceRef {
  readonly session_id: string;
  readonly seq: number;
  readonly hash: string;
}

export interface SessionTreeNode {
  readonly session_id: string;
  readonly parent_session_id: string | null;
  readonly ancestor_session_ids: readonly string[];
  readonly operation: "root" | SessionTreeOperation;
  readonly command_id: string | null;
  readonly source: SessionTreeSourceRef | null;
  readonly inherited_security: SessionTreeSecurityAnchor | null;
  readonly replay_policy: "lineage_only_no_effect_replay" | null;
  readonly created_at: string | null;
  readonly tree_event: Readonly<{ seq: number; hash: string }> | null;
}

export interface SessionTreeSnapshot extends SessionTreeScope {
  readonly version: 1;
  readonly authority_head: Readonly<{ seq: number; hash: string }>;
  readonly nodes: readonly SessionTreeNode[];
}

export interface SessionTreeCommandResult {
  readonly node: SessionTreeNode;
  readonly snapshot: SessionTreeSnapshot;
  readonly replayed: boolean;
}

export interface SessionTreeBranchCommand {
  readonly command_id: string;
  readonly source_session_id: string;
  readonly child_session_id: string;
}

export interface SessionTreeForkCommand extends SessionTreeBranchCommand {
  readonly at: Readonly<{ seq: number; hash: string }>;
}

export interface SessionTreeRewindCommand extends SessionTreeBranchCommand {
  readonly to: Readonly<{ seq: number; hash: string }>;
}

export type SessionTreeErrorCode =
  | "INVALID_INPUT"
  | "SOURCE_NOT_FOUND"
  | "INVALID_TARGET"
  | "STALE_SOURCE"
  | "SESSION_CONFLICT"
  | "COMMAND_CONFLICT"
  | "CORRUPT_LOG"
  | "AUTHORITY_VIOLATION"
  | "AUTHORITY_FAILURE";

export class SessionTreeError extends Error {
  readonly code: SessionTreeErrorCode;

  constructor(code: SessionTreeErrorCode, message: string) {
    super(message);
    this.name = "SessionTreeError";
    this.code = code;
    Object.setPrototypeOf(this, SessionTreeError.prototype);
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EVENT_TYPES = new Set<SessionTreeAuthorityEventType>([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "compaction",
  "branch",
  "fork",
  "steer",
  "system",
  "error",
  "summary",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code: SessionTreeErrorCode, message: string): never {
  throw new SessionTreeError(code, message);
}

const identifier = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("INVALID_INPUT", `${name} is invalid`);
  }
  return value;
};

const sha256 = (value: unknown, name: string, allowGenesis = false): string => {
  if (
    typeof value !== "string" ||
    (!SHA256.test(value) && !(allowGenesis && value === ""))
  ) {
    fail("CORRUPT_LOG", `${name} must be a SHA-256 hash`);
  }
  return value;
};

const positiveSequence = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("INVALID_TARGET", `${name} must be a positive safe integer`);
  }
  return value as number;
};

const jsonClone = <T>(value: T, label: string): T => {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail("AUTHORITY_VIOLATION", `${label} is not JSON-serializable`);
  }
  if (encoded === undefined) {
    fail("AUTHORITY_VIOLATION", `${label} is not JSON-serializable`);
  }
  return JSON.parse(encoded) as T;
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const immutable = <T>(value: T, label: string): T =>
  deepFreeze(jsonClone(value, label));

const validateScope = (value: SessionTreeScope): SessionTreeScope =>
  immutable(
    {
      tenant_id: identifier(value?.tenant_id, "tenant_id"),
      root_session_id: identifier(value?.root_session_id, "root_session_id"),
    },
    "session tree scope",
  );

const validateSecurity = (
  value: unknown,
  label: string,
): SessionTreeSecurityAnchor => {
  if (!isRecord(value)) {
    fail("AUTHORITY_VIOLATION", `${label} security is missing`);
  }
  const authorizationEpoch = value.authorization_epoch;
  if (
    !Number.isSafeInteger(authorizationEpoch) ||
    (authorizationEpoch as number) < 0
  ) {
    fail("AUTHORITY_VIOLATION", `${label} authorization_epoch is invalid`);
  }
  return immutable(
    {
      state_hash: sha256(value.state_hash, `${label}.state_hash`),
      capability_ceiling_hash: sha256(
        value.capability_ceiling_hash,
        `${label}.capability_ceiling_hash`,
      ),
      authorization_epoch: authorizationEpoch as number,
    },
    `${label} security`,
  );
};

const validatePoint = (
  value: unknown,
  scope: SessionTreeScope,
  expectedSessionId: string,
  label: string,
  allowEmpty = false,
): SessionTreeSessionPoint => {
  if (!isRecord(value)) {
    fail("AUTHORITY_VIOLATION", `${label} is malformed`);
  }
  if (
    value.tenant_id !== scope.tenant_id ||
    value.root_session_id !== scope.root_session_id ||
    value.session_id !== expectedSessionId
  ) {
    fail("AUTHORITY_VIOLATION", `${label} escaped its tenant/session scope`);
  }
  const seq = value.seq;
  const eventHash = value.hash;
  const validEmpty = allowEmpty && seq === 0 && eventHash === "";
  if (!validEmpty) positiveSequence(seq, `${label}.seq`);
  return immutable(
    {
      tenant_id: scope.tenant_id,
      root_session_id: scope.root_session_id,
      session_id: expectedSessionId,
      seq: seq as number,
      hash: sha256(eventHash, `${label}.hash`, validEmpty),
      security: validateSecurity(value.security, label),
    },
    label,
  );
};

const samePoint = (
  left: Pick<SessionTreeSessionPoint, "session_id" | "seq" | "hash">,
  right: Pick<SessionTreeSessionPoint, "session_id" | "seq" | "hash">,
): boolean =>
  left.session_id === right.session_id &&
  left.seq === right.seq &&
  left.hash === right.hash;

const lineageData = (
  value: unknown,
  scope: SessionTreeScope,
  eventType: SessionTreeAuthorityEvent["type"],
): SessionTreeLineageData => {
  if (!isRecord(value) || value.version !== 1) {
    fail("CORRUPT_LOG", "lineage event has an unsupported payload");
  }
  const operation = value.operation;
  if (
    operation !== "branch" &&
    operation !== "fork" &&
    operation !== "rewind"
  ) {
    fail("CORRUPT_LOG", "lineage operation is invalid");
  }
  if (
    (operation === "fork" && eventType !== "fork") ||
    (operation !== "fork" && eventType !== "branch")
  ) {
    fail("CORRUPT_LOG", "lineage event type does not match its operation");
  }
  const childSessionId = identifier(
    value.child_session_id,
    "lineage child_session_id",
  );
  const sourceRecord = value.source;
  const sourceHeadRecord = value.source_head;
  if (!isRecord(sourceRecord) || !isRecord(sourceHeadRecord)) {
    fail("CORRUPT_LOG", "lineage source anchors are missing");
  }
  const sourceSessionId = identifier(
    sourceRecord.session_id,
    "lineage source_session_id",
  );
  if (sourceHeadRecord.session_id !== sourceSessionId) {
    fail("CORRUPT_LOG", "lineage source and source head disagree");
  }
  const source = validatePoint(
    sourceRecord,
    scope,
    sourceSessionId,
    "lineage source",
    operation === "branch",
  );
  const sourceHead = validatePoint(
    sourceHeadRecord,
    scope,
    sourceSessionId,
    "lineage source head",
    true,
  );
  if (source.seq > sourceHead.seq) {
    fail("CORRUPT_LOG", "lineage source is later than its recorded head");
  }
  if (operation === "branch" && !samePoint(source, sourceHead)) {
    fail("CORRUPT_LOG", "branch is not bound to the source head");
  }
  if (operation === "rewind" && source.seq >= sourceHead.seq) {
    fail("CORRUPT_LOG", "rewind does not target historical state");
  }
  if (value.replay_policy !== "lineage_only_no_effect_replay") {
    fail("CORRUPT_LOG", "lineage replay policy is unsafe");
  }
  return immutable(
    {
      version: 1,
      command_id: identifier(value.command_id, "lineage command_id"),
      operation,
      child_session_id: childSessionId,
      source,
      source_head: sourceHead,
      replay_policy: "lineage_only_no_effect_replay",
    },
    "lineage event",
  );
};

interface Projection {
  readonly snapshot: SessionTreeSnapshot;
  readonly bySession: ReadonlyMap<string, SessionTreeNode>;
  readonly byCommand: ReadonlyMap<string, SessionTreeNode>;
}

export class SessionTree {
  readonly #scope: SessionTreeScope;
  readonly #authority: SessionTreeAuthorityPort;

  constructor(scope: SessionTreeScope, authority: SessionTreeAuthorityPort) {
    this.#scope = validateScope(scope);
    if (!authority || typeof authority !== "object") {
      fail("INVALID_INPUT", "session tree authority is required");
    }
    for (const method of [
      "loadTree",
      "readSessionHead",
      "readSessionPoint",
      "appendLineageEvent",
    ] as const) {
      if (typeof authority[method] !== "function") {
        fail("INVALID_INPUT", `session tree authority.${method} is required`);
      }
    }
    this.#authority = authority;
  }

  async snapshot(): Promise<SessionTreeSnapshot> {
    return (await this.#project()).snapshot;
  }

  async branch(
    command: SessionTreeBranchCommand,
  ): Promise<SessionTreeCommandResult> {
    return this.#execute("branch", command, null);
  }

  async fork(
    command: SessionTreeForkCommand,
  ): Promise<SessionTreeCommandResult> {
    return this.#execute("fork", command, command?.at);
  }

  async rewind(
    command: SessionTreeRewindCommand,
  ): Promise<SessionTreeCommandResult> {
    return this.#execute("rewind", command, command?.to);
  }

  async #execute(
    operation: SessionTreeOperation,
    command: SessionTreeBranchCommand,
    requestedPoint: Readonly<{ seq: number; hash: string }> | null,
  ): Promise<SessionTreeCommandResult> {
    try {
      const commandId = identifier(command?.command_id, "command_id");
      const sourceSessionId = identifier(
        command?.source_session_id,
        "source_session_id",
      );
      const childSessionId = identifier(
        command?.child_session_id,
        "child_session_id",
      );
      if (childSessionId === this.#scope.root_session_id) {
        fail(
          "SESSION_CONFLICT",
          "the root session cannot become its own child",
        );
      }
      const target =
        requestedPoint === null
          ? null
          : {
              seq: positiveSequence(requestedPoint?.seq, "target.seq"),
              hash: sha256(requestedPoint?.hash, "target.hash"),
            };

      const projection = await this.#project();
      const priorCommand = projection.byCommand.get(commandId);
      if (priorCommand) {
        const sameIntent =
          priorCommand.operation === operation &&
          priorCommand.session_id === childSessionId &&
          priorCommand.parent_session_id === sourceSessionId &&
          (target === null ||
            (priorCommand.source?.seq === target.seq &&
              priorCommand.source.hash === target.hash));
        if (!sameIntent) {
          fail(
            "COMMAND_CONFLICT",
            "command_id already has a different durable meaning",
          );
        }
        return immutable(
          { node: priorCommand, snapshot: projection.snapshot, replayed: true },
          "session tree command result",
        );
      }
      if (projection.bySession.has(childSessionId)) {
        fail("SESSION_CONFLICT", "child session already exists");
      }
      if (!projection.bySession.has(sourceSessionId)) {
        fail("SOURCE_NOT_FOUND", "source session is outside this tree");
      }

      const rawHead = await this.#authority.readSessionHead(
        this.#scope,
        sourceSessionId,
      );
      if (rawHead === null) {
        fail("SOURCE_NOT_FOUND", "source session does not exist");
      }
      const sourceHead = validatePoint(
        rawHead,
        this.#scope,
        sourceSessionId,
        "source head",
        true,
      );
      let source = sourceHead;
      if (target !== null) {
        if (target.seq > sourceHead.seq) {
          fail("INVALID_TARGET", "target is later than the source head");
        }
        const rawPoint = await this.#authority.readSessionPoint(
          this.#scope,
          sourceSessionId,
          target.seq,
        );
        if (rawPoint === null) {
          fail("STALE_SOURCE", "target does not exist in the source session");
        }
        source = validatePoint(
          rawPoint,
          this.#scope,
          sourceSessionId,
          "source point",
        );
        if (source.hash !== target.hash) {
          fail("STALE_SOURCE", "target hash does not match the authority");
        }
      }
      if (operation === "rewind" && source.seq >= sourceHead.seq) {
        fail("INVALID_TARGET", "rewind must target an earlier source point");
      }

      const data: SessionTreeLineageData = immutable(
        {
          version: 1,
          command_id: commandId,
          operation,
          child_session_id: childSessionId,
          source,
          source_head: sourceHead,
          replay_policy: "lineage_only_no_effect_replay",
        },
        "lineage command",
      );
      const expectedEventType = operation === "fork" ? "fork" : "branch";
      const commit = await this.#authority.appendLineageEvent({
        scope: this.#scope,
        command_id: commandId,
        operation,
        child_session_id: childSessionId,
        source,
        source_head: sourceHead,
        expected_tree_head: projection.snapshot.authority_head,
        event_type: expectedEventType,
        data,
      });
      if (!isRecord(commit) || typeof commit.duplicate !== "boolean") {
        fail("AUTHORITY_VIOLATION", "authority returned an invalid commit");
      }

      const updated = await this.#project();
      const node = updated.byCommand.get(commandId);
      if (!node || node.session_id !== childSessionId) {
        fail("AUTHORITY_VIOLATION", "committed lineage event is not durable");
      }
      const committedEvent = commit.event;
      if (
        !isRecord(committedEvent) ||
        committedEvent.type !== expectedEventType
      ) {
        fail("AUTHORITY_VIOLATION", "commit result disagrees with durable log");
      }
      let reportedData: SessionTreeLineageData;
      try {
        reportedData = lineageData(
          committedEvent.data,
          this.#scope,
          committedEvent.type,
        );
      } catch {
        fail("AUTHORITY_VIOLATION", "commit result has invalid lineage data");
      }
      if (
        JSON.stringify(reportedData) !== JSON.stringify(data) ||
        node.tree_event?.seq !== committedEvent.seq ||
        node.tree_event.hash !== committedEvent.hash
      ) {
        fail("AUTHORITY_VIOLATION", "commit result disagrees with durable log");
      }
      return immutable(
        { node, snapshot: updated.snapshot, replayed: commit.duplicate },
        "session tree command result",
      );
    } catch (error) {
      if (error instanceof SessionTreeError) throw error;
      throw new SessionTreeError(
        "AUTHORITY_FAILURE",
        `session tree authority failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  async #project(): Promise<Projection> {
    let rawLog: SessionTreeAuthorityLog;
    try {
      rawLog = await this.#authority.loadTree(this.#scope);
    } catch (error) {
      if (error instanceof SessionTreeError) throw error;
      throw new SessionTreeError(
        "AUTHORITY_FAILURE",
        `session tree authority failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (
      !isRecord(rawLog) ||
      rawLog.tenant_id !== this.#scope.tenant_id ||
      rawLog.root_session_id !== this.#scope.root_session_id ||
      !Array.isArray(rawLog.events)
    ) {
      fail("AUTHORITY_VIOLATION", "authority returned a cross-scope tree log");
    }

    const root: SessionTreeNode = immutable(
      {
        session_id: this.#scope.root_session_id,
        parent_session_id: null,
        ancestor_session_ids: [],
        operation: "root",
        command_id: null,
        source: null,
        inherited_security: null,
        replay_policy: null,
        created_at: null,
        tree_event: null,
      },
      "root session node",
    );
    const nodes: SessionTreeNode[] = [root];
    const bySession = new Map<string, SessionTreeNode>([
      [root.session_id, root],
    ]);
    const byCommand = new Map<string, SessionTreeNode>();
    let previousHash = "";

    for (let index = 0; index < rawLog.events.length; index += 1) {
      const rawEvent = rawLog.events[index];
      if (!isRecord(rawEvent)) {
        fail("CORRUPT_LOG", `authority event ${index + 1} is malformed`);
      }
      const seq = index + 1;
      if (rawEvent.seq !== seq) {
        fail(
          "CORRUPT_LOG",
          `authority event sequence is not contiguous at ${seq}`,
        );
      }
      if (
        typeof rawEvent.type !== "string" ||
        !EVENT_TYPES.has(rawEvent.type as SessionTreeAuthorityEventType)
      ) {
        fail("CORRUPT_LOG", `authority event type is invalid at ${seq}`);
      }
      if (
        typeof rawEvent.timestamp !== "string" ||
        rawEvent.timestamp.length === 0
      ) {
        fail("CORRUPT_LOG", `authority event timestamp is invalid at ${seq}`);
      }
      if (rawEvent.prev_hash !== previousHash) {
        fail("CORRUPT_LOG", `authority event ancestry is broken at ${seq}`);
      }
      const eventHash = sha256(rawEvent.hash, `authority event ${seq}.hash`);
      jsonClone(rawEvent.data, `authority event ${seq}.data`);
      previousHash = eventHash;

      if (rawEvent.type !== "branch" && rawEvent.type !== "fork") continue;
      const data = lineageData(rawEvent.data, this.#scope, rawEvent.type);
      if (byCommand.has(data.command_id)) {
        fail("CORRUPT_LOG", "lineage command_id appears more than once");
      }
      if (bySession.has(data.child_session_id)) {
        fail("CORRUPT_LOG", "lineage child creates a duplicate or cycle");
      }
      const parent = bySession.get(data.source.session_id);
      if (!parent) {
        fail("CORRUPT_LOG", "lineage source ancestor is missing");
      }
      const ancestors = [...parent.ancestor_session_ids, parent.session_id];
      if (ancestors.includes(data.child_session_id)) {
        fail("CORRUPT_LOG", "lineage creates a cycle");
      }
      const node: SessionTreeNode = immutable(
        {
          session_id: data.child_session_id,
          parent_session_id: data.source.session_id,
          ancestor_session_ids: ancestors,
          operation: data.operation,
          command_id: data.command_id,
          source: {
            session_id: data.source.session_id,
            seq: data.source.seq,
            hash: data.source.hash,
          },
          inherited_security: data.source.security,
          replay_policy: data.replay_policy,
          created_at: rawEvent.timestamp,
          tree_event: { seq, hash: eventHash },
        },
        `session tree node ${data.child_session_id}`,
      );
      nodes.push(node);
      bySession.set(node.session_id, node);
      byCommand.set(data.command_id, node);
    }

    const snapshot: SessionTreeSnapshot = immutable(
      {
        version: 1,
        tenant_id: this.#scope.tenant_id,
        root_session_id: this.#scope.root_session_id,
        authority_head: {
          seq: rawLog.events.length,
          hash: previousHash,
        },
        nodes,
      },
      "session tree snapshot",
    );
    return { snapshot, bySession, byCommand };
  }
}
