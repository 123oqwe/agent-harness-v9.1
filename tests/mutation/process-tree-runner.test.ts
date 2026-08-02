import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const harnessRoot = resolve(import.meta.dirname, "..", "..");
const helperPath = join(harnessRoot, "scripts", "run-process-tree.mjs");
const parentFixture = join(
  harnessRoot,
  "tests",
  "mutation",
  "fixtures",
  "process-tree-parent.mjs",
);
const orphaningParentFixture = join(
  harnessRoot,
  "tests",
  "mutation",
  "fixtures",
  "process-tree-orphaning-parent.mjs",
);
const successFixture = join(
  harnessRoot,
  "tests",
  "mutation",
  "fixtures",
  "process-tree-success.mjs",
);
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ah-process-tree-test-"));
  temporaryRoots.push(root);
  return root;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return !processIsAlive(pid);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    for (const name of ["parent.pid", "grandchild.pid"]) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (!processIsAlive(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
});

describe("bounded mutation process trees", () => {
  it("kills a TERM-resistant parent and stdio-holding grandchild without accepting a partial report", async () => {
    expect(existsSync(helperPath)).toBe(true);
    const [{ runProcessTree }, { runMutationChunkCommand }] = await Promise.all(
      [
        import(
          // @ts-expect-error The process-tree helper is intentionally plain ESM.
          "../../scripts/run-process-tree.mjs"
        ),
        import(
          // @ts-expect-error The mutation runner is intentionally plain ESM.
          "../../scripts/run-mutation.mjs"
        ),
      ],
    );
    expect(runProcessTree).toBeTypeOf("function");
    expect(runMutationChunkCommand).toBeTypeOf("function");

    const stateDirectory = temporaryRoot();
    const timeoutMs = 1_500;
    const terminationGraceMs = 100;
    const killWaitMs = 500;
    const markerDelayMs = 3_000;
    const startedAt = Date.now();

    await expect(
      runMutationChunkCommand({
        executable: process.execPath,
        args: [parentFixture, stateDirectory, String(markerDelayMs)],
        cwd: harnessRoot,
        env: process.env,
        timeoutMs,
        terminationGraceMs,
        killWaitMs,
        moduleName: "fixture",
        chunkId: "parent-grandchild",
        reportPath: join(stateDirectory, "partial-report.json"),
      }),
    ).rejects.toThrow(/timed out.*no report is accepted/iu);

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(
      timeoutMs + terminationGraceMs + killWaitMs + 1_500,
    );
    expect(existsSync(join(stateDirectory, "partial-report.json"))).toBe(true);

    const parentPid = Number.parseInt(
      readFileSync(join(stateDirectory, "parent.pid"), "utf8"),
      10,
    );
    const grandchildPid = Number.parseInt(
      readFileSync(join(stateDirectory, "grandchild.pid"), "utf8"),
      10,
    );
    expect(await waitForDead(parentPid, killWaitMs)).toBe(true);
    expect(await waitForDead(grandchildPid, killWaitMs)).toBe(true);

    const markerDeadline = startedAt + markerDelayMs + 200;
    if (Date.now() < markerDeadline) {
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, markerDeadline - Date.now()),
      );
    }
    expect(existsSync(join(stateDirectory, "late-marker"))).toBe(false);
  }, 8_000);

  it("fails closed before spawning a mutation tree on Windows", async () => {
    expect(existsSync(helperPath)).toBe(true);
    const { assertProcessTreePlatform } = await import(
      // @ts-expect-error The process-tree helper is intentionally plain ESM.
      "../../scripts/run-process-tree.mjs"
    );
    expect(() => assertProcessTreePlatform("win32")).toThrow(
      /process-tree termination is unsupported on win32/iu,
    );
  });

  it("kills the complete process group when a mutation chunk is aborted", async () => {
    expect(existsSync(helperPath)).toBe(true);
    const { runMutationChunkCommand } = await import(
      // @ts-expect-error The mutation runner is intentionally plain ESM.
      "../../scripts/run-mutation.mjs"
    );
    const stateDirectory = temporaryRoot();
    const controller = new AbortController();
    const abortAfterMs = 600;
    const terminationGraceMs = 100;
    const killWaitMs = 500;
    const markerDelayMs = 1_600;
    const startedAt = Date.now();
    const abortTimer = setTimeout(() => controller.abort(), abortAfterMs);

    try {
      await expect(
        runMutationChunkCommand({
          executable: process.execPath,
          args: [parentFixture, stateDirectory, String(markerDelayMs)],
          cwd: harnessRoot,
          env: process.env,
          timeoutMs: 10_000,
          terminationGraceMs,
          killWaitMs,
          signal: controller.signal,
          moduleName: "fixture",
          chunkId: "aborted-parent-grandchild",
          reportPath: join(stateDirectory, "partial-report.json"),
        }),
      ).rejects.toThrow(/aborted.*no report is accepted/iu);
    } finally {
      clearTimeout(abortTimer);
    }

    expect(Date.now() - startedAt).toBeLessThan(
      abortAfterMs + terminationGraceMs + killWaitMs + 500,
    );
    for (const name of ["parent.pid", "grandchild.pid"]) {
      const pid = Number.parseInt(
        readFileSync(join(stateDirectory, name), "utf8"),
        10,
      );
      expect(await waitForDead(pid, killWaitMs)).toBe(true);
    }
    const markerDeadline = startedAt + markerDelayMs + 200;
    if (Date.now() < markerDeadline) {
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, markerDeadline - Date.now()),
      );
    }
    expect(existsSync(join(stateDirectory, "late-marker"))).toBe(false);
  }, 5_000);

  it("fails and cleans up when a zero-exit parent leaves a grandchild behind", async () => {
    expect(existsSync(helperPath)).toBe(true);
    const { runMutationChunkCommand } = await import(
      // @ts-expect-error The mutation runner is intentionally plain ESM.
      "../../scripts/run-mutation.mjs"
    );
    const stateDirectory = temporaryRoot();
    const normalExitGraceMs = 100;
    const terminationGraceMs = 100;
    const killWaitMs = 500;
    const markerDelayMs = 1_200;
    const startedAt = Date.now();

    await expect(
      runMutationChunkCommand({
        executable: process.execPath,
        args: [orphaningParentFixture, stateDirectory, String(markerDelayMs)],
        cwd: harnessRoot,
        env: process.env,
        timeoutMs: 10_000,
        normalExitGraceMs,
        terminationGraceMs,
        killWaitMs,
        moduleName: "fixture",
        chunkId: "zero-exit-with-orphan",
        reportPath: join(stateDirectory, "partial-report.json"),
      }),
    ).rejects.toThrow(/left descendant processes.*no report is accepted/iu);

    expect(Date.now() - startedAt).toBeLessThan(
      normalExitGraceMs + terminationGraceMs + killWaitMs + 2_000,
    );
    const grandchildPid = Number.parseInt(
      readFileSync(join(stateDirectory, "grandchild.pid"), "utf8"),
      10,
    );
    expect(await waitForDead(grandchildPid, killWaitMs)).toBe(true);
    const markerDeadline = startedAt + markerDelayMs + 200;
    if (Date.now() < markerDeadline) {
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, markerDeadline - Date.now()),
      );
    }
    expect(existsSync(join(stateDirectory, "late-marker"))).toBe(false);
  }, 8_000);

  it("accepts a zero-exit process only when its process group is gone", async () => {
    expect(existsSync(helperPath)).toBe(true);
    const { runMutationChunkCommand } = await import(
      // @ts-expect-error The mutation runner is intentionally plain ESM.
      "../../scripts/run-mutation.mjs"
    );
    const stateDirectory = temporaryRoot();
    const reportPath = join(stateDirectory, "complete-report.json");

    await expect(
      runMutationChunkCommand({
        executable: process.execPath,
        args: [successFixture, reportPath],
        cwd: harnessRoot,
        env: process.env,
        timeoutMs: 2_000,
        normalExitGraceMs: 100,
        terminationGraceMs: 100,
        killWaitMs: 500,
        moduleName: "fixture",
        chunkId: "no-descendants",
        reportPath,
      }),
    ).resolves.toEqual({ schemaVersion: "1.0", files: {} });
  });
});
