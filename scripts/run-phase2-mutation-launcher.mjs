#!/usr/bin/env node

// Local convenience launcher only. It executes committed bootstrap bytes, but
// cannot attest the working launcher itself; formal Evidence comes from the
// exact-SHA CI workflow or another external attestor.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.cwd());
const temporary = mkdtempSync(join(tmpdir(), "phase2-committed-launcher-"));
chmodSync(temporary, 0o700);
const bootstrapPath = join(temporary, "run-phase2-mutation-bootstrap.mjs");
let extractedToRemove = null;
const gitEnv = {
  HOME: temporary,
  XDG_CONFIG_HOME: temporary,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  LANG: "C",
  LC_ALL: "C",
};
const safeWrite = (stream, value) => {
  try {
    stream.write(value);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPIPE"))
      throw error;
  }
};
for (const stream of [process.stdout, process.stderr]) stream.on("error", (error) => {
  if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) process.exitCode = 1;
});

try {
  const head = spawnSync(
    "/usr/bin/git",
    ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: root, encoding: "utf8", env: gitEnv, shell: false },
  );
  if (head.status !== 0 || head.error) throw head.error ?? new Error("cannot resolve HEAD");
  const headSha = head.stdout.trim();
  const attestedSha = process.env.PHASE2_MUTATION_ATTESTED_SHA ?? headSha;
  if (!/^[a-f0-9]{40}$/u.test(attestedSha) || attestedSha !== headSha)
    throw new Error("PHASE2_MUTATION_ATTESTED_SHA must equal HEAD^{commit}");
  const committed = spawnSync(
    "/usr/bin/git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "cat-file",
      "blob",
      `${attestedSha}:scripts/run-phase2-mutation-bootstrap.mjs`,
    ],
    { cwd: root, encoding: "buffer", env: gitEnv, shell: false },
  );
  if (committed.error) throw committed.error;
  if (committed.status !== 0) {
    throw new Error(
      `cannot load committed Phase 2 bootstrap: ${String(committed.stderr).trim()}`,
    );
  }
  const extracted = process.env.PHASE2_MUTATION_EXTRACTED_BOOTSTRAP;
  const executableBootstrap =
    typeof extracted === "string" && existsSync(extracted)
      ? extracted
      : bootstrapPath;
  if (executableBootstrap === extracted) {
    if (!readFileSync(executableBootstrap).equals(committed.stdout))
      throw new Error("extracted bootstrap differs from attested SHA blob");
    extractedToRemove = executableBootstrap;
  } else {
    writeFileSync(bootstrapPath, committed.stdout, { mode: 0o400 });
    chmodSync(bootstrapPath, 0o400);
  }
  const child = spawnSync(process.execPath, ["--", executableBootstrap, ...process.argv.slice(2)], {
    cwd: root,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      PHASE2_MUTATION_ATTESTED_SHA: attestedSha,
    },
    encoding: "utf8",
    shell: false,
    timeout: 24 * 60 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  safeWrite(process.stdout, child.stdout ?? "");
  safeWrite(process.stderr, child.stderr ?? "");
  process.exitCode = child.status ?? 1;
} catch (error) {
  process.stderr.write(
    `Phase 2 committed launcher FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (extractedToRemove !== null) rmSync(extractedToRemove, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
