import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeGateCommands,
  runCommand,
  writeAtomicGateReport,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/run-command.mjs";
import {
  collectGateBindings,
  phase2CommandGraph,
  publishPhase2Evidence,
  verifyEvidenceBundle,
  verifyPhase2,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/verify-phase2-local.mjs";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const bindingValue = {
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  packageLockSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
  mutationConfigSha256: "e".repeat(64),
  assetsSha256: "f".repeat(64),
  runnerSha256: "1".repeat(64),
  runnerVersion: "phase2-gate-report/v1",
};

const git = (root: string, ...args: string[]) => {
  const result = spawnSync("git", args, {
    cwd: root,
    shell: false,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

const createCompletePhase2Repository = () => {
  const root = mkdtempSync(join(tmpdir(), "phase2-evidence-generation-"));
  const manifestPath = "verification/gates/phase2-gate.json";
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, manifestPath), "utf8"),
  );
  mkdirSync(join(root, dirname(manifestPath)), { recursive: true });
  cpSync(join(repositoryRoot, manifestPath), join(root, manifestPath));
  const helperPath = "scripts/gates/secure-publish.py";
  mkdirSync(join(root, dirname(helperPath)), { recursive: true });
  cpSync(join(repositoryRoot, helperPath), join(root, helperPath));
  for (const requirement of manifest.requirements) {
    const source = join(
      root,
      requirement.owner,
      "src",
      `${requirement.id.toLowerCase()}.ts`,
    );
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(
      source,
      `export const requirementId = ${JSON.stringify(requirement.id)};\n`,
    );
  }
  for (const requirement of manifest.requirements) {
    for (const suite of requirement.test_suites) {
      const path = join(root, suite);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "export {};\n");
    }
  }
  writeFileSync(join(root, ".gitignore"), "reports/\n");
  git(root, "init");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Phase2 Test",
    "-c",
    "user.email=phase2@example.invalid",
    "commit",
    "-m",
    "complete Phase 2 fixture",
  );
  return { root, manifest };
};

const createSecurePublicationRepository = () => {
  const root = mkdtempSync(join(tmpdir(), "phase2-secure-publication-"));
  const helperPath = "scripts/gates/secure-publish.py";
  mkdirSync(join(root, dirname(helperPath)), { recursive: true });
  cpSync(join(repositoryRoot, helperPath), join(root, helperPath));
  git(root, "init");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Phase2 Test",
    "-c",
    "user.email=phase2@example.invalid",
    "commit",
    "-m",
    "secure publication authority",
  );
  return root;
};

const helperAuthority = (root: string) => ({
  repositoryRoot: root,
  treeSha: git(root, "rev-parse", "HEAD^{tree}"),
});

const passedRunner = async (command: {
  id: string;
  command: string;
  args: string[];
}) => ({
  id: command.id,
  argv: [command.command, ...command.args],
  status: "passed",
  exitCode: 0,
  signal: null,
  durationMs: 1,
  stdout: {
    bytes: 0,
    capturedBytes: 0,
    truncated: false,
    sha256: sha256(""),
  },
  stderr: {
    bytes: 0,
    capturedBytes: 0,
    truncated: false,
    sha256: sha256(""),
  },
  error: null,
});

const stableIdentity = () => ({
  errors: [],
  dirty: false,
  bindings: structuredClone(bindingValue),
});

const fixtureBindings = (root: string) => ({
  ...structuredClone(bindingValue),
  commitSha: git(root, "rev-parse", "HEAD"),
  treeSha: git(root, "rev-parse", "HEAD^{tree}"),
});

const expectedArgv = (command: { command: string; args: string[] }) => [
  command.command,
  ...command.args.map((argument) => `<arg-sha256:${sha256(argument)}>`),
];

const syntheticPassedResults = (root: string) =>
  phase2CommandGraph(root, "local").map(
    (command: { id: string; command: string; args: string[] }) => ({
      id: command.id,
      argv: expectedArgv(command),
      status: "passed",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: {
        bytes: 0,
        capturedBytes: 0,
        truncated: false,
        sha256: sha256(""),
      },
      stderr: {
        bytes: 0,
        capturedBytes: 0,
        truncated: false,
        sha256: sha256(""),
      },
      error: null,
    }),
  );

describe("Phase 2 gate command orchestration", () => {
  it("binds both descriptor-relative helpers into the release runner identity", async () => {
    const gateModule = await import(
      // @ts-expect-error The production gate intentionally ships as plain Node ESM.
      "../../../scripts/gates/verify-phase2-local.mjs"
    );
    expect(gateModule.RUNNER_BINDING_PATHS).toEqual(
      expect.arrayContaining([
        "scripts/gates/secure-publish.mjs",
        "scripts/gates/secure-publish.py",
      ]),
    );
    const identity = collectGateBindings(repositoryRoot);
    expect(identity.bindings.runnerFiles).toBe(
      gateModule.RUNNER_BINDING_PATHS.length,
    );
    expect(identity.bindings.runnerSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("runs argv commands in order and fails fast without shell strings", async () => {
    const visited: string[] = [];
    const commands = ["manifest", "assets", "unit"].map((id) => ({
      id,
      command: process.execPath,
      args: ["--version"],
    }));

    const result = await executeGateCommands(commands, {
      runner: async (command: {
        id: string;
        command: string;
        args: string[];
      }) => {
        visited.push(command.id);
        return {
          id: command.id,
          argv: [command.command, ...command.args],
          status: command.id === "assets" ? "failed" : "passed",
          exitCode: command.id === "assets" ? 1 : 0,
          signal: null,
          durationMs: 1,
          stdout: {
            bytes: 0,
            capturedBytes: 0,
            truncated: false,
            sha256: sha256(""),
          },
          stderr: {
            bytes: 0,
            capturedBytes: 0,
            truncated: false,
            sha256: sha256(""),
          },
          error: null,
        };
      },
    });

    expect(visited).toEqual(["manifest", "assets"]);
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(commands.every((command) => Array.isArray(command.args))).toBe(true);
  });

  it("rejects forged result identity, argv, hashes, duplicate commands, and reordered identities", async () => {
    const commands = ["first", "second"].map((id) => ({
      id,
      command: process.execPath,
      args: ["--version"],
    }));
    const forged = await executeGateCommands(commands, {
      runner: async (command: { id: string }) => ({
        id: command.id === "first" ? "second" : "first",
        argv: ["forged"],
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: { sha256: "not-a-hash" },
        stderr: { sha256: "also-not-a-hash" },
      }),
    });
    expect(forged.ok).toBe(false);
    expect(forged.results[0]).toMatchObject({
      id: "first",
      argv: expectedArgv(commands[0]!),
      status: "runner_error",
    });
    await expect(
      executeGateCommands([commands[0], commands[0]], {
        runner: passedRunner,
      }),
    ).rejects.toThrow(/duplicate command id/u);
  });

  it("loops until every byte is written when the underlying writer short-writes", async () => {
    const gateModule = await import(
      // @ts-expect-error The production gate intentionally ships as plain Node ESM.
      "../../../scripts/gates/run-command.mjs"
    );
    const received: number[] = [];
    expect(typeof gateModule.writeAllSync).toBe("function");
    gateModule.writeAllSync(
      7,
      Buffer.from("abcdef"),
      (_descriptor: number, bytes: Buffer, offset: number, length: number) => {
        const written = Math.min(2, length);
        received.push(...bytes.subarray(offset, offset + written));
        return written;
      },
    );
    expect(Buffer.from(received).toString("utf8")).toBe("abcdef");
  });

  it("bounds output while hashing all stdout and stderr bytes", async () => {
    const stdout = "a".repeat(4_096);
    const stderr = "b".repeat(2_048);
    const result = await runCommand({
      id: "bounded-output",
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)})`,
      ],
      maxOutputBytes: 128,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("passed");
    expect(result.stdout).toMatchObject({
      bytes: 4_096,
      capturedBytes: 128,
      truncated: true,
      sha256: sha256(stdout),
    });
    expect(result.stderr).toMatchObject({
      bytes: 2_048,
      capturedBytes: 128,
      truncated: true,
      sha256: sha256(stderr),
    });
    expect(JSON.stringify(result)).not.toContain(stdout);
    expect(JSON.stringify(result)).not.toContain(stderr);
  });

  it("classifies timeout, abort, and child signals without hanging", async () => {
    const timedOut = await runCommand({
      id: "timeout",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30,
    });
    expect(timedOut.status).toBe("timeout");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const aborted = await runCommand({
      id: "abort",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 2_000,
      signal: controller.signal,
    });
    expect(aborted.status).toBe("aborted");

    const signaled = await runCommand({
      id: "signal",
      command: process.execPath,
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      timeoutMs: 2_000,
    });
    expect(signaled.status).toBe("signaled");
    expect(signaled.signal).toBe("SIGTERM");
  });

  it("uses a minimal environment and accepts only explicit safe additions", async () => {
    const previous = {
      GLM_API_KEY: process.env.GLM_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      PHASE2_RANDOM_SECRET: process.env.PHASE2_RANDOM_SECRET,
    };
    process.env.GLM_API_KEY = "must-not-enter-child";
    process.env.GITHUB_TOKEN = "must-not-enter-child";
    process.env.PHASE2_RANDOM_SECRET = "must-not-enter-child";
    try {
      const isolated = await runCommand({
        id: "isolated-env",
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({glm:process.env.GLM_API_KEY,github:process.env.GITHUB_TOKEN,random:process.env.PHASE2_RANDOM_SECRET}))",
        ],
      });
      expect(isolated.stdout.sha256).toBe(sha256("{}"));

      const extended = await runCommand({
        id: "safe-env",
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.env.PHASE2_SAFE_TEST ?? '')",
        ],
        additionalEnv: { PHASE2_SAFE_TEST: "allowed" },
      });
      expect(extended.stdout.sha256).toBe(sha256("allowed"));
      await expect(
        runCommand({
          id: "unsafe-env",
          command: process.execPath,
          args: ["--version"],
          additionalEnv: { ANOTHER_API_KEY: "forbidden" },
        }),
      ).rejects.toThrow(/unsafe environment variable/u);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it.skipIf(process.platform === "win32")(
    "terminates the owned process group so timeout leaves no grandchild",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "phase2-process-group-"));
      const pidPath = join(root, "grandchild.pid");
      const source = [
        "const {spawn}=require('node:child_process');",
        "const {writeFileSync}=require('node:fs');",
        "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
        `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
        "setInterval(()=>{},1000);",
      ].join("");
      const result = await runCommand({
        id: "process-group-timeout",
        command: process.execPath,
        args: ["-e", source],
        timeoutMs: 10_000,
      });
      expect(result.status).toBe("timeout");
      expect(existsSync(pidPath)).toBe(true);
      const grandchildPid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      const isRunning = () => {
        const status = spawnSync(
          "ps",
          ["-o", "stat=", "-p", String(grandchildPid)],
          { shell: false, encoding: "utf8" },
        );
        return status.status === 0 && !status.stdout.trim().startsWith("Z");
      };
      let alive = isRunning();
      for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        alive = isRunning();
      }
      if (alive) process.kill(grandchildPid, "SIGKILL");
      expect(alive).toBe(false);
    },
    20_000,
  );

  it("publishes reports through a temporary file, fsync, and rename", () => {
    const root = createSecurePublicationRepository();
    const reportPath = join(root, "reports", "phase2", "gate.json");
    const report = {
      schemaVersion: "1.0.0",
      success: false,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    };

    writeAtomicGateReport(reportPath, report, {
      allowedRoot: root,
      helperAuthority: helperAuthority(root),
    });

    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(report);
  });

  it("removes the temporary report if atomic publication fails", () => {
    const root = createSecurePublicationRepository();
    const reportPath = join(root, "gate.json");
    mkdirSync(reportPath);

    expect(() =>
      writeAtomicGateReport(reportPath, { success: true }, {
        allowedRoot: root,
        helperAuthority: helperAuthority(root),
      }),
    ).toThrow();
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("never follows a report ancestor symlink into an external directory", () => {
    const root = createSecurePublicationRepository();
    const external = mkdtempSync(
      join(tmpdir(), "phase2-report-symlink-external-"),
    );
    writeFileSync(join(external, "sentinel"), "unchanged\n");
    symlinkSync(external, join(root, "reports"));
    expect(() =>
      writeAtomicGateReport(
        join(root, "reports/phase2/gate.json"),
        { success: false },
        { allowedRoot: root, helperAuthority: helperAuthority(root) },
      ),
    ).toThrow(/symlink|no.?follow|unsafe|descriptor|not a directory/u);
    expect(readdirSync(external)).toEqual(["sentinel"]);
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe(
      "unchanged\n",
    );
  });

  it("does not write externally when the report ancestor is swapped immediately before descriptor publication", () => {
    const root = createSecurePublicationRepository();
    const external = mkdtempSync(join(tmpdir(), "phase2-report-swap-external-"));
    mkdirSync(join(root, "reports"));
    writeFileSync(join(external, "sentinel"), "unchanged\n");
    let swapped = false;
    expect(() =>
      writeAtomicGateReport(
        join(root, "reports/phase2/gate.json"),
        { success: false },
        {
          allowedRoot: root,
          helperAuthority: helperAuthority(root),
          failureInjector: (stage: string) => {
            if (stage !== "before-descriptor-publish") return;
            renameSync(join(root, "reports"), join(root, "reports.owned"));
            symlinkSync(external, join(root, "reports"));
            swapped = true;
          },
        },
      ),
    ).toThrow(/symlink|no.?follow|unsafe|descriptor/u);
    expect(swapped).toBe(true);
    expect(readdirSync(external)).toEqual(["sentinel"]);
  });

  it("executes helper bytes from the bound Git tree when the helper pathname is swapped", () => {
    const root = createSecurePublicationRepository();
    const external = mkdtempSync(join(tmpdir(), "phase2-helper-swap-external-"));
    const marker = join(external, "malicious-helper-ran");
    writeFileSync(
      join(root, "scripts/gates/secure-publish.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("ran")\n`,
    );
    const reportPath = join(root, "reports/phase2/gate.json");
    writeAtomicGateReport(
      reportPath,
      { success: false },
      {
        allowedRoot: root,
        helperAuthority: helperAuthority(root),
      },
    );
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual({
      success: false,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps zero external effects when an ancestor is swapped after the helper opens the trusted root descriptor", async () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-openat-swap-root-"));
    const external = mkdtempSync(join(tmpdir(), "phase2-openat-swap-external-"));
    mkdirSync(join(root, "reports"));
    writeFileSync(join(external, "sentinel"), "unchanged\n");
    const child = spawn(
      "python3",
      ["-B", join(repositoryRoot, "scripts/gates/secure-publish.py")],
      {
        shell: false,
        env: { ...process.env, PHASE2_SECURE_PUBLISH_TESTING: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => rejectReady(new Error("secure helper did not emit root-open marker")),
        2_000,
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (!chunk.includes("SECURE_ROOT_OPEN")) return;
        clearTimeout(timeout);
        resolveReady();
      });
    });
    child.stdin.end(
      JSON.stringify({
        operation: "write_file_atomic",
        root,
        path: "reports/phase2/gate.json",
        contentBase64: Buffer.from("outside forbidden\n").toString("base64"),
        testPauseAfterRootOpenMs: 1_000,
      }),
    );
    await ready;
    renameSync(join(root, "reports"), join(root, "reports.owned"));
    symlinkSync(external, join(root, "reports"));
    const exitCode = await new Promise<number | null>((resolveExit) =>
      child.once("close", resolveExit),
    );
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
    expect(readdirSync(external)).toEqual(["sentinel"]);
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe(
      "unchanged\n",
    );
  });

  it(
    "generates and atomically publishes 64 Evidence packages only after an all-pass run",
    { timeout: 30_000 },
    async () => {
      const { root, manifest } = createCompletePhase2Repository();
      try {
        expect(collectGateBindings(root).dirty).toBe(false);
        const bindings = fixtureBindings(root);
        const commands = syntheticPassedResults(root);
        const report = publishPhase2Evidence({
          repositoryRoot: root,
          currentBindings: bindings,
          commandResults: commands,
        });
        expect(report, JSON.stringify(report.errors, null, 2)).toMatchObject({
          ok: true,
          count: 64,
          setSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          directory: expect.stringMatching(
            /^reports\/phase2\/evidence\/[a-f0-9]{40}-[a-f0-9-]+$/u,
          ),
        });
        expect(report.files).toHaveLength(64);
        expect(
          report.files.map(
            (file: { logicalPath: string }) => file.logicalPath,
          ),
        ).toEqual(
          manifest.requirements
            .map(
              (requirement: { evidence_path: string }) =>
                requirement.evidence_path,
            )
            .sort(),
        );
        const published = join(root, report.directory);
        expect(existsSync(published)).toBe(true);
        const firstEvidence = JSON.parse(
          readFileSync(
            join(published, manifest.requirements[0].evidence_path),
            "utf8",
          ),
        );
        expect(firstEvidence.source_bindings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: expect.stringContaining(
                manifest.requirements[0].id.toLowerCase(),
              ),
              blobSha: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
              contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            }),
          ]),
        );
        expect(
          readdirSync(join(root, "reports/phase2")).filter((name) =>
            name.startsWith(".evidence-"),
          ),
        ).toEqual([]);
        expect(collectGateBindings(root).dirty).toBe(false);
        expect(git(root, "status", "--porcelain=v1")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects an Evidence reports ancestor symlink without touching the external target", () => {
    const { root } = createCompletePhase2Repository();
    const external = mkdtempSync(
      join(tmpdir(), "phase2-evidence-symlink-external-"),
    );
    writeFileSync(join(external, "sentinel"), "unchanged\n");
    symlinkSync(external, join(root, "reports"));
    expect(() =>
      publishPhase2Evidence({
        repositoryRoot: root,
        currentBindings: fixtureBindings(root),
        commandResults: syntheticPassedResults(root),
        runId: "e11dece",
      }),
    ).toThrow(/symlink|no.?follow|unsafe|descriptor|not a directory/u);
    expect(readdirSync(external)).toEqual(["sentinel"]);
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe(
      "unchanged\n",
    );
  });

  it(
    "fails closed when an attacker swaps the Evidence ancestor before descriptor publication",
    () => {
      const { root } = createCompletePhase2Repository();
      const external = mkdtempSync(
        join(tmpdir(), "phase2-evidence-swap-"),
      );
      writeFileSync(join(external, "sentinel"), "unchanged\n");
      mkdirSync(join(root, "reports"));
      let swapped = false;
      expect(() =>
        publishPhase2Evidence({
          repositoryRoot: root,
          currentBindings: fixtureBindings(root),
          commandResults: syntheticPassedResults(root),
          runId: "deadbeef-01",
          failureInjector: (currentStage: string) => {
            if (
              swapped ||
              currentStage !== "before-descriptor-publish"
            )
              return;
            swapped = true;
            renameSync(join(root, "reports"), join(root, "reports.owned"));
            symlinkSync(external, join(root, "reports"));
          },
        }),
      ).toThrow(/descriptor|not a directory|symlink|unsafe/u);
      expect(readFileSync(join(external, "sentinel"), "utf8")).toBe(
        "unchanged\n",
      );
      expect(readdirSync(external)).toEqual(["sentinel"]);
    },
    90_000,
  );

  it("preserves the publication error when owned-path cleanup also fails", () => {
    const { root } = createCompletePhase2Repository();
    expect(() =>
      publishPhase2Evidence({
        repositoryRoot: root,
        currentBindings: fixtureBindings(root),
        commandResults: syntheticPassedResults(root),
        runId: "c1ea0f",
        failureInjector: (stage: string) => {
          if (stage === "before-descriptor-publish")
            throw new Error("primary publication error");
          if (stage === "cleanup") throw new Error("cleanup error");
        },
      }),
    ).toThrow(/primary publication error[\s\S]*cleanup error/u);
  });

  it("does not trust an injected publisher summary without independently verifying its bundle", async () => {
    const { root } = createCompletePhase2Repository();
    const fakeFiles = Array.from({ length: 64 }, (_, index) => ({
      logicalPath: `artifacts/phase-2/fake-${index}.json`,
      sha256: "a".repeat(64),
    }));
    const report = await verifyPhase2({
      repositoryRoot: root,
      mode: "local",
      reportPath: join(root, "reports/phase2/gate.json"),
      identityCollector: () => ({
        errors: [],
        dirty: false,
        bindings: fixtureBindings(root),
      }),
      runner: passedRunner,
      evidencePublisher: () => ({
        ok: true,
        errors: [],
        count: 64,
        setSha256: "b".repeat(64),
        files: fakeFiles,
        directory: "reports/phase2/evidence/forged",
      }),
    });
    expect(report.releaseReady).toBe(false);
    expect(report.claims).toEqual({
      requirementsVerified: 0,
      evidencePassed: 0,
    });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "non_authoritative_gate_dependencies" }),
      ]),
    );
  });

  it("never grants release authority to exact-shaped injected gate dependencies", async () => {
    const { root } = createCompletePhase2Repository();
    const report = await verifyPhase2({
      repositoryRoot: root,
      mode: "local",
      reportPath: join(root, "reports/phase2/gate.json"),
      identityCollector: () => ({
        errors: [],
        dirty: false,
        bindings: fixtureBindings(root),
      }),
      runner: passedRunner,
      evidencePublisher: publishPhase2Evidence,
    });
    expect(report.releaseReady).toBe(false);
    expect(report.claims).toEqual({ requirementsVerified: 0, evidencePassed: 0 });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "non_authoritative_gate_dependencies" }),
      ]),
    );
  });

  it("does not invoke injected identity a third time to create release claims", async () => {
    const { root } = createCompletePhase2Repository();
    const bindings = fixtureBindings(root);
    let identityCalls = 0;
    const report = await verifyPhase2({
      repositoryRoot: root,
      mode: "local",
      reportPath: join(root, "reports/phase2/gate.json"),
      identityCollector: () => {
        identityCalls += 1;
        return {
          errors: [],
          dirty: false,
          bindings: structuredClone(bindings),
        };
      },
      runner: passedRunner,
    });
    expect(identityCalls).toBe(2);
    expect(report.releaseReady).toBe(false);
    expect(report.claims.evidencePassed).toBe(0);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "non_authoritative_gate_dependencies" }),
      ]),
    );
    const evidenceRoot = join(root, "reports/phase2/evidence");
    expect(existsSync(evidenceRoot) ? readdirSync(evidenceRoot) : []).toEqual(
      [],
    );
  });

  it(
    "publishes no temporary Evidence when descriptor publication fails",
    () => {
      const { root } = createCompletePhase2Repository();
      try {
        expect(() =>
          publishPhase2Evidence({
          repositoryRoot: root,
          currentBindings: fixtureBindings(root),
          commandResults: syntheticPassedResults(root),
          failureInjector: (stage: string) => {
            if (stage === "before-descriptor-publish")
              throw new Error("injected descriptor failure");
          },
          }),
        ).toThrow(/injected descriptor failure/u);
        const phase2Reports = join(root, "reports/phase2");
        expect(
          existsSync(phase2Reports)
            ? readdirSync(phase2Reports).filter((name) =>
                name.startsWith(".evidence-"),
              )
            : [],
        ).toEqual([]);
        const evidenceRoot = join(phase2Reports, "evidence");
        expect(
          existsSync(evidenceRoot) ? readdirSync(evidenceRoot) : [],
        ).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "detects a published Evidence file whose bytes no longer match the bound set",
    { timeout: 30_000 },
    async () => {
      const { root } = createCompletePhase2Repository();
      const bindings = fixtureBindings(root);
      try {
        const commands = syntheticPassedResults(root);
        const report = publishPhase2Evidence({
          repositoryRoot: root,
          currentBindings: bindings,
          commandResults: commands,
        });
        expect(report.ok).toBe(true);
        const first = report.files[0];
        writeFileSync(
          join(root, report.directory, first.logicalPath),
          '{"tampered":true}\n',
        );
        const checked = verifyEvidenceBundle({
          repositoryRoot: root,
          directory: report.directory,
          expected: report,
          currentBindings: bindings,
          commandResults: commands,
        });
        expect(checked.ok).toBe(false);
        expect(checked.errors.join("\n")).toMatch(/hash|tamper|mismatch/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
