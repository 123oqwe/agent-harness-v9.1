import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
  for (const owner of new Set<string>(
    manifest.requirements.map(
      (requirement: { owner: string }) => requirement.owner,
    ),
  )) {
    const source = join(root, owner, "src", "implementation.ts");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "export const implemented = true;\n");
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

describe("Phase 2 gate command orchestration", () => {
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
        timeoutMs: 2_000,
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
    10_000,
  );

  it("publishes reports through a temporary file, fsync, and rename", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-gate-report-"));
    const reportPath = join(root, "reports", "phase2", "gate.json");
    const report = {
      schemaVersion: "1.0.0",
      success: false,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    };

    writeAtomicGateReport(reportPath, report);

    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(report);
  });

  it("removes the temporary report if atomic publication fails", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-gate-report-failure-"));
    const reportPath = join(root, "gate.json");
    mkdirSync(reportPath);

    expect(() =>
      writeAtomicGateReport(reportPath, { success: true }),
    ).toThrow();
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it(
    "generates and atomically publishes 64 Evidence packages only after an all-pass run",
    { timeout: 30_000 },
    async () => {
      const { root, manifest } = createCompletePhase2Repository();
      try {
        expect(collectGateBindings(root).dirty).toBe(false);
        const report = await verifyPhase2({
          repositoryRoot: root,
          mode: "local",
          reportPath: join(root, "reports/phase2/gate.json"),
          identityCollector: stableIdentity,
          runner: passedRunner,
        });
        expect(report, JSON.stringify(report.errors, null, 2)).toMatchObject({
          success: true,
          releaseReady: true,
          claims: { requirementsVerified: 64, evidencePassed: 64 },
          evidence: {
            count: 64,
            setSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            directory: expect.stringMatching(
              /^reports\/phase2\/evidence\/[a-f0-9]{40}-[a-f0-9-]+$/u,
            ),
          },
        });
        expect(report.evidence.files).toHaveLength(64);
        expect(
          report.evidence.files.map(
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
        const published = join(root, report.evidence.directory);
        expect(existsSync(published)).toBe(true);
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

  it.each(["write", "validate", "rename"])(
    "cleans temporary Evidence and publishes nothing when %s fails",
    async (failureStage) => {
      const { root } = createCompletePhase2Repository();
      try {
        const report = await verifyPhase2({
          repositoryRoot: root,
          mode: "local",
          reportPath: join(root, "reports/phase2/gate.json"),
          identityCollector: stableIdentity,
          runner: passedRunner,
          evidenceFailureInjector: (stage: string) => {
            if (stage === failureStage)
              throw new Error(`injected ${failureStage} failure`);
          },
        });
        expect(report.releaseReady).toBe(false);
        expect(report.claims).toEqual({
          requirementsVerified: 0,
          evidencePassed: 0,
        });
        expect(report.blockers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "evidence_publication_failed" }),
          ]),
        );
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
    30_000,
  );

  it(
    "detects a published Evidence file whose bytes no longer match the bound set",
    { timeout: 30_000 },
    async () => {
      const { root } = createCompletePhase2Repository();
      try {
        const report = await verifyPhase2({
          repositoryRoot: root,
          mode: "local",
          reportPath: join(root, "reports/phase2/gate.json"),
          identityCollector: stableIdentity,
          runner: passedRunner,
        });
        expect(report.releaseReady).toBe(true);
        const first = report.evidence.files[0];
        writeFileSync(
          join(root, report.evidence.directory, first.logicalPath),
          '{"tampered":true}\n',
        );
        const checked = verifyEvidenceBundle({
          repositoryRoot: root,
          directory: report.evidence.directory,
          expected: report.evidence,
          currentBindings: bindingValue,
          commandResults: report.commands,
        });
        expect(checked.ok).toBe(false);
        expect(checked.errors.join("\n")).toMatch(/hash|tamper|mismatch/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
