import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionTree } from "../../../packages/runtime-core/src/session-tree.js";
import { DurableSession } from "../../../session/durable-session.js";
import { SqliteSessionStore } from "../../../session/sqlite-session-store.js";
import { createTrustedSessionStateRoot } from "../../../session/session-state-root.js";
import {
  SqliteSessionTreeAuthority,
  type SecurityStateResolver,
  type SessionTreeSecurityValue,
} from "../../../session/sqlite-session-tree-authority.js";
import {
  FileSessionTreeCheckpoint,
  type SessionTreeCheckpointHeads,
  type SessionTreeCheckpointPort,
  type SessionTreeCheckpointPrepare,
  type SessionTreeCheckpointScope,
} from "../../../session/session-tree-checkpoint.js";

const MASTER_KEY = Buffer.alloc(32, 0x42);
const scope = { tenant_id: "tenant-a", root_session_id: "session-root" };
const security = {
  state_hash: "1".repeat(64),
  capability_ceiling_hash: "2".repeat(64),
  authorization_epoch: 1,
};
const resolver: SecurityStateResolver = {
  resolve(
    _scope,
    _sessionId,
    persisted,
  ): SessionTreeSecurityValue {
    return persisted;
  },
  isNoBroaderThan(candidate, ceiling): boolean {
    return (
      candidate.authorization_epoch >= ceiling.authorization_epoch &&
      candidate.capability_ceiling_hash === ceiling.capability_ceiling_hash
    );
  },
};

class CrashCheckpoint implements SessionTreeCheckpointPort {
  mode: "none" | "before-db" | "after-db" | "after-anchor" = "none";
  crashed = false;

  constructor(readonly inner: FileSessionTreeCheckpoint) {}

  reconcile(scope: SessionTreeCheckpointScope, heads: SessionTreeCheckpointHeads) {
    if (this.crashed) throw new Error("simulated process crash");
    return this.inner.reconcile(scope, heads);
  }

  prepare(scope: SessionTreeCheckpointScope, value: SessionTreeCheckpointPrepare) {
    if (this.mode === "before-db") throw new Error("crash before database commit");
    this.inner.prepare(scope, value);
  }

  commit(scope: SessionTreeCheckpointScope, operationId: string) {
    if (this.mode === "after-db") {
      this.crashed = true;
      throw new Error("crash after database commit before anchor commit");
    }
    this.inner.commit(scope, operationId);
    if (this.mode === "after-anchor") {
      this.crashed = true;
      throw new Error("crash after anchor commit");
    }
  }
}

describe("AH-RUNTIME-SESSIONTREE-001 SQLite multi-process locking", () => {
  it.each(["before-db", "after-db", "after-anchor"] as const)(
    "reconciles a %s crash without duplicating lineage",
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "session-tree-checkpoint-crash-"));
      const stateRoot = createTrustedSessionStateRoot(directory);
      const dbPath = join(directory, "session.db");
      const checkpointDirectory = join(directory, "checkpoint");
      const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
      store.createScopedRun(scope, scope.root_session_id, "root", "direct");
      const root = new DurableSession(scope.root_session_id, { persistence: store });
      root.acquireWriter("checkpoint-test");
      root.append("user", { text: "root" });
      root.releaseWriter("checkpoint-test");
      const concrete = new FileSessionTreeCheckpoint(checkpointDirectory, MASTER_KEY);
      const crash = new CrashCheckpoint(concrete);
      const authority = new SqliteSessionTreeAuthority(dbPath, {
        masterKey: MASTER_KEY,
        state_root: stateRoot,
        security_resolver: resolver,
        checkpoint: crash,
      });
      authority.bindRoot(scope, scope.root_session_id, security);
      crash.mode = mode;
      const command = {
        command_id: `checkpoint-${mode}`,
        source_session_id: scope.root_session_id,
        child_session_id: `checkpoint-child-${mode}`,
      };
      try {
        await expect(
          new SessionTree(scope, authority).branch(command),
        ).rejects.toThrow(/crash/);
      } finally {
        authority.close();
        concrete.close();
      }

      const recoveredCheckpoint = new FileSessionTreeCheckpoint(
        checkpointDirectory,
        MASTER_KEY,
      );
      const recovered = new SqliteSessionTreeAuthority(dbPath, {
        masterKey: MASTER_KEY,
        state_root: stateRoot,
        security_resolver: resolver,
        checkpoint: recoveredCheckpoint,
      });
      try {
        const tree = new SessionTree(scope, recovered);
        if (mode === "before-db") {
          expect((await tree.snapshot()).nodes).toHaveLength(1);
          expect((await tree.branch(command)).replayed).toBe(false);
        } else {
          expect((await tree.snapshot()).nodes).toHaveLength(2);
          expect((await tree.branch(command)).replayed).toBe(true);
        }
        expect((await tree.snapshot()).nodes).toHaveLength(2);
        expect((await recovered.loadTree(scope)).events).toHaveLength(1);
      } finally {
        recovered.close();
        recoveredCheckpoint.close();
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("waits for an external immediate transaction and commits exactly once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "session-tree-process-lock-"));
    const stateRoot = createTrustedSessionStateRoot(directory);
    const dbPath = join(directory, "session.db");
    const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
    store.createScopedRun(scope, scope.root_session_id, "root", "direct");
    const root = new DurableSession(scope.root_session_id, { persistence: store });
    root.acquireWriter("lock-test");
    root.append("user", { text: "root" });
    root.releaseWriter("lock-test");
    const authority = new SqliteSessionTreeAuthority(dbPath, {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
      security_resolver: resolver,
    });
    authority.bindRoot(scope, scope.root_session_id, security);
    const child = spawn(
      process.execPath,
      [
        join(
          process.cwd(),
          "tests/phase-2/fixtures/session-tree-lock-holder.mjs",
        ),
        dbPath,
        "250",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
      expect(chunk.toString()).toContain("LOCKED");
      const startedAt = performance.now();
      const result = await new SessionTree(scope, authority).branch({
        command_id: "process-lock-command",
        source_session_id: scope.root_session_id,
        child_session_id: "process-lock-child",
      });
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(100);
      expect(result.replayed).toBe(false);
      expect((await new SessionTree(scope, authority).snapshot()).nodes).toHaveLength(2);
      const [exitCode] = (await once(child, "exit")) as [number];
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      authority.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
