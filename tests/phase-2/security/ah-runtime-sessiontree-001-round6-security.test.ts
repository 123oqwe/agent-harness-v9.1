import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  preflightExistingSessionDatabase,
  SqliteSessionStore,
} from "../../../session/sqlite-session-store.js";
import {
  createTrustedSessionStateRoot,
  SESSION_STORAGE_TRUST_BOUNDARY,
} from "../../../session/session-state-root.js";
import {
  launchTestOnlyPythonHost,
  launchTrustedPythonHost,
} from "../../../session/trusted-python-host.js";
import { SqliteSessionTreeAuthority } from "../../../session/sqlite-session-tree-authority.js";
import { FileSessionTreeCheckpoint } from "../../../session/session-tree-checkpoint.js";

const MASTER_KEY = Buffer.alloc(32, 0x71);

function stateRoot(path: string) {
  return createTrustedSessionStateRoot(path);
}

function hostFixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "session-host-round6-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "host.py");
  writeFileSync(path, source, { mode: 0o600 });
  return {
    directory,
    path,
    sha256: createHash("sha256").update(source).digest("hex"),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function launchHost(host: ReturnType<typeof hostFixture>, timeoutMs = 300) {
  return launchTestOnlyPythonHost({
    host: pathToFileURL(host.path),
    hostSha256: host.sha256,
    request: { action: "probe" },
    requestKeys: ["action"],
    responseKeys: ["ok", "value"],
    timeoutMs,
    maxOutputBytes: 1024,
  });
}

describe("AH-RUNTIME-SESSIONTREE-001 round-6 security boundary", () => {
  it("requires a dedicated trusted state root and rejects workspace paths", () => {
    const state = mkdtempSync(join(tmpdir(), "session-state-root-"));
    const workspace = mkdtempSync(join(tmpdir(), "session-workspace-"));
    chmodSync(state, 0o700);
    try {
      expect(() => new SqliteSessionStore(join(workspace, "missing-root.db"), {
        masterKey: MASTER_KEY,
      } as never)).toThrow(/state root/u);
      expect(() => new SqliteSessionStore(join(workspace, "outside-root.db"), {
        masterKey: MASTER_KEY,
        state_root: stateRoot(state),
      } as never)).toThrow(/state root|outside/u);
      expect(readdirSync(workspace)).toEqual([]);
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("creates no database through a symlinked directory beneath the state root", () => {
    const state = mkdtempSync(join(tmpdir(), "session-state-link-root-"));
    const external = mkdtempSync(join(tmpdir(), "session-state-link-external-"));
    chmodSync(state, 0o700);
    chmodSync(external, 0o700);
    symlinkSync(external, join(state, "linked"));
    try {
      expect(() => new SqliteSessionStore(join(state, "linked", "session.db"), {
        masterKey: MASTER_KEY,
        state_root: stateRoot(state),
      } as never)).toThrow(/symlink|state root|descriptor/u);
      expect(readdirSync(external)).toEqual([]);
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("returns parent and main identities from read-only preflight", () => {
    const state = mkdtempSync(join(tmpdir(), "session-preflight-identity-"));
    chmodSync(state, 0o700);
    const dbPath = join(state, "session.db");
    const legacy = new SqliteSessionStore(dbPath, {
      masterKey: MASTER_KEY,
      state_root: stateRoot(state),
    });
    legacy.close();
    try {
      const preflight = preflightExistingSessionDatabase as unknown as (
        path: string,
        key: Uint8Array,
        root: ReturnType<typeof stateRoot>,
      ) => { parent_identity: { dev: number; ino: number }; main_identity: { dev: number; ino: number } };
      expect(preflight(dbPath, MASTER_KEY, stateRoot(state))).toMatchObject({
        parent_identity: { dev: expect.any(Number), ino: expect.any(Number) },
        main_identity: { dev: expect.any(Number), ino: expect.any(Number) },
      });
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("zeros the store record key on every post-derivation constructor failure", () => {
    const state = mkdtempSync(join(tmpdir(), "session-store-key-zero-"));
    chmodSync(state, 0o700);
    const dbPath = join(state, "session.db");
    const root = stateRoot(state);
    const first = new SqliteSessionStore(dbPath, {
      masterKey: MASTER_KEY,
      state_root: root,
    });
    first.close();
    const disposed: boolean[] = [];
    try {
      expect(() => new SqliteSessionStore(dbPath, {
        masterKey: MASTER_KEY,
        state_root: root,
        _test_after_record_key_derived: () => {
          throw new Error("injected post-derive failure");
        },
        _test_on_record_key_disposed: (allZero: boolean) => disposed.push(allZero),
      } as never)).toThrow("injected post-derive failure");
      expect(disposed).toEqual([true]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("does not expose the generic arbitrary-host launcher as a production authority", () => {
    const host = hostFixture("import json\nprint(json.dumps({'ok': True, 'value': 1}))\n");
    try {
      expect(() => (launchTrustedPythonHost as unknown as (value: unknown) => unknown)({
        host: pathToFileURL(host.path),
        hostSha256: host.sha256,
      })).toThrow(/fixed asset|test-only|production|unknown/u);
    } finally {
      host.close();
    }
  });

  it("rejects a host asset beneath a group-writable ancestor", () => {
    const host = hostFixture("import json\nprint(json.dumps({'ok': True, 'value': 1}))\n");
    chmodSync(host.directory, 0o770);
    try {
      expect(() => launchHost(host)).toThrow(/ancestor|metadata|unsafe/u);
    } finally {
      host.close();
    }
  });

  it("does not let a host escape cleanup with a new session", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-host-escape-"));
    const marker = join(directory, "escaped");
    const code = `import time\ntime.sleep(1)\nopen(${JSON.stringify(marker)}, 'w').write('escaped')\n`;
    const host = hostFixture([
      "import subprocess, time",
      `subprocess.Popen(['/usr/bin/python3', '-I', '-B', '-E', '-c', ${JSON.stringify(code)}], start_new_session=True)`,
      "time.sleep(10)",
      "",
    ].join("\n"));
    try {
      expect(() => launchHost(host, 250)).toThrow(/timed out|execution failed/iu);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_300);
      expect(existsSync(marker)).toBe(false);
    } finally {
      host.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("kills host descendants when the outer supervisor is stopped", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-host-stopped-supervisor-"));
    const marker = join(directory, "escaped");
    const code = `import time\ntime.sleep(1)\nopen(${JSON.stringify(marker)}, 'w').write('escaped')\n`;
    const host = hostFixture([
      "import os, signal, subprocess, time",
      "os.kill(os.getppid(), signal.SIGSTOP)",
      `subprocess.Popen(['/usr/bin/python3', '-I', '-B', '-E', '-c', ${JSON.stringify(code)}], start_new_session=True)`,
      "time.sleep(10)",
      "",
    ].join("\n"));
    try {
      expect(() => launchHost(host, 250)).toThrow(/timed out|execution failed/iu);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_300);
      expect(existsSync(marker)).toBe(false);
    } finally {
      host.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("documents immutable-byte execution, fixed-query recovery, and the honest same-UID boundary", () => {
    const hostSource = requireSource("../../../session/trusted-python-host.ts");
    const treeSource = requireSource("../../../session/sqlite-session-tree-authority.ts");
    expect(hostSource).toContain("verified_host_b64");
    expect(hostSource).not.toContain("open('/dev/fd/4'");
    expect(treeSource).not.toContain("for (const row of rows)");
    expect(treeSource).toContain("checkpoint.transition");
    expect(SESSION_STORAGE_TRUST_BOUNDARY).toMatchObject({
      same_uid_swap_resistance: "not_guaranteed",
      phase2_deployment_blocker: "AH-SANDBOX-OCI-001",
      complete_resistance_requires: expect.arrayContaining([
        "container",
        "descriptor_capable_sqlite_broker",
      ]),
    });
  });

  it("keeps cold, warm, wrong-key, and authority restart p95 below five seconds", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-restart-latency-"));
    const dbPath = join(directory, "session.db");
    const root = stateRoot(directory);
    const scope = { tenant_id: "latency-tenant", root_session_id: "latency-root" };
    const security = {
      state_hash: "1".repeat(64),
      capability_ceiling_hash: "2".repeat(64),
      authorization_epoch: 1,
    };
    const resolver = {
      resolve: (_scope: typeof scope, _session: string, persisted: typeof security) => persisted,
      isNoBroaderThan: (candidate: typeof security, ceiling: typeof security) =>
        JSON.stringify(candidate) === JSON.stringify(ceiling),
    };
    const elapsed = (operation: () => void) => {
      const started = performance.now();
      operation();
      return performance.now() - started;
    };
    const p95 = (values: readonly number[]) =>
      [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!;
    try {
      let initial: SqliteSessionStore | undefined;
      const cold = elapsed(() => {
        initial = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: root });
      });
      initial!.createScopedRun(scope, scope.root_session_id, "latency", "direct");
      initial!.close();
      const warm = Array.from({ length: 5 }, () => elapsed(() => {
        const value = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: root });
        value.close();
      }));
      const wrongKey = Array.from({ length: 5 }, () => elapsed(() => {
        expect(() => new SqliteSessionStore(dbPath, {
          masterKey: Buffer.alloc(32, 0x72),
          state_root: root,
        })).toThrow("session record key authentication failed");
      }));
      const authority = new SqliteSessionTreeAuthority(dbPath, {
        masterKey: MASTER_KEY,
        state_root: root,
        security_resolver: resolver,
      });
      authority.bindRoot(scope, scope.root_session_id, security);
      authority.close();
      const restart = Array.from({ length: 5 }, () => elapsed(() => {
        const value = new SqliteSessionTreeAuthority(dbPath, {
          masterKey: MASTER_KEY,
          state_root: root,
          security_resolver: resolver,
        });
        value.close();
      }));
      const report = {
        cold_ms: cold,
        warm_p50_ms: [...warm].sort((a, b) => a - b)[2],
        warm_p95_ms: p95(warm),
        wrong_key_p50_ms: [...wrongKey].sort((a, b) => a - b)[2],
        wrong_key_p95_ms: p95(wrongKey),
        authority_restart_p50_ms: [...restart].sort((a, b) => a - b)[2],
        authority_restart_p95_ms: p95(restart),
      };
      if (process.env.AH_REPORT_SESSION_PERF === "1") console.info(JSON.stringify(report));
      expect(Math.max(cold, p95(warm), p95(wrongKey), p95(restart))).toBeLessThan(5_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps fixed production hosts incapable of spawning descendant processes", () => {
    for (const source of [
      requireSource("../../../session/secure-checkpoint-host.py"),
      requireSource("../../../session/secure-sqlite-preflight.py"),
    ]) {
      expect(source).not.toMatch(
        /\b(?:subprocess|multiprocessing|os\.fork|os\.posix_spawn|os\.system)\b/u,
      );
    }
  });

  it("keeps warm protected checkpoint operations below 250 milliseconds p95", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-checkpoint-warm-latency-"));
    const checkpoint = new FileSessionTreeCheckpoint(directory, MASTER_KEY);
    const empty = createHash("sha256").update("empty").digest("hex");
    const heads = {
      version: 1 as const,
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
    try {
      checkpoint.reconcile({ tenant_id: "perf", root_session_id: "root" }, heads);
      const samples = Array.from({ length: 10 }, () => {
        const started = performance.now();
        checkpoint.reconcile({ tenant_id: "perf", root_session_id: "root" }, heads);
        return performance.now() - started;
      }).sort((left, right) => left - right);
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
      if (process.env.AH_REPORT_SESSION_PERF === "1") {
        console.info(JSON.stringify({ checkpoint_warm_p95_ms: p95 }));
      }
      // macOS' protected /usr/bin/python3 has a measured ~90 ms empty-process
      // floor. This ceiling still prevents the former two-process supervisor
      // path (roughly 570 ms p95) from returning unnoticed.
      expect(p95).toBeLessThan(250);
    } finally {
      checkpoint.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function requireSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
