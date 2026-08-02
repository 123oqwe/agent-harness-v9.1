import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import {
  SessionTree,
  SessionTreeError,
  type SessionTreeAuthorityEvent,
  type SessionTreeAuthorityLog,
  type SessionTreeAuthorityPort,
  type SessionTreeCommitRequest,
  type SessionTreeCommitResult,
  type SessionTreeScope,
  type SessionTreeSecurityAnchor,
  type SessionTreeSessionPoint,
} from "../../../packages/runtime-core/src/session-tree.js";
import { DurableSession } from "../../../session/durable-session.js";
import {
  hashSessionEvent,
  isSessionEventType,
  SESSION_EVENT_TYPES,
  verifySessionEventChain,
} from "../../../session/session-event-codec.js";
import {
  decryptSessionString,
  deriveSessionRecordKey,
  encryptSessionString,
  hasSessionEncryptionEnvelope,
} from "../../../session/sqlite-authority-internals.js";
import { SqliteSessionStore } from "../../../session/sqlite-session-store.js";
import {
  SqliteSessionTreeAuthority,
  type SecurityStateResolver,
} from "../../../session/sqlite-session-tree-authority.js";
import { SqliteSessionTreeAuthority as PublicSqliteSessionTreeAuthority } from "../../../index.js";

const scope = Object.freeze({
  tenant_id: "tenant-a",
  root_session_id: "session-root",
}) satisfies SessionTreeScope;

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const security = (label: string): SessionTreeSecurityAnchor =>
  Object.freeze({
    state_hash: hash(`state:${label}`),
    capability_ceiling_hash: hash(`ceiling:${label}`),
    authorization_epoch: 7,
  });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("AH-RUNTIME-SESSIONTREE-001 canonical session event codec", () => {
  it("owns the exact frozen event-type vocabulary and rejects near misses", () => {
    expect(SESSION_EVENT_TYPES).toEqual([
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
    expect(Object.isFrozen(SESSION_EVENT_TYPES)).toBe(true);
    for (const type of SESSION_EVENT_TYPES) expect(isSessionEventType(type)).toBe(true);
    for (const invalid of [undefined, null, 1, {}, "", "User", "branch "]) {
      expect(isSessionEventType(invalid)).toBe(false);
    }
  });

  it("hashes every canonical field and verifies exact ancestry failures", () => {
    const first = {
      seq: 1,
      type: "user" as const,
      timestamp: "2026-08-02T00:00:01.000Z",
      data: { text: "one" },
      prev_hash: "",
      hash: "",
    };
    first.hash = hashSessionEvent(
      first.seq,
      first.type,
      first.timestamp,
      first.data,
      first.prev_hash,
    );
    const second = {
      seq: 2,
      type: "assistant" as const,
      timestamp: "2026-08-02T00:00:02.000Z",
      data: { text: "two" },
      prev_hash: first.hash,
      hash: "",
    };
    second.hash = hashSessionEvent(
      second.seq,
      second.type,
      second.timestamp,
      second.data,
      second.prev_hash,
    );
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionEvent(2, first.type, first.timestamp, first.data, "")).not.toBe(
      first.hash,
    );
    expect(hashSessionEvent(1, second.type, first.timestamp, first.data, "")).not.toBe(
      first.hash,
    );
    expect(hashSessionEvent(1, first.type, second.timestamp, first.data, "")).not.toBe(
      first.hash,
    );
    expect(hashSessionEvent(1, first.type, first.timestamp, second.data, "")).not.toBe(
      first.hash,
    );
    expect(hashSessionEvent(1, first.type, first.timestamp, first.data, hash("prev"))).not.toBe(
      first.hash,
    );
    expect(() => verifySessionEventChain([first, second])).not.toThrow();
    expect(() =>
      verifySessionEventChain([first, { ...second, seq: 3 }]),
    ).toThrow("invalid session event ancestry at 2");
    expect(() =>
      verifySessionEventChain([first, { ...second, prev_hash: hash("wrong") }]),
    ).toThrow("invalid session event ancestry at 2");
    expect(() =>
      verifySessionEventChain([first, { ...second, hash: hash("wrong") }]),
    ).toThrow("session event hash mismatch at 2");
  });
});

describe("AH-RUNTIME-SESSIONTREE-001 shared SQLite cryptographic authority", () => {
  it("derives only from a valid persisted salt and the frozen HKDF context", () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      expect(() => deriveSessionRecordKey(database, MASTER_KEY)).toThrow(
        "session encryption salt unavailable",
      );
      database
        .prepare("INSERT INTO metadata (key, value) VALUES ('encryption_salt', ?)")
        .run(Buffer.alloc(31).toString("base64"));
      expect(() => deriveSessionRecordKey(database, MASTER_KEY)).toThrow(
        "session encryption salt invalid",
      );
      database
        .prepare("UPDATE metadata SET value = ? WHERE key = 'encryption_salt'")
        .run(Buffer.alloc(32, 7).toString("base64"));
      const first = deriveSessionRecordKey(database, MASTER_KEY);
      const second = deriveSessionRecordKey(database, MASTER_KEY);
      try {
        expect(first).toHaveLength(32);
        expect(first.equals(second)).toBe(true);
        expect(first.equals(Buffer.from(MASTER_KEY))).toBe(false);
      } finally {
        first.fill(0);
        second.fill(0);
      }
    } finally {
      database.close();
    }
  });

  it("authenticates the exact envelope, nonce, tag, and associated-data identity", () => {
    const key = Buffer.alloc(32, 9);
    try {
      const encrypted = encryptSessionString(key, "secret-value", "row:a");
      expect(hasSessionEncryptionEnvelope(encrypted)).toBe(true);
      expect(decryptSessionString(key, encrypted, "row:a")).toBe("secret-value");
      expect(() => decryptSessionString(key, encrypted, "row:b")).toThrow();
      for (const invalid of [
        "",
        "ahenc:v1:a:b",
        "other:v1:a:b:c",
        "ahenc:v2:a:b:c",
        "prefix:ahenc:v1:a:b:c",
      ]) {
        expect(hasSessionEncryptionEnvelope(invalid)).toBe(false);
        expect(() => decryptSessionString(key, invalid, "row:a")).toThrow(
          "invalid encrypted envelope",
        );
      }
      const parts = encrypted.split(":");
      const badNonce = [...parts];
      badNonce[2] = Buffer.alloc(11).toString("base64");
      expect(() => decryptSessionString(key, badNonce.join(":"), "row:a")).toThrow(
        "invalid encrypted envelope",
      );
      const badTag = [...parts];
      badTag[3] = Buffer.alloc(15).toString("base64");
      expect(() => decryptSessionString(key, badTag.join(":"), "row:a")).toThrow(
        "invalid encrypted envelope",
      );
    } finally {
      key.fill(0);
    }
  });
});

class TestDurableSessionAuthority implements SessionTreeAuthorityPort {
  readonly #logs = new Map<string, SessionTreeAuthorityEvent[]>();
  readonly #points = new Map<string, SessionTreeSessionPoint[]>();
  readonly #commands = new Map<
    string,
    { fingerprint: string; event: SessionTreeAuthorityEvent }
  >();
  readonly #children = new Set<string>();
  commit_count = 0;
  external_effect_count = 0;
  leak_cross_tenant_point = false;
  misreport_commit_event = false;
  raw_log_override: unknown = undefined;
  load_error: unknown = undefined;
  head_override: unknown = undefined;
  point_override: unknown = undefined;
  commit_override: unknown = undefined;
  commit_event_transform:
    | ((event: SessionTreeAuthorityEvent) => SessionTreeAuthorityEvent)
    | undefined;
  persisted_event_transform:
    | ((event: SessionTreeAuthorityEvent) => SessionTreeAuthorityEvent)
    | undefined;
  append_error: unknown = undefined;
  append_attempts = 0;

  constructor() {
    this.seedSession(scope, scope.root_session_id, 5, security("root"));
  }

  #treeKey(value: SessionTreeScope): string {
    return `${value.tenant_id}\u0000${value.root_session_id}`;
  }

  #sessionKey(value: SessionTreeScope, sessionId: string): string {
    return `${this.#treeKey(value)}\u0000${sessionId}`;
  }

  seedSession(
    value: SessionTreeScope,
    sessionId: string,
    count: number,
    inheritedSecurity: SessionTreeSecurityAnchor,
  ): void {
    const points: SessionTreeSessionPoint[] = [];
    for (let seq = 1; seq <= count; seq += 1) {
      points.push(
        Object.freeze({
          tenant_id: value.tenant_id,
          root_session_id: value.root_session_id,
          session_id: sessionId,
          seq,
          hash: hash(`${this.#sessionKey(value, sessionId)}:${seq}`),
          security: inheritedSecurity,
        }),
      );
    }
    this.#points.set(this.#sessionKey(value, sessionId), points);
  }

  async loadTree(value: SessionTreeScope): Promise<SessionTreeAuthorityLog> {
    if (this.load_error !== undefined) throw this.load_error;
    if (this.raw_log_override !== undefined) {
      return this.raw_log_override as SessionTreeAuthorityLog;
    }
    return {
      tenant_id: value.tenant_id,
      root_session_id: value.root_session_id,
      events: clone(this.#logs.get(this.#treeKey(value)) ?? []),
    };
  }

  async readSessionHead(
    value: SessionTreeScope,
    sessionId: string,
  ): Promise<SessionTreeSessionPoint | null> {
    if (this.head_override !== undefined) {
      return clone(this.head_override) as SessionTreeSessionPoint | null;
    }
    const points = this.#points.get(this.#sessionKey(value, sessionId));
    const point = points?.at(-1) ?? null;
    if (!point || !this.leak_cross_tenant_point) return clone(point);
    return { ...clone(point), tenant_id: "tenant-b" };
  }

  async readSessionPoint(
    value: SessionTreeScope,
    sessionId: string,
    seq: number,
  ): Promise<SessionTreeSessionPoint | null> {
    if (this.point_override !== undefined) {
      return clone(this.point_override) as SessionTreeSessionPoint | null;
    }
    const point =
      this.#points.get(this.#sessionKey(value, sessionId))?.[seq - 1] ?? null;
    if (!point || !this.leak_cross_tenant_point) return clone(point);
    return { ...clone(point), tenant_id: "tenant-b" };
  }

  async appendLineageEvent(
    request: SessionTreeCommitRequest,
  ): Promise<SessionTreeCommitResult> {
    this.append_attempts += 1;
    if (this.append_error !== undefined) throw this.append_error;
    if (this.commit_override !== undefined) {
      return clone(this.commit_override) as SessionTreeCommitResult;
    }
    // Force concurrent callers to cross an async boundary before the authority's
    // atomic idempotency/CAS section.
    await Promise.resolve();
    const commandKey = `${this.#treeKey(request.scope)}\u0000${request.command_id}`;
    const fingerprint = JSON.stringify({
      operation: request.operation,
      child: request.child_session_id,
      source: request.source,
      source_head: request.source_head,
    });
    const existing = this.#commands.get(commandKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new SessionTreeError(
          "COMMAND_CONFLICT",
          "command_id already has a different durable meaning",
        );
      }
      return { event: clone(existing.event), duplicate: true };
    }

    const events = this.#logs.get(this.#treeKey(request.scope)) ?? [];
    const actualHead = events.at(-1);
    expect(request.expected_tree_head).toEqual(
      actualHead
        ? { seq: actualHead.seq, hash: actualHead.hash }
        : { seq: 0, hash: "" },
    );
    const childKey = this.#sessionKey(request.scope, request.child_session_id);
    if (this.#children.has(childKey)) {
      throw new SessionTreeError(
        "SESSION_CONFLICT",
        "child session already exists",
      );
    }

    const sourcePoints = this.#points.get(
      this.#sessionKey(request.scope, request.source.session_id),
    );
    const sourcePoint =
      request.source.seq === 0 && request.source.hash === "" && sourcePoints
        ? request.source
        : sourcePoints?.[request.source.seq - 1] ?? null;
    if (!sourcePoint || sourcePoint.hash !== request.source.hash) {
      throw new SessionTreeError("STALE_SOURCE", "source point changed");
    }

    const seq = events.length + 1;
    const prev_hash = actualHead?.hash ?? "";
    const event: SessionTreeAuthorityEvent = Object.freeze({
      seq,
      type: request.event_type,
      timestamp: `2026-08-02T00:00:${String(seq).padStart(2, "0")}.000Z`,
      data: clone(request.data),
      prev_hash,
      hash: hash(
        JSON.stringify({
          seq,
          type: request.event_type,
          data: request.data,
          prev_hash,
        }),
      ),
    });
    events.push(
      this.persisted_event_transform
        ? this.persisted_event_transform(clone(event))
        : event,
    );
    this.#logs.set(this.#treeKey(request.scope), events);
    this.#children.add(childKey);
    this.#points.set(childKey, [
      Object.freeze({
        tenant_id: request.scope.tenant_id,
        root_session_id: request.scope.root_session_id,
        session_id: request.child_session_id,
        seq: 1,
        hash: hash(`child:${request.child_session_id}:${event.hash}`),
        security: request.source.security,
      }),
    ]);
    this.#commands.set(commandKey, { fingerprint, event });
    this.commit_count += 1;
    return {
      event: this.commit_event_transform
        ? this.commit_event_transform(clone(event))
        : this.misreport_commit_event
        ? { ...clone(event), type: event.type === "fork" ? "branch" : "fork" }
        : clone(event),
      duplicate: false,
    };
  }

  async rawEvents(value = scope): Promise<SessionTreeAuthorityEvent[]> {
    return [...clone((await this.loadTree(value)).events)];
  }

  injectLineage(
    value: SessionTreeScope,
    data: SessionTreeCommitRequest["data"],
  ): void {
    const events = this.#logs.get(this.#treeKey(value)) ?? [];
    const seq = events.length + 1;
    const prev_hash = events.at(-1)?.hash ?? "";
    events.push({
      seq,
      type: data.operation === "fork" ? "fork" : "branch",
      timestamp: "2026-08-02T00:00:00.000Z",
      data: clone(data),
      prev_hash,
      hash: hash(`injected:${seq}:${JSON.stringify(data)}:${prev_hash}`),
    });
    this.#logs.set(this.#treeKey(value), events);
  }

  tamperPreviousHash(value = scope): void {
    const events = this.#logs.get(this.#treeKey(value));
    if (!events?.[0]) throw new Error("no event to tamper");
    events[0] = { ...events[0], prev_hash: hash("tampered") };
  }
}

const anchor = async (
  authority: TestDurableSessionAuthority,
  sessionId = scope.root_session_id,
  seq = 3,
) => {
  const point = await authority.readSessionPoint(scope, sessionId, seq);
  if (!point) throw new Error("missing test anchor");
  return { seq: point.seq, hash: point.hash };
};

const namedAuthorityFault = (
  code: string,
  message: unknown = `authority:${code}`,
) => ({ name: "SessionTreeAuthorityFault", code, message });

const expectTreeError = async (
  operation: Promise<unknown>,
  code: string,
  message: string,
) => {
  await expect(operation).rejects.toMatchObject({ code, message });
};

describe("AH-RUNTIME-SESSIONTREE-001 SessionTree", () => {
  it("publishes a stable typed error identity", () => {
    const error = new SessionTreeError("INVALID_INPUT", "invalid");
    expect(error.name).toBe("SessionTreeError");
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("invalid");
  });

  it("branches at the durable head and projects immutable parent/ancestor relationships", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority);

    const first = await tree.branch({
      command_id: "command-branch-a",
      source_session_id: scope.root_session_id,
      child_session_id: "session-a",
    });
    const second = await tree.branch({
      command_id: "command-branch-b",
      source_session_id: "session-a",
      child_session_id: "session-b",
    });

    expect(first.node).toMatchObject({
      session_id: "session-a",
      parent_session_id: scope.root_session_id,
      ancestor_session_ids: [scope.root_session_id],
      operation: "branch",
      replay_policy: "lineage_only_no_effect_replay",
    });
    expect(second.node).toMatchObject({
      session_id: "session-b",
      parent_session_id: "session-a",
      ancestor_session_ids: [scope.root_session_id, "session-a"],
    });
    expect(Object.isFrozen(second.snapshot)).toBe(true);
    expect(Object.isFrozen(second.snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(second.node.ancestor_session_ids)).toBe(true);
    expect(second.snapshot.nodes[0]).toMatchObject({
      operation: "root",
      parent_session_id: null,
    });
    expect(Object.isFrozen(second.node.source)).toBe(true);
    expect(Object.isFrozen(second.node.inherited_security)).toBe(true);
  });

  it("forks from an exact historical parent hash and inherits authority security without caller override", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority);
    const at = await anchor(authority, scope.root_session_id, 2);

    const result = await tree.fork({
      command_id: "command-fork",
      source_session_id: scope.root_session_id,
      child_session_id: "session-fork",
      at,
      security: security("attacker") as never,
    } as Parameters<SessionTree["fork"]>[0]);

    expect(result.node.source).toEqual({
      session_id: scope.root_session_id,
      ...at,
    });
    expect(result.node.inherited_security).toEqual(security("root"));
    expect(result.node.inherited_security).not.toEqual(security("attacker"));
    expect((await authority.rawEvents())[0]?.type).toBe("fork");
  });

  it("rewinds by appending a new lineage event and never rewrites or replays old effects", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority);
    await tree.branch({
      command_id: "command-before-rewind",
      source_session_id: scope.root_session_id,
      child_session_id: "session-before-rewind",
    });
    const before = await authority.rawEvents();
    const at = await anchor(authority, scope.root_session_id, 2);

    const result = await tree.rewind({
      command_id: "command-rewind",
      source_session_id: scope.root_session_id,
      child_session_id: "session-rewound",
      to: at,
    });
    const after = await authority.rawEvents();

    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.type).toBe("branch");
    expect(result.node.operation).toBe("rewind");
    expect(result.node.source).toEqual({
      session_id: scope.root_session_id,
      ...at,
    });
    expect(authority.external_effect_count).toBe(0);
  });

  it("fails closed when the authority commit response disagrees with its durable event", async () => {
    const authority = new TestDurableSessionAuthority();
    authority.misreport_commit_event = true;
    const tree = new SessionTree(scope, authority);

    await expectTreeError(
      tree.branch({
        command_id: "command-misreported",
        source_session_id: scope.root_session_id,
        child_session_id: "session-misreported",
      }),
      "AUTHORITY_VIOLATION",
      "commit result disagrees with durable log",
    );
  });

  it("reconstructs the same stable JSON snapshot after restart from the append-only authority", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority);
    await tree.fork({
      command_id: "command-restart",
      source_session_id: scope.root_session_id,
      child_session_id: "session-restart",
      at: await anchor(authority),
    });

    const before = await tree.snapshot();
    const after = await new SessionTree(scope, authority).snapshot();

    expect(after).toEqual(before);
    expect(JSON.parse(JSON.stringify(after))).toEqual(after);
    expect(after.nodes.map((node) => node.session_id)).toEqual([
      scope.root_session_id,
      "session-restart",
    ]);
  });

  it("makes sequential and concurrent duplicate commands idempotent", async () => {
    const authority = new TestDurableSessionAuthority();
    const firstTree = new SessionTree(scope, authority);
    const command = {
      command_id: "command-idempotent",
      source_session_id: scope.root_session_id,
      child_session_id: "session-idempotent",
      at: await anchor(authority),
    };

    const [first, concurrent] = await Promise.all([
      firstTree.fork(command),
      new SessionTree(scope, authority).fork(command),
    ]);
    const repeated = await firstTree.fork(command);

    expect(first.node).toEqual(concurrent.node);
    expect(first.node).toEqual(repeated.node);
    expect([first.replayed, concurrent.replayed].sort()).toEqual([false, true]);
    expect(repeated.replayed).toBe(true);
    expect(authority.commit_count).toBe(1);
    expect(await authority.rawEvents()).toHaveLength(1);
  });

  it("fails closed for reused command IDs with a different durable meaning", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority);
    await tree.branch({
      command_id: "command-conflict",
      source_session_id: scope.root_session_id,
      child_session_id: "session-one",
    });

    await expect(
      tree.branch({
        command_id: "command-conflict",
        source_session_id: scope.root_session_id,
        child_session_id: "session-two",
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
    expect(authority.commit_count).toBe(1);
  });

  it("rejects missing, future, stale-hash, and non-historical rewind targets", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority);

    await expect(
      tree.fork({
        command_id: "command-missing",
        source_session_id: "missing-session",
        child_session_id: "missing-child",
        at: { seq: 1, hash: hash("missing") },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    await expectTreeError(
      tree.fork({
        command_id: "command-future",
        source_session_id: scope.root_session_id,
        child_session_id: "future-child",
        at: { seq: 6, hash: hash("future") },
      }),
      "INVALID_TARGET",
      "target is later than the source head",
    );
    await expectTreeError(
      tree.fork({
        command_id: "command-stale",
        source_session_id: scope.root_session_id,
        child_session_id: "stale-child",
        at: { seq: 2, hash: hash("wrong") },
      }),
      "STALE_SOURCE",
      "target hash does not match the authority",
    );
    const head = await authority.readSessionHead(scope, scope.root_session_id);
    await expectTreeError(
      tree.rewind({
        command_id: "command-not-rewind",
        source_session_id: scope.root_session_id,
        child_session_id: "not-rewound-child",
        to: { seq: head!.seq, hash: head!.hash },
      }),
      "INVALID_TARGET",
      "rewind must target an earlier source point",
    );
    await expect(
      tree.fork({
        command_id: "command-at-head",
        source_session_id: scope.root_session_id,
        child_session_id: "head-fork-child",
        at: { seq: head!.seq, hash: head!.hash },
      }),
    ).resolves.toMatchObject({ node: { source: { seq: head!.seq } } });
    expect(authority.commit_count).toBe(1);
  });

  it("rejects cross-tenant authority responses and cannot discover another tenant's session", async () => {
    const authority = new TestDurableSessionAuthority();
    const tenantB = {
      tenant_id: "tenant-b",
      root_session_id: scope.root_session_id,
    };
    authority.seedSession(tenantB, "tenant-b-only", 2, security("tenant-b"));
    const tree = new SessionTree(scope, authority);

    await expect(
      tree.branch({
        command_id: "command-cross-tenant-hidden",
        source_session_id: "tenant-b-only",
        child_session_id: "cross-tenant-child",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });

    authority.leak_cross_tenant_point = true;
    await expect(
      tree.branch({
        command_id: "command-cross-tenant-leak",
        source_session_id: scope.root_session_id,
        child_session_id: "leaked-child",
      }),
    ).rejects.toMatchObject({ code: "AUTHORITY_VIOLATION" });
    expect(authority.commit_count).toBe(0);
  });

  it("rejects root reuse, existing children, cycles, and malformed identifiers", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority);
    await tree.branch({
      command_id: "command-existing",
      source_session_id: scope.root_session_id,
      child_session_id: "session-existing",
    });

    const invalidPairs: Array<readonly [string, string]> = [
      ["command-root-cycle", scope.root_session_id],
      ["command-existing-child", "session-existing"],
      ["", "valid-child"],
      ["command-malformed", "../escape"],
    ];
    for (const [command_id, child_session_id] of invalidPairs) {
      await expect(
        tree.branch({
          command_id,
          source_session_id: scope.root_session_id,
          child_session_id,
        }),
      ).rejects.toBeInstanceOf(SessionTreeError);
    }
    expect(authority.commit_count).toBe(1);
  });

  it("rejects missing ancestors and tampered authority hash ancestry during recovery", async () => {
    const missing = new TestDurableSessionAuthority();
    const source = await missing.readSessionPoint(
      scope,
      scope.root_session_id,
      2,
    );
    const head = await missing.readSessionHead(scope, scope.root_session_id);
    missing.injectLineage(scope, {
      version: 1,
      command_id: "command-injected-missing-parent",
      operation: "fork",
      child_session_id: "injected-child",
      source: { ...source!, session_id: "missing-parent" },
      source_head: { ...head!, session_id: "missing-parent" },
      replay_policy: "lineage_only_no_effect_replay",
    });
    await expect(
      new SessionTree(scope, missing).snapshot(),
    ).rejects.toMatchObject({ code: "CORRUPT_LOG" });

    const tampered = new TestDurableSessionAuthority();
    await new SessionTree(scope, tampered).branch({
      command_id: "command-before-tamper",
      source_session_id: scope.root_session_id,
      child_session_id: "session-before-tamper",
    });
    tampered.tamperPreviousHash();
    await expect(
      new SessionTree(scope, tampered).snapshot(),
    ).rejects.toMatchObject({ code: "CORRUPT_LOG" });
  });

  it("fails closed before projecting an authority log beyond its resource ceiling", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority, {
      max_tree_events: 1,
      max_depth: 8,
    });
    await tree.branch({
      command_id: "bounded-first",
      source_session_id: scope.root_session_id,
      child_session_id: "bounded-child-a",
    });
    await new SessionTree(scope, authority).branch({
      command_id: "bounded-second",
      source_session_id: scope.root_session_id,
      child_session_id: "bounded-child-b",
    });
    await expectTreeError(
      tree.snapshot(),
      "RESOURCE_LIMIT",
      "session tree event limit exceeded",
    );
  });

  it("rejects a child that would exceed the configured tree depth", async () => {
    const authority = new TestDurableSessionAuthority();
    const tree = new SessionTree(scope, authority, {
      max_tree_events: 10,
      max_depth: 1,
    });
    await tree.branch({
      command_id: "bounded-depth-one",
      source_session_id: scope.root_session_id,
      child_session_id: "bounded-depth-child",
    });
    await expectTreeError(
      tree.branch({
        command_id: "bounded-depth-two",
        source_session_id: "bounded-depth-child",
        child_session_id: "bounded-depth-grandchild",
      }),
      "RESOURCE_LIMIT",
      "session tree depth limit reached",
    );
    expect(authority.commit_count).toBe(1);
  });

  it("rejects invalid projection resource limits", () => {
    const authority = new TestDurableSessionAuthority();
    for (const options of [
      { max_tree_events: 0 },
      { max_depth: 0 },
      { max_tree_events: Number.NaN },
    ]) {
      expect(() => new SessionTree(scope, authority, options)).toThrow(
        "must be a positive safe integer",
      );
    }
  });

  it("validates scope, authority ports, identifier boundaries, and target anchors exactly", async () => {
    const authority = new TestDurableSessionAuthority();
    for (const invalidScope of [
      undefined,
      { tenant_id: "", root_session_id: "root" },
      { tenant_id: "../tenant", root_session_id: "root" },
      { tenant_id: `a${"b".repeat(128)}`, root_session_id: "root" },
      { tenant_id: "tenant\n", root_session_id: "root" },
    ]) {
      expect(
        () => new SessionTree(invalidScope as never, authority),
      ).toThrowError(expect.objectContaining({
        code: "INVALID_INPUT",
        message: "tenant_id is invalid",
      }));
    }
    expect(
      () => new SessionTree(scope, null as never),
    ).toThrowError(expect.objectContaining({
      code: "INVALID_INPUT",
      message: "session tree authority is required",
    }));
    for (const method of [
      "loadTree",
      "readSessionHead",
      "readSessionPoint",
      "appendLineageEvent",
    ] as const) {
      const invalid = {
        ...authority,
        loadTree: authority.loadTree.bind(authority),
        readSessionHead: authority.readSessionHead.bind(authority),
        readSessionPoint: authority.readSessionPoint.bind(authority),
        appendLineageEvent: authority.appendLineageEvent.bind(authority),
        [method]: undefined,
      };
      expect(() => new SessionTree(scope, invalid as never)).toThrowError(
        expect.objectContaining({
          code: "INVALID_INPUT",
          message: `session tree authority.${method} is required`,
        }),
      );
    }
    const tree = new SessionTree(scope, authority);
    for (const [command_id, message] of [
      ["-leading", "command_id is invalid"],
      [`a${"b".repeat(128)}`, "command_id is invalid"],
      ["command\n", "command_id is invalid"],
    ] as const) {
      await expectTreeError(
        tree.branch({
          command_id,
          source_session_id: scope.root_session_id,
          child_session_id: "valid-child",
        }),
        "INVALID_INPUT",
        message,
      );
    }
    for (const target of [
      { seq: 0, hash: hash("target") },
      { seq: Number.NaN, hash: hash("target") },
      { seq: 1, hash: `${hash("target")}0` },
      { seq: 1, hash: `0${hash("target")}` },
    ]) {
      await expectTreeError(tree.fork({
        command_id: `target-${String(target.seq)}-${target.hash.length}`,
        source_session_id: scope.root_session_id,
        child_session_id: `target-child-${target.hash.length}`,
        at: target,
      }), target.seq < 1 || !Number.isSafeInteger(target.seq) ? "INVALID_TARGET" : "CORRUPT_LOG",
      target.seq < 1 || !Number.isSafeInteger(target.seq)
        ? "target.seq must be a positive safe integer"
        : "target.hash must be a SHA-256 hash");
    }
    const maxIdentifier = `a${"b".repeat(127)}`;
    await expect(
      tree.branch({
        command_id: maxIdentifier,
        source_session_id: scope.root_session_id,
        child_session_id: maxIdentifier,
      }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("translates only allowlisted named authority faults and bounds CAS retries", async () => {
    for (const code of [
      "SOURCE_NOT_FOUND",
      "INVALID_TARGET",
      "STALE_SOURCE",
      "SESSION_CONFLICT",
      "COMMAND_CONFLICT",
      "RESOURCE_LIMIT",
      "CORRUPT_LOG",
      "AUTHORITY_VIOLATION",
    ]) {
      const authority = new TestDurableSessionAuthority();
      authority.load_error = namedAuthorityFault(code);
      await expectTreeError(
        new SessionTree(scope, authority).snapshot(),
        code,
        `authority:${code}`,
      );
    }
    for (const malformed of [
      null,
      "failure",
      { name: "Other", code: "CORRUPT_LOG", message: "raw" },
      { name: "SessionTreeAuthorityFault", code: 7, message: "raw" },
      { name: "SessionTreeAuthorityFault", code: "UNKNOWN", message: "raw" },
    ]) {
      const authority = new TestDurableSessionAuthority();
      authority.load_error = malformed;
      await expect(
        new SessionTree(scope, authority).snapshot(),
      ).rejects.toMatchObject({ code: "AUTHORITY_FAILURE" });
    }
    const missingMessage = new TestDurableSessionAuthority();
    missingMessage.load_error = namedAuthorityFault("CORRUPT_LOG", 7);
    await expectTreeError(
      new SessionTree(scope, missingMessage).snapshot(),
      "CORRUPT_LOG",
      "session tree authority rejected the operation",
    );

    const retrying = new TestDurableSessionAuthority();
    retrying.append_error = namedAuthorityFault("TREE_HEAD_CONFLICT");
    await expectTreeError(
      new SessionTree(scope, retrying).branch({
        command_id: "retry-bounded",
        source_session_id: scope.root_session_id,
        child_session_id: "retry-child",
      }),
      "TREE_HEAD_CONFLICT",
      "authority:TREE_HEAD_CONFLICT",
    );
    expect(retrying.append_attempts).toBe(4);
  });

  it("rejects malformed source points and security anchors from the authority", async () => {
    const valid = await new TestDurableSessionAuthority().readSessionHead(
      scope,
      scope.root_session_id,
    );
    const cases: Array<readonly [unknown, string, string]> = [
      [7, "AUTHORITY_VIOLATION", "source head is malformed"],
      [{ ...valid, tenant_id: "tenant-b" }, "AUTHORITY_VIOLATION", "source head escaped its tenant/session scope"],
      [{ ...valid, root_session_id: "other" }, "AUTHORITY_VIOLATION", "source head escaped its tenant/session scope"],
      [{ ...valid, session_id: "other" }, "AUTHORITY_VIOLATION", "source head escaped its tenant/session scope"],
      [{ ...valid, seq: -1 }, "INVALID_TARGET", "source head.seq must be a positive safe integer"],
      [{ ...valid, hash: "bad" }, "CORRUPT_LOG", "source head.hash must be a SHA-256 hash"],
      [{ ...valid, security: null }, "AUTHORITY_VIOLATION", "source head security is missing"],
      [
        { ...valid, security: { ...valid!.security, authorization_epoch: -1 } },
        "AUTHORITY_VIOLATION",
        "source head authorization_epoch is invalid",
      ],
      [
        { ...valid, security: { ...valid!.security, state_hash: "bad" } },
        "CORRUPT_LOG",
        "source head.state_hash must be a SHA-256 hash",
      ],
      [
        {
          ...valid,
          security: { ...valid!.security, capability_ceiling_hash: "bad" },
        },
        "CORRUPT_LOG",
        "source head.capability_ceiling_hash must be a SHA-256 hash",
      ],
    ];
    for (const [index, [head, code, message]] of cases.entries()) {
      const authority = new TestDurableSessionAuthority();
      authority.head_override = head;
      await expectTreeError(
        new SessionTree(scope, authority).branch({
          command_id: `malformed-head-${index}`,
          source_session_id: scope.root_session_id,
          child_session_id: "malformed-head-child",
        }),
        code,
        message,
      );
    }
  });

  it("validates the complete authority log envelope and every ordinary event type", async () => {
    const validEvent = (type: SessionTreeAuthorityEvent["type"]) => ({
      seq: 1,
      type,
      timestamp: "2026-08-02T00:00:01.000Z",
      data: { type },
      hash: hash(`event:${type}`),
      prev_hash: "",
    });
    for (const type of [
      "user",
      "assistant",
      "tool_call",
      "tool_result",
      "compaction",
      "steer",
      "system",
      "error",
      "summary",
    ] as const) {
      const authority = new TestDurableSessionAuthority();
      authority.raw_log_override = { ...scope, events: [validEvent(type)] };
      await expect(new SessionTree(scope, authority).snapshot()).resolves.toMatchObject({
        authority_head: { seq: 1, hash: hash(`event:${type}`) },
        nodes: [{ session_id: scope.root_session_id }],
      });
    }

    const circular: { self?: unknown } = {};
    circular.self = circular;
    const cases: Array<readonly [unknown, string, string]> = [
      [null, "AUTHORITY_VIOLATION", "authority returned a cross-scope tree log"],
      [[], "AUTHORITY_VIOLATION", "authority returned a cross-scope tree log"],
      [{ ...scope, tenant_id: "tenant-b", events: [] }, "AUTHORITY_VIOLATION", "authority returned a cross-scope tree log"],
      [{ ...scope, root_session_id: "other", events: [] }, "AUTHORITY_VIOLATION", "authority returned a cross-scope tree log"],
      [{ ...scope, events: {} }, "AUTHORITY_VIOLATION", "authority returned a cross-scope tree log"],
      [{ ...scope, events: [null] }, "CORRUPT_LOG", "authority event 1 is malformed"],
      [{ ...scope, events: [{ ...validEvent("user"), seq: 2 }] }, "CORRUPT_LOG", "authority event sequence is not contiguous at 1"],
      [{ ...scope, events: [{ ...validEvent("user"), type: 7 }] }, "CORRUPT_LOG", "authority event type is invalid at 1"],
      [{ ...scope, events: [{ ...validEvent("user"), type: "unknown" }] }, "CORRUPT_LOG", "authority event type is invalid at 1"],
      [{ ...scope, events: [{ ...validEvent("user"), timestamp: 7 }] }, "CORRUPT_LOG", "authority event timestamp is invalid at 1"],
      [{ ...scope, events: [{ ...validEvent("user"), timestamp: "" }] }, "CORRUPT_LOG", "authority event timestamp is invalid at 1"],
      [{ ...scope, events: [{ ...validEvent("user"), prev_hash: hash("wrong") }] }, "CORRUPT_LOG", "authority event ancestry is broken at 1"],
      [{ ...scope, events: [{ ...validEvent("user"), hash: "bad" }] }, "CORRUPT_LOG", "authority event 1.hash must be a SHA-256 hash"],
      [{ ...scope, events: [{ ...validEvent("user"), data: undefined }] }, "AUTHORITY_VIOLATION", "authority event 1.data is not JSON-serializable"],
      [{ ...scope, events: [{ ...validEvent("user"), data: circular }] }, "AUTHORITY_VIOLATION", "authority event 1.data is not JSON-serializable"],
    ];
    for (const [rawLog, code, message] of cases) {
      const authority = new TestDurableSessionAuthority();
      authority.raw_log_override = rawLog;
      await expectTreeError(new SessionTree(scope, authority).snapshot(), code, message);
    }
  });

  it("rejects every malformed lineage field and duplicate durable identity", async () => {
    const authority = new TestDurableSessionAuthority();
    await new SessionTree(scope, authority).branch({
      command_id: "valid-lineage",
      source_session_id: scope.root_session_id,
      child_session_id: "valid-lineage-child",
    });
    const valid = (await authority.rawEvents())[0]!;
    const data = valid.data as Record<string, unknown>;
    const source = data.source as Record<string, unknown>;
    const sourceHead = data.source_head as Record<string, unknown>;
    const malformed: Array<readonly [Record<string, unknown>, string, string]> = [
      [{ ...data, version: 2 }, "CORRUPT_LOG", "lineage event has an unsupported payload"],
      [{ ...data, operation: "unknown" }, "CORRUPT_LOG", "lineage operation is invalid"],
      [{ ...data, operation: "fork" }, "CORRUPT_LOG", "lineage event type does not match its operation"],
      [{ ...data, child_session_id: "../bad" }, "INVALID_INPUT", "lineage child_session_id is invalid"],
      [{ ...data, source: null }, "CORRUPT_LOG", "lineage source anchors are missing"],
      [{ ...data, source_head: null }, "CORRUPT_LOG", "lineage source anchors are missing"],
      [{ ...data, source: { ...source, session_id: "../bad" } }, "INVALID_INPUT", "lineage source_session_id is invalid"],
      [{ ...data, source_head: { ...sourceHead, session_id: "other" } }, "CORRUPT_LOG", "lineage source and source head disagree"],
      [{ ...data, source: { ...source, seq: 6, hash: hash("later") } }, "CORRUPT_LOG", "lineage source is later than its recorded head"],
      [{ ...data, source: { ...source, seq: 4, hash: hash("different") } }, "CORRUPT_LOG", "branch is not bound to the source head"],
      [{ ...data, operation: "rewind" }, "CORRUPT_LOG", "rewind does not target historical state"],
      [{ ...data, replay_policy: "unsafe" }, "CORRUPT_LOG", "lineage replay policy is unsafe"],
      [{ ...data, command_id: "../bad" }, "INVALID_INPUT", "lineage command_id is invalid"],
      [{ ...data, source: { ...source, tenant_id: "other" } }, "AUTHORITY_VIOLATION", "lineage source escaped its tenant/session scope"],
      [{ ...data, source: { ...source, security: null } }, "AUTHORITY_VIOLATION", "lineage source security is missing"],
    ];
    for (const [badData, code, message] of malformed) {
      const candidate = new TestDurableSessionAuthority();
      candidate.raw_log_override = {
        ...scope,
        events: [{ ...valid, data: badData }],
      };
      await expectTreeError(new SessionTree(scope, candidate).snapshot(), code, message);
    }

    await new SessionTree(scope, authority).branch({
      command_id: "valid-lineage-two",
      source_session_id: scope.root_session_id,
      child_session_id: "valid-lineage-child-two",
    });
    const duplicateEvents = await authority.rawEvents();
    const second = duplicateEvents[1]!;
    const secondData = second.data as Record<string, unknown>;
    for (const [field, value, message] of [
      ["command_id", "valid-lineage", "lineage command_id appears more than once"],
      ["child_session_id", "valid-lineage-child", "lineage child creates a duplicate or cycle"],
    ] as const) {
      const candidate = new TestDurableSessionAuthority();
      candidate.raw_log_override = {
        ...scope,
        events: [duplicateEvents[0], { ...second, data: { ...secondData, [field]: value } }],
      };
      await expectTreeError(
        new SessionTree(scope, candidate).snapshot(),
        "CORRUPT_LOG",
        message,
      );
    }
  });

  it("covers genesis anchors, missing source points, and recovered depth limits", async () => {
    const empty = new TestDurableSessionAuthority();
    empty.seedSession(scope, scope.root_session_id, 0, security("root"));
    empty.head_override = {
      ...scope,
      session_id: scope.root_session_id,
      seq: 0,
      hash: "",
      security: security("root"),
    };
    await expect(
      new SessionTree(scope, empty).branch({
        command_id: "empty-root-branch",
        source_session_id: scope.root_session_id,
        child_session_id: "empty-root-child",
      }),
    ).resolves.toMatchObject({
      node: { source: { seq: 0, hash: "" } },
    });

    const missingHead = new TestDurableSessionAuthority();
    missingHead.head_override = null;
    await expectTreeError(
      new SessionTree(scope, missingHead).branch({
        command_id: "missing-head",
        source_session_id: scope.root_session_id,
        child_session_id: "missing-head-child",
      }),
      "SOURCE_NOT_FOUND",
      "source session does not exist",
    );
    const missingPoint = new TestDurableSessionAuthority();
    const missingTarget = await anchor(missingPoint);
    missingPoint.point_override = null;
    await expectTreeError(
      new SessionTree(scope, missingPoint).fork({
        command_id: "missing-point",
        source_session_id: scope.root_session_id,
        child_session_id: "missing-point-child",
        at: missingTarget,
      }),
      "STALE_SOURCE",
      "target does not exist in the source session",
    );
    for (const head of [
      {
        ...(await new TestDurableSessionAuthority().readSessionHead(
          scope,
          scope.root_session_id,
        ))!,
        seq: 0,
      },
      {
        ...(await new TestDurableSessionAuthority().readSessionHead(
          scope,
          scope.root_session_id,
        ))!,
        hash: "",
      },
    ]) {
      const candidate = new TestDurableSessionAuthority();
      candidate.head_override = head;
      await expect(
        new SessionTree(scope, candidate).branch({
          command_id: `partial-genesis-${head.seq}-${head.hash.length}`,
          source_session_id: scope.root_session_id,
          child_session_id: "partial-genesis-child",
        }),
      ).rejects.toBeInstanceOf(SessionTreeError);
    }

    const deep = new TestDurableSessionAuthority();
    const deepTree = new SessionTree(scope, deep);
    await deepTree.branch({
      command_id: "recover-depth-one",
      source_session_id: scope.root_session_id,
      child_session_id: "recover-depth-child",
    });
    await deepTree.branch({
      command_id: "recover-depth-two",
      source_session_id: "recover-depth-child",
      child_session_id: "recover-depth-grandchild",
    });
    await expectTreeError(
      new SessionTree(scope, deep, {
        max_tree_events: 10,
        max_depth: 1,
      }).snapshot(),
      "RESOURCE_LIMIT",
      "session tree depth limit exceeded",
    );
  });

  it("rejects malformed, missing, and inconsistent authority commit responses", async () => {
    for (const [index, response] of [null, 7, { duplicate: "false" }].entries()) {
      const authority = new TestDurableSessionAuthority();
      authority.commit_override = response;
      await expectTreeError(
        new SessionTree(scope, authority).branch({
          command_id: `invalid-commit-${index}`,
          source_session_id: scope.root_session_id,
          child_session_id: "invalid-commit-child",
        }),
        "AUTHORITY_VIOLATION",
        "authority returned an invalid commit",
      );
    }
    const notDurable = new TestDurableSessionAuthority();
    notDurable.commit_override = {
      duplicate: false,
      event: {
        seq: 1,
        type: "branch",
        timestamp: "2026-08-02T00:00:01.000Z",
        data: {},
        hash: hash("not-durable"),
        prev_hash: "",
      },
    };
    await expectTreeError(
      new SessionTree(scope, notDurable).branch({
        command_id: "not-durable",
        source_session_id: scope.root_session_id,
        child_session_id: "not-durable-child",
      }),
      "AUTHORITY_VIOLATION",
      "committed lineage event is not durable",
    );
    const wrongDurableChild = new TestDurableSessionAuthority();
    wrongDurableChild.persisted_event_transform = (event) => ({
      ...event,
      data: {
        ...(event.data as Record<string, unknown>),
        child_session_id: "different-durable-child",
      },
    });
    await expectTreeError(
      new SessionTree(scope, wrongDurableChild).branch({
        command_id: "wrong-durable-child",
        source_session_id: scope.root_session_id,
        child_session_id: "requested-durable-child",
      }),
      "AUTHORITY_VIOLATION",
      "committed lineage event is not durable",
    );

    const transforms: Array<
      readonly [
        (event: SessionTreeAuthorityEvent) => SessionTreeAuthorityEvent,
        string,
      ]
    > = [
      [() => null as never, "commit result disagrees with durable log"],
      [(event) => ({ ...event, data: null }), "commit result has invalid lineage data"],
      [
        (event) => ({
          ...event,
          data: {
            ...(event.data as Record<string, unknown>),
            command_id: "different-command",
          },
        }),
        "commit result disagrees with durable log",
      ],
      [(event) => ({ ...event, seq: event.seq + 1 }), "commit result disagrees with durable log"],
      [(event) => ({ ...event, hash: hash("different") }), "commit result disagrees with durable log"],
    ];
    for (const [index, [transform, message]] of transforms.entries()) {
      const authority = new TestDurableSessionAuthority();
      authority.commit_event_transform = transform;
      await expectTreeError(
        new SessionTree(scope, authority).branch({
          command_id: `commit-transform-${index}`,
          source_session_id: scope.root_session_id,
          child_session_id: `commit-transform-child-${index}`,
        }),
        "AUTHORITY_VIOLATION",
        message,
      );
    }
  });

  it("preserves typed errors and normalizes unknown append/load failures", async () => {
    const typed = new TestDurableSessionAuthority();
    typed.load_error = new SessionTreeError("CORRUPT_LOG", "typed-log");
    await expectTreeError(
      new SessionTree(scope, typed).snapshot(),
      "CORRUPT_LOG",
      "typed-log",
    );
    for (const [failure, message] of [
      [new Error("append exploded"), "session tree authority failed: append exploded"],
      [7, "session tree authority failed: unknown error"],
    ] as const) {
      const authority = new TestDurableSessionAuthority();
      authority.append_error = failure;
      await expectTreeError(
        new SessionTree(scope, authority).branch({
          command_id: `append-failure-${typeof failure}`,
          source_session_id: scope.root_session_id,
          child_session_id: "append-failure-child",
        }),
        "AUTHORITY_FAILURE",
        message,
      );
    }
  });
});

const MASTER_KEY = Buffer.alloc(32, 0x42);

class MutableSecurityResolver implements SecurityStateResolver {
  readonly current = new Map<string, SessionTreeSecurityAnchor>();
  readonly allowed = new Set<string>();

  resolve(
    _value: SessionTreeScope,
    sessionId: string,
    persisted: SessionTreeSecurityAnchor,
  ): SessionTreeSecurityAnchor {
    return this.current.get(sessionId) ?? persisted;
  }

  isNoBroaderThan(
    candidate: SessionTreeSecurityAnchor,
    ceiling: SessionTreeSecurityAnchor,
  ): boolean {
    return (
      candidate.authorization_epoch >= ceiling.authorization_epoch &&
      (candidate.capability_ceiling_hash === ceiling.capability_ceiling_hash ||
        this.allowed.has(
          `${ceiling.capability_ceiling_hash}:${candidate.capability_ceiling_hash}`,
        ))
    );
  }
}

function realAuthorityFixture(
  limits?: {
    max_tree_events?: number;
    max_session_events?: number;
    max_event_bytes?: number;
    max_depth?: number;
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "session-tree-"));
  const dbPath = join(dir, "session.db");
  const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY });
  store.createRun(scope.root_session_id, "root", "direct");
  const root = new DurableSession(scope.root_session_id, {
    persistence: store,
    clock: (() => {
      let tick = 0;
      return () => `2026-08-02T01:00:${String(++tick).padStart(2, "0")}.000Z`;
    })(),
  });
  root.acquireWriter("test");
  root.append("user", { text: "one" });
  root.append("assistant", { text: "two" });
  root.append("system", { text: "three" });
  root.releaseWriter("test");
  const resolver = new MutableSecurityResolver();
  let authority: SqliteSessionTreeAuthority | undefined;
  try {
    authority = new SqliteSessionTreeAuthority(dbPath, {
      masterKey: MASTER_KEY,
      security_resolver: resolver,
      ...(limits ? { limits } : {}),
    });
    authority.bindRoot(scope, scope.root_session_id, security("root"));
  } catch (error) {
    authority?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    dbPath,
    store,
    authority,
    resolver,
    close() {
      authority.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function expectAuthorityConstructionFailure(
  factory: () => SqliteSessionTreeAuthority,
  message: string,
): void {
  let authority: SqliteSessionTreeAuthority | undefined;
  let thrown: unknown;
  try {
    authority = factory();
  } catch (error) {
    thrown = error;
  } finally {
    authority?.close();
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(message);
}

async function directAuthorityRequest(
  fixture: ReturnType<typeof realAuthorityFixture>,
  values: {
    command_id: string;
    child_session_id: string;
    operation?: "branch" | "fork" | "rewind";
    source?: Awaited<ReturnType<SqliteSessionTreeAuthority["readSessionHead"]>>;
    source_head?: Awaited<ReturnType<SqliteSessionTreeAuthority["readSessionHead"]>>;
    expected_tree_head?: { seq: number; hash: string };
  },
) {
  const source =
    values.source ??
    (await fixture.authority.readSessionHead(scope, scope.root_session_id));
  if (!source) throw new Error("direct request source is missing");
  const source_head = values.source_head ?? source;
  if (!source_head) throw new Error("direct request head is missing");
  const log = await fixture.authority.loadTree(scope);
  const operation = values.operation ?? "branch";
  const event_type: "branch" | "fork" =
    operation === "fork" ? "fork" : "branch";
  const expected_tree_head = values.expected_tree_head ?? {
    seq: log.events.length,
    hash: log.events.at(-1)?.hash ?? "",
  };
  const data = {
    version: 1 as const,
    command_id: values.command_id,
    operation,
    child_session_id: values.child_session_id,
    source,
    source_head,
    replay_policy: "lineage_only_no_effect_replay" as const,
  };
  return {
    scope,
    command_id: values.command_id,
    operation,
    child_session_id: values.child_session_id,
    source,
    source_head,
    expected_tree_head,
    event_type,
    data,
  };
}

describe("AH-RUNTIME-SESSIONTREE-001 SQLite authority integration", () => {
  afterAll(async () => {
    // better-sqlite3 finalizes native statements asynchronously after every
    // explicitly closed connection. Yield once so Vitest does not tear down
    // its worker while those native finalizers are still draining.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  });
  it("exposes the SQLite authority through the public Harness runtime", () => {
    expect(PublicSqliteSessionTreeAuthority).toBe(SqliteSessionTreeAuthority);
  });

  it("reconstructs after a real SQLite restart and keeps child sequence local", async () => {
    const fixture = realAuthorityFixture();
    let restarted: SqliteSessionTreeAuthority | undefined;
    try {
      const tree = new SessionTree(scope, fixture.authority);
      await tree.branch({
        command_id: "sqlite-branch-a",
        source_session_id: scope.root_session_id,
        child_session_id: "sqlite-child-a",
      });
      const childHead = await fixture.authority.readSessionHead(
        scope,
        "sqlite-child-a",
      );
      expect(childHead?.seq).toBe(1);
      const inspector = new Database(fixture.dbPath, { readonly: true });
      let childStorage: { storage_run_id: string };
      try {
        childStorage = inspector
          .prepare(
            "SELECT storage_run_id FROM session_tree_sessions WHERE tenant_id = ? AND root_session_id = ? AND session_id = ?",
          )
          .get(scope.tenant_id, scope.root_session_id, "sqlite-child-a") as {
          storage_run_id: string;
        };
      } finally {
        inspector.close();
      }
      expect(fixture.store.getRun(childStorage.storage_run_id)).toMatchObject({
        goal: "session tree child",
        strategy: "session_tree",
      });
      const storeEvents = fixture.store.loadEvents(childStorage.storage_run_id);
      expect(
        DurableSession.restore({
          session_id: childStorage.storage_run_id,
          events: storeEvents,
          snapshot: null,
        }).getEvents()[0],
      ).toMatchObject({ type: "branch", data: { command_id: "sqlite-branch-a" } });
      const before = await tree.snapshot();

      fixture.authority.close();
      restarted = new SqliteSessionTreeAuthority(fixture.dbPath, {
        masterKey: MASTER_KEY,
        security_resolver: fixture.resolver,
      });
      expect(await new SessionTree(scope, restarted).snapshot()).toEqual(before);
      await new SessionTree(scope, restarted).branch({
        command_id: "sqlite-branch-b",
        source_session_id: "sqlite-child-a",
        child_session_id: "sqlite-child-b",
      });
      const node = (await new SessionTree(scope, restarted).snapshot()).nodes.at(-1);
      expect(node?.source?.seq).toBe(1);
    } finally {
      restarted?.close();
      fixture.close();
    }
  });

  it("serializes distinct concurrent commands from two SQLite connections", async () => {
    const fixture = realAuthorityFixture();
    let second: SqliteSessionTreeAuthority | undefined;
    try {
      second = new SqliteSessionTreeAuthority(fixture.dbPath, {
        masterKey: MASTER_KEY,
        security_resolver: fixture.resolver,
      });
      const results = await Promise.all([
        new SessionTree(scope, fixture.authority).branch({
          command_id: "sqlite-concurrent-a",
          source_session_id: scope.root_session_id,
          child_session_id: "sqlite-concurrent-child-a",
        }),
        new SessionTree(scope, second).branch({
          command_id: "sqlite-concurrent-b",
          source_session_id: scope.root_session_id,
          child_session_id: "sqlite-concurrent-child-b",
        }),
      ]);
      expect(results.map((entry) => entry.node.session_id).sort()).toEqual([
        "sqlite-concurrent-child-a",
        "sqlite-concurrent-child-b",
      ]);
      expect((await new SessionTree(scope, second).snapshot()).nodes).toHaveLength(3);
    } finally {
      second?.close();
      fixture.close();
    }
  });

  it("isolates identical logical session IDs by tenant and rejects cross-scope reads", async () => {
    const fixture = realAuthorityFixture();
    const tenantB = { tenant_id: "tenant-b", root_session_id: "session-root-b" };
    try {
      fixture.store.createRun(tenantB.root_session_id, "root-b", "direct");
      fixture.authority.bindRoot(tenantB, tenantB.root_session_id, security("b"));
      await new SessionTree(scope, fixture.authority).branch({
        command_id: "same-command",
        source_session_id: scope.root_session_id,
        child_session_id: "same-child",
      });
      await new SessionTree(tenantB, fixture.authority).branch({
        command_id: "same-command",
        source_session_id: tenantB.root_session_id,
        child_session_id: "same-child",
      });
      expect((await new SessionTree(scope, fixture.authority).snapshot()).nodes).toHaveLength(2);
      expect((await new SessionTree(tenantB, fixture.authority).snapshot()).nodes).toHaveLength(2);
      await expect(
        fixture.authority.readSessionHead(scope, tenantB.root_session_id),
      ).resolves.toBeNull();
    } finally {
      fixture.close();
    }
  });

  it("rejects persisted hash tampering during restart reconstruction", async () => {
    const fixture = realAuthorityFixture();
    let restarted: SqliteSessionTreeAuthority | undefined;
    try {
      await new SessionTree(scope, fixture.authority).branch({
        command_id: "tamper-command",
        source_session_id: scope.root_session_id,
        child_session_id: "tamper-child",
      });
      fixture.authority.close();
      const db = new Database(fixture.dbPath);
      try {
        db.prepare("UPDATE events SET hash = ? WHERE run_id = ? AND seq = 1").run(
          "f".repeat(64),
          scope.root_session_id,
        );
      } finally {
        db.close();
      }
      restarted = new SqliteSessionTreeAuthority(fixture.dbPath, {
        masterKey: MASTER_KEY,
        security_resolver: fixture.resolver,
      });
      await expect(new SessionTree(scope, restarted).snapshot()).rejects.toMatchObject({
        code: "CORRUPT_LOG",
      });
    } finally {
      restarted?.close();
      fixture.close();
    }
  });

  it("inherits current attenuated security and rejects a broader resolver result", async () => {
    const fixture = realAuthorityFixture();
    try {
      const narrowed = security("narrowed");
      fixture.resolver.allowed.add(
        `${security("root").capability_ceiling_hash}:${narrowed.capability_ceiling_hash}`,
      );
      fixture.resolver.current.set(scope.root_session_id, narrowed);
      const historical = await fixture.authority.readSessionPoint(
        scope,
        scope.root_session_id,
        3,
      );
      const result = await new SessionTree(scope, fixture.authority).fork({
        command_id: "security-narrow",
        source_session_id: scope.root_session_id,
        child_session_id: "security-child",
        at: { seq: historical!.seq, hash: historical!.hash },
      });
      expect(result.node.inherited_security).toEqual(narrowed);

      fixture.resolver.current.set("security-child", {
        ...security("broader"),
        authorization_epoch: 0,
      });
      await expect(
        new SessionTree(scope, fixture.authority).branch({
          command_id: "security-expand",
          source_session_id: "security-child",
          child_session_id: "security-expanded-child",
        }),
      ).rejects.toMatchObject({ code: "AUTHORITY_VIOLATION" });
    } finally {
      fixture.close();
    }
  });

  it("fails closed at the configured tree event resource ceiling", async () => {
    const fixture = realAuthorityFixture({ max_tree_events: 4 });
    try {
      const tree = new SessionTree(scope, fixture.authority);
      await tree.branch({
        command_id: "limit-first",
        source_session_id: scope.root_session_id,
        child_session_id: "limit-child-a",
      });
      await expect(
        tree.branch({
          command_id: "limit-second",
          source_session_id: scope.root_session_id,
          child_session_id: "limit-child-b",
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    } finally {
      fixture.close();
    }
  });

  it("rejects an oversized lineage payload before any durable append", async () => {
    const fixture = realAuthorityFixture({ max_event_bytes: 200 });
    try {
      const tree = new SessionTree(scope, fixture.authority);
      await expect(
        tree.branch({
          command_id: "oversized-command",
          source_session_id: scope.root_session_id,
          child_session_id: "oversized-child",
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
      expect((await tree.snapshot()).nodes).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("validates encryption, resolver, limits, root binding, and closed state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-tree-invalid-"));
    const dbPath = join(dir, "session.db");
    const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY });
    const resolver = new MutableSecurityResolver();
    let authority: SqliteSessionTreeAuthority | undefined;
    try {
      expectAuthorityConstructionFailure(
        () =>
          new SqliteSessionTreeAuthority(dbPath, {
            masterKey: Buffer.alloc(31),
            security_resolver: resolver,
          }),
        "32-byte masterKey is required",
      );
      expectAuthorityConstructionFailure(
        () =>
          new SqliteSessionTreeAuthority(dbPath, {
            masterKey: MASTER_KEY,
            security_resolver: undefined as never,
          }),
        "security_resolver is required",
      );
      expectAuthorityConstructionFailure(
        () => new SqliteSessionTreeAuthority(dbPath, undefined as never),
        "32-byte masterKey is required",
      );
      for (const security_resolver of [
        { resolve: undefined, isNoBroaderThan: () => true },
        { resolve: () => security("root"), isNoBroaderThan: undefined },
      ]) {
        expectAuthorityConstructionFailure(
          () =>
            new SqliteSessionTreeAuthority(dbPath, {
              masterKey: MASTER_KEY,
              security_resolver: security_resolver as never,
            }),
          "security_resolver is required",
        );
      }
      for (const limits of [
        { max_tree_events: 0 },
        { max_session_events: 0 },
        { max_event_bytes: 0 },
        { max_depth: 0 },
      ]) {
        expectAuthorityConstructionFailure(
          () =>
            new SqliteSessionTreeAuthority(dbPath, {
              masterKey: MASTER_KEY,
              security_resolver: resolver,
              limits,
            }),
          "must be a positive safe integer",
        );
      }
      const openAuthority = new SqliteSessionTreeAuthority(dbPath, {
        masterKey: MASTER_KEY,
        security_resolver: resolver,
      });
      authority = openAuthority;
      expect(() => openAuthority.bindRoot(scope, "missing", security("root"))).toThrow(
        "root durable session does not exist",
      );
      store.createRun(scope.root_session_id, "root", "direct");
      openAuthority.bindRoot(scope, scope.root_session_id, security("root"));
      openAuthority.bindRoot(scope, scope.root_session_id, security("root"));
      openAuthority.close();
      openAuthority.close();
      await expect(openAuthority.loadTree(scope)).rejects.toThrow(
        "session tree authority is closed",
      );
    } finally {
      authority?.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records and rejects incompatible SessionTree schema versions", () => {
    const fixture = realAuthorityFixture();
    try {
      fixture.authority.close();
      const db = new Database(fixture.dbPath);
      try {
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session_tree_%' ORDER BY name",
            )
            .all(),
        ).toEqual([
          { name: "session_tree_commands" },
          { name: "session_tree_scopes" },
          { name: "session_tree_sessions" },
        ]);
        expect(
          db.prepare("SELECT value FROM metadata WHERE key = ?").get(
            "session_tree_schema_version",
          ),
        ).toEqual({ value: "1" });
        db.prepare("UPDATE metadata SET value = '2' WHERE key = ?").run(
          "session_tree_schema_version",
        );
      } finally {
        db.close();
      }
      expectAuthorityConstructionFailure(
        () =>
          new SqliteSessionTreeAuthority(fixture.dbPath, {
            masterKey: MASTER_KEY,
            security_resolver: fixture.resolver,
          }),
        "unsupported session tree schema version",
      );
    } finally {
      fixture.close();
    }
  });

  it("rejects every persisted event-envelope corruption", async () => {
    const corruptions: Array<readonly [string, string, unknown, string]> = [
      ["seq", "UPDATE events SET seq = ? WHERE run_id = ? AND seq = 1", 0, "invalid session event envelope at 1"],
      ["type", "UPDATE events SET type = ? WHERE run_id = ? AND seq = 1", "bogus", "invalid session event envelope at 1"],
      ["timestamp", "UPDATE events SET timestamp = ? WHERE run_id = ? AND seq = 1", "", "invalid session event envelope at 1"],
      ["prev_hash", "UPDATE events SET prev_hash = ? WHERE run_id = ? AND seq = 1", "f".repeat(64), "invalid session event envelope at 1"],
      ["hash", "UPDATE events SET hash = ? WHERE run_id = ? AND seq = 1", "f".repeat(64), "session event hash mismatch at 1"],
      ["encrypted data", "UPDATE events SET data_json = ? WHERE run_id = ? AND seq = 1", "plaintext", "invalid session event data at 1"],
    ];
    for (const [label, statement, replacement, message] of corruptions) {
      const fixture = realAuthorityFixture();
      let restarted: SqliteSessionTreeAuthority | undefined;
      try {
        fixture.authority.close();
        const db = new Database(fixture.dbPath);
        try {
          db.prepare(statement).run(replacement, scope.root_session_id);
        } finally {
          db.close();
        }
        restarted = new SqliteSessionTreeAuthority(fixture.dbPath, {
          masterKey: MASTER_KEY,
          security_resolver: fixture.resolver,
        });
        await expect(
          new SessionTree(scope, restarted).snapshot(),
          label,
        ).rejects.toMatchObject({ code: "CORRUPT_LOG", message });
      } finally {
        restarted?.close();
        fixture.close();
      }
    }
  });

  it("enforces per-session and depth ceilings before child creation", async () => {
    const sessionLimited = realAuthorityFixture({ max_session_events: 2 });
    try {
      await expect(
        new SessionTree(scope, sessionLimited.authority).branch({
          command_id: "session-limit",
          source_session_id: scope.root_session_id,
          child_session_id: "session-limit-child",
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    } finally {
      sessionLimited.close();
    }

    const depthLimited = realAuthorityFixture({ max_depth: 1 });
    try {
      const tree = new SessionTree(scope, depthLimited.authority);
      await tree.branch({
        command_id: "depth-one",
        source_session_id: scope.root_session_id,
        child_session_id: "depth-child",
      });
      await expect(
        tree.branch({
          command_id: "depth-two",
          source_session_id: "depth-child",
          child_session_id: "depth-grandchild",
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
      expect((await tree.snapshot()).nodes).toHaveLength(2);
    } finally {
      depthLimited.close();
    }
  });

  it("persists SQLite command idempotency and rejects conflicting replays", async () => {
    const fixture = realAuthorityFixture();
    try {
      const tree = new SessionTree(scope, fixture.authority);
      const command = {
        command_id: "sqlite-idempotent",
        source_session_id: scope.root_session_id,
        child_session_id: "sqlite-idempotent-child",
      };
      const first = await tree.branch(command);
      const repeated = await new SessionTree(scope, fixture.authority).branch(command);
      expect(first.replayed).toBe(false);
      expect(repeated.replayed).toBe(true);
      await expect(
        new SessionTree(scope, fixture.authority).fork({
          ...command,
          child_session_id: "sqlite-other-child",
          at: { seq: first.node.source!.seq, hash: first.node.source!.hash },
        }),
      ).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
      expect((await tree.snapshot()).nodes).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  it("returns the exact SQLite idempotency receipt for a byte-identical command", async () => {
    const fixture = realAuthorityFixture();
    try {
      const request = await directAuthorityRequest(fixture, {
        command_id: "direct-idempotent",
        child_session_id: "direct-idempotent-child",
      });
      const first = await fixture.authority.appendLineageEvent(request);
      const duplicate = await fixture.authority.appendLineageEvent(request);
      expect(first).toEqual({
        duplicate: false,
        event: expect.objectContaining({
          seq: 4,
          type: "branch",
          data: request.data,
        }),
      });
      expect(duplicate).toEqual({
        duplicate: true,
        event: first.event,
      });
    } finally {
      fixture.close();
    }
  });

  it("binds command idempotency to the event type and complete lineage payload", async () => {
    const fixture = realAuthorityFixture();
    try {
      const source = await fixture.authority.readSessionHead(
        scope,
        scope.root_session_id,
      );
      const log = await fixture.authority.loadTree(scope);
      const expected_tree_head = {
        seq: log.events.length,
        hash: log.events.at(-1)?.hash ?? "",
      };
      const data = {
        version: 1 as const,
        command_id: "direct-authority-command",
        operation: "branch" as const,
        child_session_id: "direct-authority-child",
        source: source!,
        source_head: source!,
        replay_policy: "lineage_only_no_effect_replay" as const,
      };
      const request = {
        scope,
        command_id: data.command_id,
        operation: data.operation,
        child_session_id: data.child_session_id,
        source: source!,
        source_head: source!,
        expected_tree_head,
        event_type: "branch" as const,
        data,
      };
      await fixture.authority.appendLineageEvent(request);
      await expect(
        fixture.authority.appendLineageEvent({
          ...request,
          operation: "fork",
          event_type: "fork",
          data: { ...data, operation: "fork" },
        }),
      ).rejects.toMatchObject({
        name: "SessionTreeAuthorityFault",
        code: "COMMAND_CONFLICT",
      });
      await expect(
        fixture.authority.appendLineageEvent({
          ...request,
          command_id: "mismatched-event-command",
          child_session_id: "mismatched-event-child",
          event_type: "fork",
          data: {
            ...data,
            command_id: "mismatched-event-command",
            child_session_id: "mismatched-event-child",
          },
        }),
      ).rejects.toMatchObject({
        name: "SessionTreeAuthorityFault",
        code: "AUTHORITY_VIOLATION",
        message: "lineage event does not match the authority commit request",
      });
      await expect(
        fixture.authority.appendLineageEvent({
          ...request,
          command_id: "mismatched-data-command",
          child_session_id: "mismatched-data-child",
          data: {
            ...data,
            command_id: "mismatched-data-command",
            child_session_id: "mismatched-data-child",
            replay_policy: "replay-effects",
          },
        }),
      ).rejects.toMatchObject({
        name: "SessionTreeAuthorityFault",
        code: "AUTHORITY_VIOLATION",
        message: "lineage event does not match the authority commit request",
      });
    } finally {
      fixture.close();
    }
  });

  it("fails every public read and write after close", async () => {
    const fixture = realAuthorityFixture();
    fixture.authority.close();
    try {
      await expect(fixture.authority.loadTree(scope)).rejects.toThrow(
        "session tree authority is closed",
      );
      await expect(
        fixture.authority.readSessionHead(scope, scope.root_session_id),
      ).rejects.toThrow("session tree authority is closed");
      await expect(
        fixture.authority.readSessionPoint(scope, scope.root_session_id, 1),
      ).rejects.toThrow("session tree authority is closed");
      expect(() =>
        fixture.authority.bindRoot(
          scope,
          scope.root_session_id,
          security("root"),
        ),
      ).toThrow("session tree authority is closed");
    } finally {
      fixture.store.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("emits typed faults for root binding and missing scopes", async () => {
    const fixture = realAuthorityFixture();
    try {
      fixture.store.createRun("other-root-storage", "other", "direct");
      expect(() =>
        fixture.authority.bindRoot(
          scope,
          "other-root-storage",
          security("root"),
        ),
      ).toThrowError(expect.objectContaining({
        name: "SessionTreeAuthorityFault",
        code: "SESSION_CONFLICT",
        message: "root scope is already bound",
      }));
      expect(() =>
        fixture.authority.bindRoot(
          scope,
          scope.root_session_id,
          security("different"),
        ),
      ).toThrowError(expect.objectContaining({
        name: "SessionTreeAuthorityFault",
        code: "SESSION_CONFLICT",
        message: "root session binding conflicts",
      }));
      await expect(
        fixture.authority.loadTree({
          tenant_id: scope.tenant_id,
          root_session_id: "missing-root",
        }),
      ).rejects.toMatchObject({
        code: "SOURCE_NOT_FOUND",
        message: "session tree scope does not exist",
      });
    } finally {
      fixture.close();
    }
  });

  it("fails closed for corrupt idempotency, stale CAS, duplicate children, and missing sources", async () => {
    const corruptIndex = realAuthorityFixture();
    try {
      const request = await directAuthorityRequest(corruptIndex, {
        command_id: "corrupt-index-command",
        child_session_id: "corrupt-index-child",
      });
      await corruptIndex.authority.appendLineageEvent(request);
      const database = new Database(corruptIndex.dbPath);
      try {
        database
          .prepare(
            "UPDATE session_tree_commands SET event_seq = 999 WHERE tenant_id = ? AND root_session_id = ? AND command_id = ?",
          )
          .run(scope.tenant_id, scope.root_session_id, request.command_id);
      } finally {
        database.close();
      }
      await expect(
        corruptIndex.authority.appendLineageEvent(request),
      ).rejects.toMatchObject({
        code: "CORRUPT_LOG",
        message: "idempotency index points to a missing event",
      });
    } finally {
      corruptIndex.close();
    }

    const staleHead = realAuthorityFixture();
    try {
      const request = await directAuthorityRequest(staleHead, {
        command_id: "stale-head-command",
        child_session_id: "stale-head-child",
        expected_tree_head: { seq: 0, hash: "" },
      });
      await expect(
        staleHead.authority.appendLineageEvent(request),
      ).rejects.toMatchObject({
        code: "TREE_HEAD_CONFLICT",
        message: "session tree head advanced concurrently",
      });
    } finally {
      staleHead.close();
    }

    for (const expected_tree_head of [
      { seq: 4, hash: hash("valid-hash-wrong-seq") },
      { seq: 3, hash: hash("wrong-hash-valid-seq") },
    ]) {
      const staleDimension = realAuthorityFixture();
      try {
        const currentLog = await staleDimension.authority.loadTree(scope);
        const current = {
          seq: currentLog.events.length,
          hash: currentLog.events.at(-1)!.hash,
        };
        const isolatedMismatch =
          expected_tree_head.seq === current.seq
            ? { seq: current.seq, hash: expected_tree_head.hash }
            : { seq: expected_tree_head.seq, hash: current.hash };
        await expect(
          staleDimension.authority.appendLineageEvent(
            await directAuthorityRequest(staleDimension, {
              command_id: `stale-${isolatedMismatch.seq}-${isolatedMismatch.hash.slice(0, 4)}`,
              child_session_id: `stale-child-${isolatedMismatch.seq}-${isolatedMismatch.hash.slice(0, 4)}`,
              expected_tree_head: isolatedMismatch,
            }),
          ),
        ).rejects.toMatchObject({
          code: "TREE_HEAD_CONFLICT",
          message: "session tree head advanced concurrently",
        });
      } finally {
        staleDimension.close();
      }
    }

    const childConflict = realAuthorityFixture();
    try {
      const first = await directAuthorityRequest(childConflict, {
        command_id: "child-first-command",
        child_session_id: "same-durable-child",
      });
      await childConflict.authority.appendLineageEvent(first);
      const second = await directAuthorityRequest(childConflict, {
        command_id: "child-second-command",
        child_session_id: "same-durable-child",
      });
      await expect(
        childConflict.authority.appendLineageEvent(second),
      ).rejects.toMatchObject({
        code: "SESSION_CONFLICT",
        message: "child session already exists",
      });
    } finally {
      childConflict.close();
    }

    const missingSource = realAuthorityFixture();
    try {
      const existing = await missingSource.authority.readSessionHead(
        scope,
        scope.root_session_id,
      );
      const missing = { ...existing!, session_id: "missing-source" };
      const request = await directAuthorityRequest(missingSource, {
        command_id: "missing-source-command",
        child_session_id: "missing-source-child",
        source: missing,
        source_head: missing,
      });
      await expect(
        missingSource.authority.appendLineageEvent(request),
      ).rejects.toMatchObject({
        code: "SOURCE_NOT_FOUND",
        message: "source session does not exist",
      });
    } finally {
      missingSource.close();
    }
  });

  it("validates every source anchor and security anchor inside the SQLite transaction", async () => {
    type AuthorityPoint = NonNullable<
      Awaited<ReturnType<SqliteSessionTreeAuthority["readSessionHead"]>>
    >;
    const variants: Array<{
      source?: Partial<AuthorityPoint>;
      source_head?: Partial<AuthorityPoint>;
      message: string;
    }> = [
      { source: { seq: 99 }, message: "source session point changed" },
      { source: { hash: hash("stale-source") }, message: "source session point changed" },
      { source_head: { seq: 99 }, message: "source session point changed" },
      { source_head: { hash: hash("stale-head") }, message: "source session point changed" },
      {
        source: { security: security("stale-source-security") },
        message: "source security state is stale or broader",
      },
      {
        source_head: { security: security("stale-head-security") },
        message: "source security state is stale or broader",
      },
    ];
    for (const [index, variant] of variants.entries()) {
      const fixture = realAuthorityFixture();
      try {
        const current = await fixture.authority.readSessionHead(
          scope,
          scope.root_session_id,
        );
        const source = { ...current!, ...(variant.source ?? {}) };
        const source_head = { ...current!, ...(variant.source_head ?? {}) };
        const request = await directAuthorityRequest(fixture, {
          command_id: `stale-anchor-${index}`,
          child_session_id: `stale-anchor-child-${index}`,
          source,
          source_head,
        });
        await expect(
          fixture.authority.appendLineageEvent(request),
        ).rejects.toMatchObject({ message: variant.message });
      } finally {
        fixture.close();
      }
    }
  });

  it("round-trips all durable event types and rejects malformed persisted security", async () => {
    const fixture = realAuthorityFixture();
    try {
      const restored = DurableSession.restore(
        {
          session_id: scope.root_session_id,
          events: fixture.store.loadEvents(scope.root_session_id),
          snapshot: null,
        },
        { persistence: fixture.store },
      );
      restored.acquireWriter("all-types");
      for (const type of [
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
      ] as const) {
        restored.append(type, { durable_type: type });
      }
      restored.releaseWriter("all-types");
      await expect(fixture.authority.loadTree(scope)).resolves.toMatchObject({
        events: expect.arrayContaining(
          DurableSession.EVENT_TYPES.map((type) => expect.objectContaining({ type })),
        ),
      });
    } finally {
      fixture.close();
    }

    const malformedValues = [
      "not-json",
      "null",
      JSON.stringify({ ...security("root"), state_hash: "bad" }),
      JSON.stringify({ ...security("root"), capability_ceiling_hash: "bad" }),
      JSON.stringify({ ...security("root"), authorization_epoch: -1 }),
      JSON.stringify({ ...security("root"), authorization_epoch: 0.5 }),
    ];
    for (const value of malformedValues) {
      const candidate = realAuthorityFixture();
      try {
        const database = new Database(candidate.dbPath);
        try {
          database
            .prepare(
              "UPDATE session_tree_sessions SET security_json = ? WHERE tenant_id = ? AND root_session_id = ? AND session_id = ?",
            )
            .run(value, scope.tenant_id, scope.root_session_id, scope.root_session_id);
        } finally {
          database.close();
        }
        await expect(
          candidate.authority.readSessionHead(scope, scope.root_session_id),
        ).rejects.toMatchObject({
          name: "SessionTreeAuthorityFault",
          code: "CORRUPT_LOG",
          message: "persisted security state is malformed",
        });
      } finally {
        candidate.close();
      }
    }
  });

  it("rejects decrypted event payloads that exceed the configured byte ceiling", async () => {
    const fixture = realAuthorityFixture({ max_event_bytes: 50 });
    try {
      const restored = DurableSession.restore(
        {
          session_id: scope.root_session_id,
          events: fixture.store.loadEvents(scope.root_session_id),
          snapshot: null,
        },
        { persistence: fixture.store },
      );
      restored.acquireWriter("payload-limit");
      restored.append("user", { text: "x".repeat(100) });
      restored.releaseWriter("payload-limit");
      await expect(fixture.authority.loadTree(scope)).rejects.toMatchObject({
        code: "RESOURCE_LIMIT",
        message: "session event payload limit exceeded",
      });
    } finally {
      fixture.close();
    }
  });
});
