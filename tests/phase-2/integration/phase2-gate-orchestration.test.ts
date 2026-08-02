import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
// @ts-expect-error The production gate intentionally ships as plain Node ESM.
import { securePublish } from "../../../scripts/gates/secure-publish.mjs";
import {
  spawnTrustedGitSync,
  TRUSTED_TOOL_PATHS,
  validateProtectedExecutable,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/trusted-git.mjs";
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

const secureRequest = (root: string, request: Record<string, unknown>) => ({
  ...request,
  authority: helperAuthority(root),
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
  it("has no user-writable fallback in the authoritative toolchain", () => {
    expect(TRUSTED_TOOL_PATHS).toEqual({
      git: "/usr/bin/git",
      python3: "/usr/bin/python3",
    });
    expect(JSON.stringify(TRUSTED_TOOL_PATHS)).not.toMatch(
      /usr\/local|opt\/homebrew/u,
    );
  });

  it("rejects an authoritative executable below a writable mocked ancestor", () => {
    const directory = (mode: number) => ({
      uid: 0,
      mode,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    });
    const file = {
      uid: 0,
      mode: 0o100755,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    expect(() =>
      validateProtectedExecutable("/usr/bin/git", {
        realpathSync: () => "/usr/bin/git",
        lstatSync: (path: string) =>
          path === "/usr" ? directory(0o40775) : path === "/usr/bin/git" ? file : directory(0o40755),
        statSync: () => file,
        accessSync: () => undefined,
      }),
    ).toThrow(/writable|protected|ownership|mode/u);
  });

  it("binds both descriptor-relative helpers into the release runner identity", async () => {
    const gateModule = await import(
      // @ts-expect-error The production gate intentionally ships as plain Node ESM.
      "../../../scripts/gates/verify-phase2-local.mjs"
    );
    expect(gateModule.RUNNER_BINDING_PATHS).toEqual(
      expect.arrayContaining([
        "scripts/gates/secure-publish.mjs",
        "scripts/gates/secure-publish.py",
        "scripts/gates/trusted-git.mjs",
        "scripts/gates/materialize-git-tree.mjs",
        "scripts/check-workspace-boundaries.mjs",
        "scripts/gates/check-workspace-coverage.mjs",
      ]),
    );
    const identity = collectGateBindings(repositoryRoot);
    expect(identity.bindings.runnerFiles).toBe(
      gateModule.RUNNER_BINDING_PATHS.length,
    );
    expect(identity.bindings.runnerSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not execute global fsmonitor, filter, includeIf, or alias configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-trusted-git-config-"));
    const home = join(root, "home");
    const repository = join(root, "repository");
    mkdirSync(home);
    mkdirSync(repository);
    const setupEnvironment = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const setupGit = (args: string[]) => {
      const result = spawnSync(TRUSTED_TOOL_PATHS.git, args, {
        cwd: repository,
        env: setupEnvironment,
        encoding: "utf8",
        shell: false,
      });
      expect(result.status, result.stderr).toBe(0);
      return result;
    };
    setupGit(["init", "--quiet"]);
    writeFileSync(join(repository, ".gitattributes"), "payload filter=attack\n");
    writeFileSync(join(repository, "payload"), "trusted payload\n");
    setupGit(["add", ".gitattributes", "payload"]);
    setupGit([
      "-c",
      "user.name=Phase2 Test",
      "-c",
      "user.email=phase2@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "trusted Git fixture",
    ]);

    const previousHome = process.env.HOME;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, "xdg");
    try {
      const marker = join(root, "marker");
      const run = (args: string[]) =>
        spawnTrustedGitSync(args, {
          cwd: repository,
          encoding: "utf8",
          env: { ...process.env, HOME: home },
        });
      const expectNoExecution = (args: string[]) => {
        rmSync(marker, { force: true });
        const result = run(args);
        expect(existsSync(marker), result.stderr).toBe(false);
        return result;
      };

      writeFileSync(
        join(home, ".gitconfig"),
        `[core]\n\tfsmonitor = /usr/bin/touch ${marker}\n`,
      );
      expect(expectNoExecution(["status", "--porcelain"]).status).toBe(0);

      const included = join(root, "included.gitconfig");
      writeFileSync(
        included,
        `[core]\n\tfsmonitor = /usr/bin/touch ${marker}\n`,
      );
      writeFileSync(
        join(home, ".gitconfig"),
        `[includeIf "gitdir:${repository}/"]\n\tpath = ${included}\n`,
      );
      expect(expectNoExecution(["status", "--porcelain"]).status).toBe(0);

      writeFileSync(
        join(home, ".gitconfig"),
        `[filter "attack"]\n\tsmudge = /usr/bin/touch ${marker}\n\trequired = true\n`,
      );
      rmSync(marker, { force: true });
      expect(() => run(["checkout", "--", "payload"])).toThrow(/not allowed/u);
      expect(existsSync(marker)).toBe(false);

      writeFileSync(
        join(home, ".gitconfig"),
        `[alias]\n\tpwn = !/usr/bin/touch ${marker}\n`,
      );
      rmSync(marker, { force: true });
      expect(() => run(["pwn"])).toThrow(/not allowed/u);
      expect(existsSync(marker)).toBe(false);
      expect(expectNoExecution(["cat-file", "blob", "HEAD:payload"]).stdout).toBe(
        "trusted payload\n",
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(root, { recursive: true, force: true });
    }
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

  it("forces publication root to the helper authority repository and forbids .git", () => {
    const authorityRoot = createSecurePublicationRepository();
    const attackerRoot = mkdtempSync(join(tmpdir(), "phase2-cross-root-"));
    expect(() =>
      securePublish({
        operation: "write_file_atomic",
        root: attackerRoot,
        path: "reports/phase2/cross-root.json",
        contentBase64: Buffer.from("forbidden").toString("base64"),
        authority: helperAuthority(authorityRoot),
      }),
    ).toThrow(/root|authority|repository/u);
    expect(existsSync(join(attackerRoot, "reports"))).toBe(false);
    expect(() =>
      securePublish(
        secureRequest(authorityRoot, {
          operation: "write_file_atomic",
          path: ".git/owned-by-helper",
          contentBase64: Buffer.from("forbidden").toString("base64"),
        }),
      ),
    ).toThrow(/reports\/phase2|forbidden|unsafe/u);
    expect(existsSync(join(authorityRoot, ".git/owned-by-helper"))).toBe(false);
  });

  it("anchors publication to the opened authority repository when its pathname is swapped", () => {
    const root = createSecurePublicationRepository();
    const moved = `${root}.owned`;
    const attackerRoot = mkdtempSync(join(tmpdir(), "phase2-root-swap-attacker-"));
    let swapped = false;
    const previous = process.env.PHASE2_SECURE_PUBLISH_TESTING;
    process.env.PHASE2_SECURE_PUBLISH_TESTING = "1";
    try {
      securePublish({
        ...secureRequest(root, {
          operation: "write_file_atomic",
          path: "reports/phase2/root-anchored.json",
          contentBase64: "e30=",
        }),
        testAfterAuthorityOpen: () => {
          renameSync(root, moved);
          symlinkSync(attackerRoot, root);
          swapped = true;
        },
      });
      expect(swapped).toBe(true);
      expect(existsSync(join(attackerRoot, "reports"))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(moved, "reports/phase2/root-anchored.json"), "utf8")),
      ).toEqual({});
    } finally {
      if (previous === undefined)
        delete process.env.PHASE2_SECURE_PUBLISH_TESTING;
      else process.env.PHASE2_SECURE_PUBLISH_TESTING = previous;
    }
  });

  it("validates the full operation before creating directories", () => {
    const root = createSecurePublicationRepository();
    expect(() =>
      securePublish(
        secureRequest(root, {
          operation: "publish_tree",
          temporary: "reports/phase2/.invalid.tmp",
          final: "reports/phase2/evidence/invalid",
          files: [
            { path: "a.json", contentBase64: "%%%invalid%%%" },
            { path: "a.json", contentBase64: "" },
          ],
          unexpected: true,
        }),
      ),
    ).toThrow(/schema|base64|duplicate|unknown/u);
    expect(existsSync(join(root, "reports"))).toBe(false);
  });

  it("requires an exact decimal-string ownership receipt before removal", () => {
    const root = createSecurePublicationRepository();
    mkdirSync(join(root, "reports/phase2/remove-me"), { recursive: true });
    writeFileSync(join(root, "reports/phase2/remove-me/sentinel"), "keep\n");
    expect(() =>
      securePublish(
        secureRequest(root, {
          operation: "remove_tree",
          path: "reports/phase2/remove-me",
          expected: null,
        }),
      ),
    ).toThrow(/expected|ownership|decimal/u);
    expect(readFileSync(join(root, "reports/phase2/remove-me/sentinel"), "utf8"))
      .toBe("keep\n");
  });

  it("never replaces an existing final directory", () => {
    const root = createSecurePublicationRepository();
    const final = join(root, "reports/phase2/evidence/existing");
    mkdirSync(final, { recursive: true });
    const before = statSync(final);
    expect(() =>
      securePublish(
        secureRequest(root, {
          operation: "publish_tree",
          temporary: "reports/phase2/.existing.tmp",
          final: "reports/phase2/evidence/existing",
          files: [],
        }),
      ),
    ).toThrow(/exist|replace|no.?replace/u);
    const after = statSync(final);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  });

  it("removes the owned final after a post-rename fsync failure and preserves cleanup errors", () => {
    const root = createSecurePublicationRepository();
    const previous = process.env.PHASE2_SECURE_PUBLISH_TESTING;
    process.env.PHASE2_SECURE_PUBLISH_TESTING = "1";
    try {
      expect(() =>
        securePublish(
          secureRequest(root, {
            operation: "publish_tree",
            temporary: "reports/phase2/.fsync.tmp",
            final: "reports/phase2/evidence/fsync-failed",
            files: [{ path: "a.json", contentBase64: "e30=" }],
            testFailAfterRenameFsync: true,
            testFailCleanup: true,
          }),
        ),
      ).toThrow(/fsync[\s\S]*cleanup/u);
      expect(existsSync(join(root, "reports/phase2/evidence/fsync-failed"))).toBe(
        false,
      );
    } finally {
      if (previous === undefined)
        delete process.env.PHASE2_SECURE_PUBLISH_TESTING;
      else process.env.PHASE2_SECURE_PUBLISH_TESTING = previous;
    }
  });

  it("returns ownership identities as lossless decimal strings", () => {
    const root = createSecurePublicationRepository();
    const previous = process.env.PHASE2_SECURE_PUBLISH_TESTING;
    process.env.PHASE2_SECURE_PUBLISH_TESTING = "1";
    try {
      const result = securePublish(
        secureRequest(root, {
          operation: "publish_tree",
          temporary: "reports/phase2/.large-identity.tmp",
          final: "reports/phase2/evidence/large-identity",
          files: [],
          testIdentity: {
            dev: "9007199254740993",
            ino: "9007199254740995",
          },
        }),
      );
      expect(result).toMatchObject({
        dev: "9007199254740993",
        ino: "9007199254740995",
      });
    } finally {
      if (previous === undefined)
        delete process.env.PHASE2_SECURE_PUBLISH_TESTING;
      else process.env.PHASE2_SECURE_PUBLISH_TESTING = previous;
    }
  });

  it("does not execute git or python3 supplied through PATH", () => {
    const root = createSecurePublicationRepository();
    const authority = helperAuthority(root);
    const bin = mkdtempSync(join(tmpdir(), "phase2-path-spoof-"));
    const marker = join(bin, "spoof-ran");
    for (const name of ["git", "python3"]) {
      const executable = join(bin, name);
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 99\n`,
      );
      chmodSync(executable, 0o755);
    }
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      expect(() =>
        securePublish(
          {
            operation: "write_file_atomic",
            path: "reports/phase2/path-safe.json",
            contentBase64: "e30=",
            authority,
          },
        ),
      ).not.toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  it("keeps the complete gate and helper authority independent of PATH git and stale trees", { timeout: 120_000 }, () => {
    const bin = mkdtempSync(join(tmpdir(), "phase2-full-gate-path-spoof-"));
    const marker = join(bin, "malicious-git-ran");
    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 99\n`,
    );
    chmodSync(fakeGit, 0o755);
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts/gates/verify-phase2-local.mjs"), "--mode", "dev"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
        shell: false,
        timeout: 90_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);

    const root = createSecurePublicationRepository();
    const staleTreeSha = git(root, "rev-parse", "HEAD^{tree}");
    writeFileSync(join(root, "new-head.txt"), "new head\n");
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=Phase2 Test",
      "-c",
      "user.email=phase2@example.invalid",
      "commit",
      "-m",
      "advance authority head",
    );
    expect(() =>
      securePublish({
        operation: "write_file_atomic",
        path: "reports/phase2/stale-tree.json",
        contentBase64: "e30=",
        authority: { repositoryRoot: root, treeSha: staleTreeSha },
      }),
    ).toThrow(/HEAD|authority|tree/u);
    expect(existsSync(join(root, "reports"))).toBe(false);
  });

  it("rejects NUL and unencodable components before any filesystem mutation", () => {
    for (const unsafePath of ["bad\0.json", "bad\ud800.json"]) {
      const root = createSecurePublicationRepository();
      expect(() =>
        securePublish(
          secureRequest(root, {
            operation: "publish_tree",
            temporary: "reports/phase2/.invalid-component.tmp",
            final: "reports/phase2/evidence/invalid-component",
            files: [{ path: unsafePath, contentBase64: "e30=" }],
          }),
        ),
      ).toThrow(/NUL|component|encoding|surrogate|unsafe/u);
      expect(existsSync(join(root, "reports"))).toBe(false);
    }
  });

  it("preserves atomic report publication and cleanup errors together", () => {
    const root = createSecurePublicationRepository();
    mkdirSync(join(root, "reports/phase2/gate.json"), { recursive: true });
    const previous = process.env.PHASE2_SECURE_PUBLISH_TESTING;
    process.env.PHASE2_SECURE_PUBLISH_TESTING = "1";
    try {
      expect(() =>
        securePublish(
          secureRequest(root, {
            operation: "write_file_atomic",
            path: "reports/phase2/gate.json",
            contentBase64: "e30=",
            testFailCleanup: true,
          }),
        ),
      ).toThrow(/directory|exist|rename[\s\S]*cleanup/u);
      expect(
        readdirSync(join(root, "reports/phase2")).filter((name) =>
          name.endsWith(".tmp"),
        ),
      ).toEqual([]);
    } finally {
      if (previous === undefined)
        delete process.env.PHASE2_SECURE_PUBLISH_TESTING;
      else process.env.PHASE2_SECURE_PUBLISH_TESTING = previous;
    }
  });

  it("reads Evidence trees descriptor-relatively with stable hashes", () => {
    const root = createSecurePublicationRepository();
    mkdirSync(join(root, "reports/phase2/evidence/readable"), {
      recursive: true,
    });
    writeFileSync(join(root, "reports/phase2/evidence/readable/a.json"), "{}\n");
    const result = securePublish(
      secureRequest(root, {
        operation: "read_tree",
        path: "reports/phase2/evidence/readable",
      }),
    );
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "a.json",
        contentBase64: Buffer.from("{}\n").toString("base64"),
        sha256: sha256("{}\n"),
      }),
    ]);
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

  it("rejects an Evidence read ancestor swap after opening the trusted root descriptor", async () => {
    const root = createSecurePublicationRepository();
    mkdirSync(join(root, "reports/phase2/evidence/readable"), {
      recursive: true,
    });
    writeFileSync(join(root, "reports/phase2/evidence/readable/a.json"), "{}\n");
    const external = mkdtempSync(join(tmpdir(), "phase2-read-swap-external-"));
    mkdirSync(join(external, "phase2/evidence/readable"), { recursive: true });
    writeFileSync(
      join(external, "phase2/evidence/readable/a.json"),
      '{"external":true}\n',
    );
    const helper = spawnSync(
      "git",
      [
        "cat-file",
        "blob",
        `${git(root, "rev-parse", "HEAD^{tree}")}:scripts/gates/secure-publish.py`,
      ],
      { cwd: root, encoding: "utf8", shell: false },
    );
    expect(helper.status, helper.stderr).toBe(0);
    const child = spawn("python3", ["-I", "-B", "-c", helper.stdout], {
      shell: false,
      env: { ...process.env, PHASE2_SECURE_PUBLISH_TESTING: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => rejectReady(new Error("secure helper did not emit read marker")),
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
        operation: "read_tree",
        root,
        path: "reports/phase2/evidence/readable",
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
    expect(JSON.parse(stdout).error).toMatch(/not a directory|symlink/u);
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
  }, 15_000);

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
        expect.objectContaining({ code: "non_authoritative_export" }),
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
        expect.objectContaining({ code: "non_authoritative_export" }),
      ]),
    );
  });

  it("keeps the exported verifier non-authoritative for prototype-inherited dependencies", async () => {
    const { root } = createCompletePhase2Repository();
    const inherited = Object.create({
      runner: passedRunner,
      identityCollector: () => ({
        errors: [],
        dirty: false,
        bindings: fixtureBindings(root),
      }),
      evidencePublisher: publishPhase2Evidence,
    });
    Object.assign(inherited, {
      repositoryRoot: root,
      mode: "local",
      reportPath: join(root, "reports/phase2/gate.json"),
    });
    const report = await verifyPhase2(inherited);
    expect(report.releaseReady).toBe(false);
    expect(report.claims).toEqual({ requirementsVerified: 0, evidencePassed: 0 });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "non_authoritative_export" }),
      ]),
    );
  });

  it("treats evidenceFailureInjector alone as a non-authoritative option", async () => {
    const { root } = createCompletePhase2Repository();
    const report = await verifyPhase2({
      repositoryRoot: root,
      mode: "local",
      reportPath: join(root, "reports/phase2/gate.json"),
      evidenceFailureInjector: () => {},
    });
    expect(report.releaseReady).toBe(false);
    expect(report.claims).toEqual({ requirementsVerified: 0, evidencePassed: 0 });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "non_authoritative_export" }),
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
        expect.objectContaining({ code: "non_authoritative_export" }),
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

  it("never verifies Evidence through a swapped pathname ancestor", () => {
    const { root } = createCompletePhase2Repository();
    const bindings = fixtureBindings(root);
    const commands = syntheticPassedResults(root);
    const published = publishPhase2Evidence({
      repositoryRoot: root,
      currentBindings: bindings,
      commandResults: commands,
    });
    const external = mkdtempSync(join(tmpdir(), "phase2-verify-read-external-"));
    let swapped = false;
    const checked = verifyEvidenceBundle({
      repositoryRoot: root,
      directory: published.directory,
      expected: published,
      currentBindings: bindings,
      commandResults: commands,
      readFailureInjector: () => {
        renameSync(join(root, "reports"), join(root, "reports.owned"));
        symlinkSync(external, join(root, "reports"));
        swapped = true;
      },
    });
    expect(swapped).toBe(true);
    expect(checked.ok).toBe(false);
    expect(readdirSync(external)).toEqual([]);
  }, 15_000);
});
