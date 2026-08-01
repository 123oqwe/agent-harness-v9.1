import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeGateCommands,
  runCommand,
  writeAtomicGateReport,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/run-command.mjs";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

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
});
