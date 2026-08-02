import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

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
} from "../../../../packages/runtime-core/src/session-tree.js";

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
    const point =
      this.#points.get(this.#sessionKey(value, sessionId))?.[seq - 1] ?? null;
    if (!point || !this.leak_cross_tenant_point) return clone(point);
    return { ...clone(point), tenant_id: "tenant-b" };
  }

  async appendLineageEvent(
    request: SessionTreeCommitRequest,
  ): Promise<SessionTreeCommitResult> {
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

    const sourcePoint =
      this.#points.get(
        this.#sessionKey(request.scope, request.source.session_id),
      )?.[request.source.seq - 1] ?? null;
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
    events.push(event);
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
      event: this.misreport_commit_event
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

describe("AH-RUNTIME-SESSIONTREE-001 SessionTree", () => {
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

    await expect(
      tree.branch({
        command_id: "command-misreported",
        source_session_id: scope.root_session_id,
        child_session_id: "session-misreported",
      }),
    ).rejects.toMatchObject({ code: "AUTHORITY_VIOLATION" });
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
    await expect(
      tree.fork({
        command_id: "command-future",
        source_session_id: scope.root_session_id,
        child_session_id: "future-child",
        at: { seq: 6, hash: hash("future") },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    await expect(
      tree.fork({
        command_id: "command-stale",
        source_session_id: scope.root_session_id,
        child_session_id: "stale-child",
        at: { seq: 2, hash: hash("wrong") },
      }),
    ).rejects.toMatchObject({ code: "STALE_SOURCE" });
    const head = await authority.readSessionHead(scope, scope.root_session_id);
    await expect(
      tree.rewind({
        command_id: "command-not-rewind",
        source_session_id: scope.root_session_id,
        child_session_id: "not-rewound-child",
        to: { seq: head!.seq, hash: head!.hash },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    expect(authority.commit_count).toBe(0);
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
});
