import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SessionTree } from "../../../packages/runtime-core/src/session-tree.js";
import { DurableSession } from "../../../session/durable-session.js";
import { hasSessionEncryptionEnvelope } from "../../../session/sqlite-authority-internals.js";
import { FileSessionTreeCheckpoint } from "../../../session/session-tree-checkpoint.js";
import { SqliteSessionStore } from "../../../session/sqlite-session-store.js";
import { createTrustedSessionStateRoot } from "../../../session/session-state-root.js";
import {
  SqliteSessionTreeAuthority,
  type SecurityStateResolver,
  type SessionTreeSecurityValue,
} from "../../../session/sqlite-session-tree-authority.js";

const MASTER_KEY = Buffer.alloc(32, 0x62);
const scope = { tenant_id: "security-tenant", root_session_id: "security-root" };
const rootSecurity = {
  state_hash: "1".repeat(64),
  capability_ceiling_hash: "2".repeat(64),
  authorization_epoch: 4,
} satisfies SessionTreeSecurityValue;

class ControlledResolver implements SecurityStateResolver {
  result: SessionTreeSecurityValue | null = null;
  allow = true;
  mutatePersisted = false;

  resolve(
    _scope: typeof scope,
    _sessionId: string,
    persisted: SessionTreeSecurityValue,
  ): SessionTreeSecurityValue {
    if (this.mutatePersisted) {
      (persisted as { authorization_epoch: number }).authorization_epoch = 0;
    }
    return this.result ?? persisted;
  }

  isNoBroaderThan(): boolean {
    return this.allow;
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "session-tree-security-"));
  const stateRoot = createTrustedSessionStateRoot(directory);
  const dbPath = join(directory, "session.db");
  const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
  store.createScopedRun(scope, scope.root_session_id, "security root", "direct");
  const root = new DurableSession(scope.root_session_id, { persistence: store });
  root.acquireWriter("security");
  root.append("user", { text: "root" });
  root.releaseWriter("security");
  const resolver = new ControlledResolver();
  const authority = new SqliteSessionTreeAuthority(dbPath, {
    masterKey: MASTER_KEY,
    state_root: stateRoot,
    security_resolver: resolver,
  });
  authority.bindRoot(scope, scope.root_session_id, rootSecurity);
  return {
    directory,
    dbPath,
    stateRoot,
    store,
    resolver,
    authority,
    close() {
      authority.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function mutateEnvelope(envelope: string): string {
  const parts = envelope.split(":");
  const ciphertext = parts[4]!;
  parts[4] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
  return parts.join(":");
}

function checkpointMaterial(scopeValue = scope) {
  const key = createHmac("sha256", MASTER_KEY)
    .update("agent-harness/session-tree-checkpoint-key/v1")
    .digest();
  const values = [scopeValue.tenant_id, scopeValue.root_session_id];
  const canonical = Buffer.concat(
    values.flatMap((value) => {
      const bytes = Buffer.from(value);
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(bytes.byteLength);
      return [length, bytes];
    }),
  );
  const filename = `${createHmac("sha256", key)
    .update(canonical)
    .digest("hex")}.checkpoint`;
  return { key, filename };
}

function encryptedCheckpoint(scopeValue: typeof scope, state: unknown): string {
  const { key } = checkpointMaterial(scopeValue);
  const nonce = Buffer.alloc(12, 0x45);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        "session_tree_checkpoint",
        scopeValue.tenant_id,
        scopeValue.root_session_id,
      ]),
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state)),
    cipher.final(),
  ]);
  return [
    "ahcheckpoint:v1",
    nonce.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

const emptyHeads = {
  version: 1 as const,
  bound: false,
  tree: { seq: 0, hash: "" },
  session_count: 0,
  command_count: 0,
  sessions_hash: "0".repeat(64),
  security_hash: "0".repeat(64),
  snapshot_hash: "0".repeat(64),
  ownership_hash: "0".repeat(64),
  state_hash: "0".repeat(64),
};

describe("AH-RUNTIME-SESSIONTREE-001 security authority", () => {
  it("rejects a checkpoint directory beneath a symlinked ancestor", () => {
    const base = mkdtempSync(join(tmpdir(), "checkpoint-ancestor-"));
    const external = mkdtempSync(join(tmpdir(), "checkpoint-external-"));
    const link = join(base, "link");
    symlinkSync(external, link);
    try {
      expect(() =>
        new FileSessionTreeCheckpoint(join(link, "state"), MASTER_KEY),
      ).toThrow(/symlink|descriptor|authority/u);
      expect(readdirSync(external)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("does not execute a PATH-injected Python interpreter", () => {
    const directory = mkdtempSync(join(tmpdir(), "checkpoint-fake-python-"));
    const state = join(directory, "state");
    const fake = join(directory, "python3");
    const marker = join(directory, "fake-python-ran");
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );
    const prior = process.env.PATH;
    process.env.PATH = `${directory}:${prior ?? ""}`;
    let checkpoint: FileSessionTreeCheckpoint | undefined;
    try {
      checkpoint = new FileSessionTreeCheckpoint(state, MASTER_KEY);
      expect(existsSync(marker)).toBe(false);
    } finally {
      checkpoint?.close();
      process.env.PATH = prior;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates Python from PYTHONPATH and sitecustomize", () => {
    const directory = mkdtempSync(join(tmpdir(), "checkpoint-sitecustomize-"));
    const marker = join(directory, "executed");
    writeFileSync(
      join(directory, "sitecustomize.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed')\n`,
    );
    const prior = process.env.PYTHONPATH;
    process.env.PYTHONPATH = directory;
    const checkpointDirectory = join(directory, "checkpoint");
    let checkpoint: FileSessionTreeCheckpoint | undefined;
    try {
      checkpoint = new FileSessionTreeCheckpoint(checkpointDirectory, MASTER_KEY);
      expect(existsSync(marker)).toBe(false);
    } finally {
      checkpoint?.close();
      if (prior === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = prior;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an ancestor exchange after checkpoint construction", () => {
    const base = mkdtempSync(join(tmpdir(), "checkpoint-swap-"));
    const external = mkdtempSync(join(tmpdir(), "checkpoint-swap-external-"));
    const authorityRoot = join(base, "authority");
    const moved = join(base, "authority-old");
    mkdirSync(authorityRoot);
    const checkpoint = new FileSessionTreeCheckpoint(
      join(authorityRoot, "state"),
      MASTER_KEY,
    );
    renameSync(authorityRoot, moved);
    symlinkSync(external, authorityRoot);
    try {
      expect(() => checkpoint.reconcile(scope, emptyHeads)).toThrow(
        /changed|symlink|descriptor|authority/u,
      );
      expect(readdirSync(external)).toEqual([]);
    } finally {
      checkpoint.close();
      rmSync(base, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("rejects oversized checkpoint files before reading or decrypting", () => {
    const directory = mkdtempSync(join(tmpdir(), "checkpoint-ceiling-"));
    const checkpoint = new FileSessionTreeCheckpoint(directory, MASTER_KEY);
    const { filename } = checkpointMaterial();
    writeFileSync(join(directory, filename), "x".repeat(1_048_577));
    try {
      expect(() => checkpoint.reconcile(scope, emptyHeads)).toThrow(
        /checkpoint (byte limit|file metadata)/u,
      );
    } finally {
      checkpoint.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["group-readable", "multiple-links"] as const)(
    "rejects a checkpoint file with unsafe metadata: %s",
    (variant) => {
      const directory = mkdtempSync(join(tmpdir(), "checkpoint-metadata-"));
      const checkpoint = new FileSessionTreeCheckpoint(directory, MASTER_KEY);
      checkpoint.prepare(scope, {
        operation_id: "metadata-test",
        old_revision: 0,
        new_revision: 1,
        old_heads: emptyHeads,
        new_heads: emptyHeads,
      });
      const path = join(directory, checkpointMaterial().filename);
      if (variant === "group-readable") chmodSync(path, 0o640);
      else linkSync(path, join(directory, "second-link"));
      try {
        expect(() => checkpoint.reconcile(scope, emptyHeads)).toThrow(
          /mode|link|regular|owner|metadata/u,
        );
      } finally {
        checkpoint.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("fails closed on a FIFO checkpoint without blocking", () => {
    const directory = mkdtempSync(join(tmpdir(), "checkpoint-fifo-"));
    const fifo = join(directory, "fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const host = fileURLToPath(
      new URL("../../../session/secure-checkpoint-host.py", import.meta.url),
    );
    const stat = lstatSync(directory);
    const started = Date.now();
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "-E", host], {
      input: JSON.stringify({
        command: "read",
        directory,
        identity: { dev: stat.dev, ino: stat.ino },
        name: "fifo",
        max_bytes: 1024,
      }),
      encoding: "utf8",
      timeout: 3_000,
      env: { PATH: "/usr/bin:/bin" },
    });
    try {
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects authenticated checkpoint JSON with unknown or unsafe fields", () => {
    const invalidStates = [
      {
        version: 1,
        scope,
        committed: { revision: Number.MAX_SAFE_INTEGER + 1, heads: emptyHeads },
        pending: null,
      },
      {
        version: 1,
        scope,
        committed: { revision: 0, heads: { ...emptyHeads, extra: true } },
        pending: null,
        unknown: true,
      },
    ];
    for (const state of invalidStates) {
      const directory = mkdtempSync(join(tmpdir(), "checkpoint-schema-"));
      const checkpoint = new FileSessionTreeCheckpoint(directory, MASTER_KEY);
      const { filename } = checkpointMaterial();
      writeFileSync(join(directory, filename), encryptedCheckpoint(scope, state), {
        mode: 0o600,
      });
      try {
        expect(() => checkpoint.reconcile(scope, emptyHeads)).toThrow(
          "session tree checkpoint schema is malformed",
        );
      } finally {
        checkpoint.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("refuses to bind an unscoped or cross-tenant durable root", async () => {
    const directory = mkdtempSync(join(tmpdir(), "session-tree-scope-owner-"));
    const stateRoot = createTrustedSessionStateRoot(directory);
    const dbPath = join(directory, "session.db");
    const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
    store.createRun(scope.root_session_id, "victim root", "direct");
    const root = new DurableSession(scope.root_session_id, { persistence: store });
    root.acquireWriter("victim");
    root.append("user", { secret: "victim-only" });
    root.releaseWriter("victim");
    const authority = new SqliteSessionTreeAuthority(dbPath, {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
      security_resolver: new ControlledResolver(),
    });
    const attacker = {
      tenant_id: "attacker-tenant",
      root_session_id: scope.root_session_id,
    };
    try {
      expect(() =>
        authority.bindRoot(attacker, scope.root_session_id, rootSecurity),
      ).toThrowError(expect.objectContaining({ code: "AUTHORITY_VIOLATION" }));
      await expect(
        authority.readSessionHead(attacker, scope.root_session_id),
      ).resolves.toBeNull();
    } finally {
      authority.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("authenticates the database key before SessionTree schema writes", () => {
    const value = fixture();
    value.authority.close();
    value.store.close();
    const before = createHash("sha256").update(readFileSync(value.dbPath)).digest("hex");
    try {
      expect(
        () =>
          new SqliteSessionTreeAuthority(value.dbPath, {
            masterKey: Buffer.alloc(32, 0x7f),
            state_root: value.stateRoot,
            security_resolver: value.resolver,
          }),
      ).toThrow("session record key authentication failed");
      const after = createHash("sha256")
        .update(readFileSync(value.dbPath))
        .digest("hex");
      expect(after).toBe(before);
    } finally {
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it("opens an existing database read-only for wrong-key preflight with zero filesystem change", () => {
    const value = fixture();
    value.authority.close();
    value.store.close();
    const snapshot = () =>
      readdirSync(value.directory)
        .sort()
        .map((name) => {
          const path = join(value.directory, name);
          const stat = lstatSync(path);
          return {
            name,
            mode: stat.mode & 0o777,
            size: stat.size,
            hash: stat.isFile()
              ? createHash("sha256").update(readFileSync(path)).digest("hex")
              : null,
          };
        });
    const before = {
      directoryMode: lstatSync(value.directory).mode & 0o777,
      entries: snapshot(),
    };
    try {
      expect(
        () =>
          new SqliteSessionTreeAuthority(value.dbPath, {
            masterKey: Buffer.alloc(32, 0x7f),
            state_root: value.stateRoot,
            security_resolver: value.resolver,
          }),
      ).toThrow("session record key authentication failed");
      expect({
        directoryMode: lstatSync(value.directory).mode & 0o777,
        entries: snapshot(),
      }).toEqual(before);
    } finally {
      rmSync(value.directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects malformed identifiers and uses length-prefixed HMAC inputs", () => {
    const value = fixture();
    try {
      expect(() =>
        value.authority.bindRoot(
          { tenant_id: "bad\0tenant", root_session_id: scope.root_session_id },
          scope.root_session_id,
          rootSecurity,
        ),
      ).toThrow("tenant_id is malformed");
      const source = readFileSync(
        new URL("../../../session/sqlite-authority-internals.ts", import.meta.url),
        "utf8",
      );
      expect(source).toContain("encodeLengthPrefixedIdentifiers");
    } finally {
      value.close();
    }
  });

  it("documents the local sidecar rollback boundary without overstating protection", () => {
    const source = readFileSync(
      new URL("../../../session/session-tree-checkpoint.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "does not detect an OS-level rollback of both the database and this sidecar",
    );
    expect(source).toContain("external monotonic anchor");
  });

  it("binds checkpoint authentication to run_scopes ownership", async () => {
    const value = fixture();
    try {
      const database = new Database(value.dbPath);
      try {
        database
          .prepare("UPDATE run_scopes SET tenant_id = ? WHERE run_id = ?")
          .run("tampered-owner", scope.root_session_id);
      } finally {
        database.close();
      }
      await expect(
        value.authority.readSessionHead(scope, scope.root_session_id),
      ).rejects.toMatchObject({ code: "CORRUPT_LOG" });
    } finally {
      value.close();
    }
  }, 30_000);

  it("zeros the derived authority key when checkpoint construction fails", () => {
    const value = fixture();
    value.authority.close();
    value.store.close();
    const disposed: boolean[] = [];
    try {
      expect(
        () =>
          new SqliteSessionTreeAuthority(value.dbPath, {
            masterKey: MASTER_KEY,
            state_root: value.stateRoot,
            security_resolver: new ControlledResolver(),
            checkpoint: {
              reconcile: () => {
                throw new Error("injected checkpoint failure");
              },
              prepare: () => undefined,
              commit: () => undefined,
            },
            _test_on_record_key_disposed: (allZero: boolean) =>
              disposed.push(allZero),
          } as never),
      ).toThrow("injected checkpoint failure");
      expect(disposed).toEqual([true]);
    } finally {
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it.each(["missing-version", "malformed-v2"])(
    "rejects an existing %s SessionTree schema without repairing it",
    (variant) => {
      const directory = mkdtempSync(join(tmpdir(), "session-tree-bad-schema-"));
      const stateRoot = createTrustedSessionStateRoot(directory);
      const dbPath = join(directory, "session.db");
      const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
      store.close();
      const database = new Database(dbPath);
      try {
        database.exec(
          "CREATE TABLE session_tree_sessions (sentinel TEXT NOT NULL)",
        );
        if (variant === "malformed-v2") {
          database
            .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
            .run("session_tree_schema_version", "2");
        }
      } finally {
        database.close();
      }
      try {
        expect(
          () =>
            new SqliteSessionTreeAuthority(dbPath, {
              masterKey: MASTER_KEY,
              state_root: stateRoot,
              security_resolver: new ControlledResolver(),
            }),
        ).toThrow("session store schema is malformed");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("detects a database-only rollback instead of accepting truncated lineage", async () => {
    const value = fixture();
    const oldDatabase = join(value.directory, "old.db");
    const inspector = new Database(value.dbPath);
    await inspector.backup(oldDatabase);
    inspector.close();
    await new SessionTree(scope, value.authority).branch({
      command_id: "rollback-child-command",
      source_session_id: scope.root_session_id,
      child_session_id: "rollback-child",
    });
    value.authority.close();
    value.store.close();
    copyFileSync(oldDatabase, value.dbPath);
    let restarted: SqliteSessionTreeAuthority | undefined;
    try {
      expect(
        () => {
          restarted = new SqliteSessionTreeAuthority(value.dbPath, {
            masterKey: MASTER_KEY,
            state_root: value.stateRoot,
            security_resolver: value.resolver,
          });
        },
      ).toThrowError(expect.objectContaining({ code: "CORRUPT_LOG" }));
    } finally {
      restarted?.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("persists every security anchor as AEAD bound to tenant, root, and logical session", async () => {
    const value = fixture();
    try {
      await new SessionTree(scope, value.authority).branch({
        command_id: "security-aead-child",
        source_session_id: scope.root_session_id,
        child_session_id: "security-child",
      });
      const database = new Database(value.dbPath);
      try {
        const rows = database
          .prepare(
            "SELECT session_id, security_json FROM session_tree_sessions ORDER BY session_id",
          )
          .all() as Array<{ session_id: string; security_json: string }>;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(hasSessionEncryptionEnvelope(row.security_json)).toBe(true);
          expect(row.security_json).not.toContain(rootSecurity.state_hash);
          expect(row.security_json).not.toContain(rootSecurity.capability_ceiling_hash);
        }
        const command = database
          .prepare("SELECT fingerprint FROM session_tree_commands")
          .get() as { fingerprint: string };
        expect(command.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(command.fingerprint).not.toContain(rootSecurity.state_hash);
        expect(command.fingerprint).not.toContain(
          rootSecurity.capability_ceiling_hash,
        );
        const [first, second] = rows;
        database
          .prepare("UPDATE session_tree_sessions SET security_json = ? WHERE session_id = ?")
          .run(second!.security_json, first!.session_id);
        database
          .prepare("UPDATE session_tree_sessions SET security_json = ? WHERE session_id = ?")
          .run(first!.security_json, second!.session_id);
      } finally {
        database.close();
      }
      await expect(
        value.authority.readSessionHead(scope, scope.root_session_id),
      ).rejects.toMatchObject({ code: "CORRUPT_LOG" });
      await expect(
        value.authority.readSessionHead(scope, "security-child"),
      ).rejects.toMatchObject({ code: "CORRUPT_LOG" });
    } finally {
      value.close();
    }
  }, 15_000);

  it("rejects authenticated-envelope tampering even when its format remains valid", async () => {
    const value = fixture();
    try {
      const database = new Database(value.dbPath);
      try {
        const row = database
          .prepare("SELECT security_json FROM session_tree_sessions WHERE session_id = ?")
          .get(scope.root_session_id) as { security_json: string };
        const tampered = mutateEnvelope(row.security_json);
        expect(hasSessionEncryptionEnvelope(tampered)).toBe(true);
        database
          .prepare("UPDATE session_tree_sessions SET security_json = ? WHERE session_id = ?")
          .run(tampered, scope.root_session_id);
      } finally {
        database.close();
      }
      await expect(
        value.authority.readSessionHead(scope, scope.root_session_id),
      ).rejects.toMatchObject({ code: "CORRUPT_LOG" });
    } finally {
      value.close();
    }
  });

  it("normalizes a plaintext security row to the typed corrupt-log boundary", async () => {
    const value = fixture();
    try {
      const database = new Database(value.dbPath);
      try {
        database
          .prepare(
            "UPDATE session_tree_sessions SET security_json = ? WHERE session_id = ?",
          )
          .run(JSON.stringify(rootSecurity), scope.root_session_id);
      } finally {
        database.close();
      }
      await expect(
        value.authority.readSessionHead(scope, scope.root_session_id),
      ).rejects.toMatchObject({
        name: "SessionTreeAuthorityFault",
        code: "CORRUPT_LOG",
        message: "persisted security state is malformed",
      });
    } finally {
      value.close();
    }
  });

  it("rejects epoch rollback and capability-ceiling expansion independently", async () => {
    const value = fixture();
    try {
      value.resolver.result = {
        ...rootSecurity,
        authorization_epoch: rootSecurity.authorization_epoch - 1,
      };
      value.resolver.allow = true;
      await expect(
        value.authority.readSessionHead(scope, scope.root_session_id),
      ).rejects.toMatchObject({ code: "AUTHORITY_VIOLATION" });

      value.resolver.result = null;
      value.resolver.allow = true;
      value.resolver.mutatePersisted = true;
      await expect(
        value.authority.readSessionHead(scope, scope.root_session_id),
      ).rejects.toMatchObject({
        code: "AUTHORITY_VIOLATION",
        message: "security resolver violated its authority",
      });

      value.resolver.result = {
        ...rootSecurity,
        capability_ceiling_hash: "3".repeat(64),
      };
      value.resolver.mutatePersisted = false;
      value.resolver.allow = false;
      await expect(
        value.authority.readSessionHead(scope, scope.root_session_id),
      ).rejects.toMatchObject({ code: "AUTHORITY_VIOLATION" });
    } finally {
      value.close();
    }
  }, 15_000);

  it("refuses schema-v1 databases containing legacy plaintext security anchors", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-tree-legacy-"));
    const stateRoot = createTrustedSessionStateRoot(directory);
    const dbPath = join(directory, "session.db");
    const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
    store.createRun(scope.root_session_id, "legacy", "direct");
    store.close();
    const database = new Database(dbPath);
    try {
      database.exec(`
        CREATE TABLE session_tree_scopes (
          tenant_id TEXT NOT NULL, root_session_id TEXT NOT NULL,
          tree_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id), created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, root_session_id)
        );
        CREATE TABLE session_tree_sessions (
          tenant_id TEXT NOT NULL, root_session_id TEXT NOT NULL, session_id TEXT NOT NULL,
          storage_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id), parent_session_id TEXT,
          depth INTEGER NOT NULL, security_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, root_session_id, session_id)
        );
        CREATE TABLE session_tree_commands (
          tenant_id TEXT NOT NULL, root_session_id TEXT NOT NULL, command_id TEXT NOT NULL,
          child_session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, event_seq INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, root_session_id, command_id)
        );
      `);
      database
        .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
        .run("session_tree_schema_version", "1");
      database
        .prepare("INSERT INTO session_tree_scopes VALUES (?, ?, ?, ?)")
        .run(scope.tenant_id, scope.root_session_id, scope.root_session_id, new Date().toISOString());
      database
        .prepare("INSERT INTO session_tree_sessions VALUES (?, ?, ?, ?, NULL, 0, ?, ?)")
        .run(
          scope.tenant_id,
          scope.root_session_id,
          scope.root_session_id,
          scope.root_session_id,
          JSON.stringify(rootSecurity),
          new Date().toISOString(),
        );
    } finally {
      database.close();
    }
    try {
      expect(
        () =>
          new SqliteSessionTreeAuthority(dbPath, {
            masterKey: MASTER_KEY,
            state_root: stateRoot,
            security_resolver: new ControlledResolver(),
          }),
      ).toThrow("session store schema is malformed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses legacy session-tree rows when the schema version is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-tree-versionless-"));
    const stateRoot = createTrustedSessionStateRoot(directory);
    const dbPath = join(directory, "session.db");
    const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
    store.close();
    const database = new Database(dbPath);
    try {
      database.exec(
        "CREATE TABLE session_tree_sessions (sentinel TEXT NOT NULL); INSERT INTO session_tree_sessions VALUES ('legacy-plaintext');",
      );
    } finally {
      database.close();
    }
    try {
      expect(
        () =>
          new SqliteSessionTreeAuthority(dbPath, {
            masterKey: MASTER_KEY,
            state_root: stateRoot,
            security_resolver: new ControlledResolver(),
          }),
      ).toThrow("session store schema is malformed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
