import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectGateBindings,
  phase2CommandGraph,
  verifyPhase2,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/verify-phase2-local.mjs";
import {
  prepareExactSourceCheckout,
  parseNpmJson,
  runPackedPackageSmoke,
  runWorkspaceCompositionSmoke,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/package-smoke.mjs";
import {
  materializeExactGitTree,
  // @ts-expect-error The production materializer intentionally ships as plain Node ESM.
} from "../../../scripts/gates/materialize-git-tree.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const reportPath = () =>
  join(repositoryRoot, "reports", "phase2", `e2e-${randomUUID()}.json`);
const expectedArgv = (command: { command: string; args: string[] }) => [
  command.command,
  ...command.args.map(
    (argument) =>
      `<arg-sha256:${createHash("sha256").update(argument).digest("hex")}>`,
  ),
];

const runScript = (script: string, timeout = 120_000) =>
  spawnSync("npm", ["run", script, "--silent"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });

describe("Phase 2 real release gate", () => {
  it("parses npm 10 lifecycle output without trusting a non-JSON tail", () => {
    expect(
      parseNpmJson(
        'patch-package 8.0.1\nApplying patches...\n[{"filename":"agent-harness.tgz"}]\n',
      ),
    ).toEqual([{ filename: "agent-harness.tgz" }]);
    expect(() => parseNpmJson("patch-package only")).toThrow(
      "npm output did not contain a trailing JSON document",
    );
  });

  it(
    "never includes Python bytecode caches in the packed Harness",
    { timeout: 30_000 },
    () => {
      const packed = spawnSync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts", "--silent"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          shell: false,
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      expect(packed.status, packed.stderr).toBe(0);
      const paths = parseNpmJson(packed.stdout)[0].files.map(
        (entry: { path: string }) => entry.path,
      );
      expect(paths.some((path: string) => path.includes("__pycache__"))).toBe(
        false,
      );
      expect(paths.some((path: string) => path.endsWith(".pyc"))).toBe(false);
    },
  );

  it(
    "allows the dirty-tree development gate but makes zero release claims",
    { timeout: 720_000 },
    () => {
      const result = runScript("verify:phase2:dev", 660_000);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        mode: "dev",
        success: true,
        releaseReady: false,
        claims: { requirementsVerified: 0, evidencePassed: 0 },
      });
      expect(result.stdout).not.toMatch(/GLM|glm-5\.2/u);
    },
  );

  it("fails an injected local run while implementations and Evidence are absent", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "phase2-local-gate-test-"),
    );
    const visited: string[] = [];
    let identityCalls = 0;
    const report = await verifyPhase2({
      mode: "local",
      repositoryRoot,
      reportPath: reportPath(),
      identityCollector: () => {
        identityCalls += 1;
        return {
          errors: [],
          dirty: identityCalls === 2,
          bindings: {
            commitSha: identityCalls === 1 ? "a".repeat(40) : "b".repeat(40),
          },
        };
      },
      runner: async (command: {
        id: string;
        command: string;
        args: string[];
      }) => {
        visited.push(command.id);
        return {
          id: command.id,
          argv: expectedArgv(command),
          status: "passed",
          exitCode: 0,
          signal: null,
          durationMs: 0,
          stdout: {
            bytes: 0,
            capturedBytes: 0,
            truncated: false,
            sha256: "0".repeat(64),
          },
          stderr: {
            bytes: 0,
            capturedBytes: 0,
            truncated: false,
            sha256: "0".repeat(64),
          },
          error: null,
        };
      },
    });
    expect(report).toMatchObject({
      mode: "local",
      success: false,
      releaseReady: false,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(visited.length).toBeGreaterThan(0);
    expect(identityCalls).toBe(2);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "repository_changed_during_gate" }),
        expect.objectContaining({ code: "evidence_incomplete" }),
      ]),
    );
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("uses a stable structured blocker for an assets release failure", async () => {
    const report = await verifyPhase2({
      mode: "local",
      repositoryRoot,
      reportPath: reportPath(),
      identityCollector: () => ({ errors: [], dirty: false, bindings: {} }),
      runner: async (command: {
        id: string;
        command: string;
        args: string[];
      }) => ({
        id: command.id,
        argv: expectedArgv(command),
        status: command.id === "assets" ? "failed" : "passed",
        exitCode: command.id === "assets" ? 1 : 0,
        signal: null,
        durationMs: 0,
        stdout: {
          bytes: 0,
          capturedBytes: 0,
          truncated: false,
          sha256: "0".repeat(64),
        },
        stderr: {
          bytes: 0,
          capturedBytes: 0,
          truncated: false,
          sha256: "0".repeat(64),
        },
        error: null,
      }),
    });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "assets_release_blocked" }),
        expect.objectContaining({
          code: "mutation_incomplete",
          completed: 3,
          required: 64,
        }),
        expect.objectContaining({ code: "evidence_incomplete" }),
      ]),
    );
    expect(JSON.stringify(report.blockers)).not.toMatch(
      /API_KEY|TOKEN|SECRET/u,
    );
  });

  it(
    "keeps packed-root readiness isolated from private workspace composition",
    { timeout: 180_000 },
    async () => {
      const build = runScript("build");
      expect(build.status, build.stderr).toBe(0);

      const apiEntry = join(repositoryRoot, "apps/api/dist/index.js");
      const hiddenApiEntry = `${apiEntry}.attack-hidden`;
      let packed;
      let brokenComposition;
      try {
        packed = await runPackedPackageSmoke({ repositoryRoot });
        renameSync(apiEntry, hiddenApiEntry);
        brokenComposition = await runWorkspaceCompositionSmoke({
          repositoryRoot,
        });
      } finally {
        if (existsSync(hiddenApiEntry)) renameSync(hiddenApiEntry, apiEntry);
      }

      expect(packed).toMatchObject({
        mode: "packed",
        installed: true,
        releaseReady: true,
        errors: [],
      });
      expect(packed).not.toHaveProperty("workspaceReady");
      expect(packed).not.toHaveProperty("compositionBound");
      expect(packed.workspaceDependencies).toEqual([]);
      expect(
        packed.packedFiles.some((path: string) =>
          /^(?:packages|apps)\//u.test(path),
        ),
      ).toBe(false);
      expect(packed.entry).toContain(
        "node_modules/agent-harness/dist/index.js",
      );
      expect(packed.entry.startsWith(repositoryRoot)).toBe(false);
      expect(brokenComposition).toMatchObject({
        mode: "workspace",
        workspaceReady: false,
        compositionBound: false,
      });

      const composition = await runWorkspaceCompositionSmoke({
        repositoryRoot,
      });
      expect(composition).toMatchObject({
        mode: "workspace",
        workspaceReady: true,
        compositionBound: true,
        runtimeCorePacked: true,
        runtimeCoreRestartReplay: true,
        errors: [],
      });
      expect(composition.runtimeCoreTarballSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(composition).not.toHaveProperty("releaseReady");
      expect(
        composition.workspaces.map(
          (workspace: { path: string }) => workspace.path,
        ),
      ).toEqual([
        "packages/contracts",
        "packages/runtime-core",
        "packages/router",
        "packages/security",
        "packages/tools",
        "packages/ui",
        "packages/api",
        "packages/eval",
        "packages/documents",
        "packages/rag",
        "packages/multimodal",
        "apps/api",
        "apps/web",
        "apps/desktop",
        "apps/tui",
      ]);
    },
  );

  it("keeps the full E2E suite without spawning a nested local gate", () => {
    const e2e = phase2CommandGraph(repositoryRoot, "local").find(
      (entry: { id: string }) => entry.id === "phase2-e2e",
    );
    expect(e2e?.args).toEqual(
      expect.arrayContaining(["run", "tests/phase-2/e2e"]),
    );
    expect(JSON.stringify(e2e)).not.toContain("verify:phase2:local");
    const source = readFileSync(
      join(repositoryRoot, "tests/phase-2/e2e/phase2-release-gate.test.ts"),
      "utf8",
    );
    const spawnedGateScripts = [
      ...source.matchAll(/runScript\("(verify:phase2:[^"]+)"(?:,|\))/gu),
    ].map((match) => match[1]);
    expect(spawnedGateScripts).toEqual(["verify:phase2:dev"]);
  });

  it("serializes full regression commands that share the dist directory", () => {
    const graph = phase2CommandGraph(repositoryRoot, "local");
    for (const id of ["phase1-regression", "coverage"]) {
      const entry = graph.find(
        (candidate: { id: string }) => candidate.id === id,
      );
      expect(entry?.args).toEqual(
        expect.arrayContaining(["--", "--maxWorkers=1"]),
      );
    }
  });

  it("records an exact source-checkout reproduction before release audit", () => {
    const graph = phase2CommandGraph(repositoryRoot, "local");
    const reproductionIndex = graph.findIndex(
      (entry: { id: string }) => entry.id === "source-checkout-reproduction",
    );
    const auditIndex = graph.findIndex(
      (entry: { id: string }) => entry.id === "production-audit",
    );
    expect(reproductionIndex).toBeGreaterThan(-1);
    expect(reproductionIndex).toBeLessThan(auditIndex);
    expect(graph[reproductionIndex]?.args).toEqual(
      expect.arrayContaining(["--mode", "source-checkout"]),
    );
  });

  it(
    "reproduces the exact detached source commit and tree in a real Git checkout",
    { timeout: 120_000 },
    async () => {
      const temporaryRoot = mkdtempSync(
        join(tmpdir(), "phase2-exact-source-test-"),
      );
      const checkout = join(temporaryRoot, "checkout");
      try {
        const result = await prepareExactSourceCheckout({
          repositoryRoot,
          checkout,
        });
        expect(result).toMatchObject({ ok: true, errors: [] });
        expect(result.checkoutCommitSha).toBe(result.commitSha);
        expect(result.checkoutTreeSha).toBe(result.treeSha);
        expect(existsSync(join(checkout, ".git"))).toBe(false);
        expect(
          result.commands.map((command: { id: string }) => command.id),
        ).toEqual(["materialize-head"]);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    "ignores local Git replacement objects for identity and source materialization",
    { timeout: 120_000 },
    async () => {
      const temporaryRoot = mkdtempSync(
        join(tmpdir(), "phase2-git-replace-source-"),
      );
      const source = join(temporaryRoot, "source");
      const directCheckout = join(temporaryRoot, "direct-checkout");
      const preparedCheckout = join(temporaryRoot, "prepared-checkout");
      const runGit = (args: string[]) => {
        const result = spawnSync("/usr/bin/git", args, {
          cwd: source,
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
          shell: false,
        });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      try {
        mkdirSync(source);
        runGit(["init", "--quiet"]);
        writeFileSync(join(source, "payload.txt"), "original tree\n");
        runGit(["add", "payload.txt"]);
        runGit([
          "-c",
          "user.name=Phase2 Test",
          "-c",
          "user.email=phase2@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "original",
        ]);
        const originalCommit = runGit(["rev-parse", "HEAD"]);
        const originalTree = runGit(["rev-parse", "HEAD^{tree}"]);

        writeFileSync(join(source, "payload.txt"), "replacement tree\n");
        writeFileSync(join(source, "injected.txt"), "must not materialize\n");
        runGit(["add", "payload.txt", "injected.txt"]);
        runGit([
          "-c",
          "user.name=Phase2 Test",
          "-c",
          "user.email=phase2@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "replacement",
        ]);
        const replacementCommit = runGit(["rev-parse", "HEAD"]);
        const replacementTree = runGit(["rev-parse", "HEAD^{tree}"]);
        runGit(["checkout", "--quiet", "--detach", originalCommit]);
        runGit(["replace", originalCommit, replacementCommit]);
        expect(runGit(["rev-parse", "HEAD^{tree}"])).toBe(replacementTree);
        expect(replacementTree).not.toBe(originalTree);

        const binding = collectGateBindings(source);
        expect(binding.bindings.commitSha).toBe(originalCommit);
        expect(binding.bindings.treeSha).toBe(originalTree);

        materializeExactGitTree({
          repositoryRoot: source,
          commitSha: originalCommit,
          destination: directCheckout,
        });
        expect(readFileSync(join(directCheckout, "payload.txt"), "utf8")).toBe(
          "original tree\n",
        );
        expect(existsSync(join(directCheckout, "injected.txt"))).toBe(false);

        const prepared = await prepareExactSourceCheckout({
          repositoryRoot: source,
          checkout: preparedCheckout,
        });
        expect(prepared).toMatchObject({
          ok: true,
          errors: [],
          commitSha: originalCommit,
          treeSha: originalTree,
          checkoutCommitSha: originalCommit,
          checkoutTreeSha: originalTree,
        });
        expect(
          readFileSync(join(preparedCheckout, "payload.txt"), "utf8"),
        ).toBe("original tree\n");
        expect(existsSync(join(preparedCheckout, "injected.txt"))).toBe(false);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    "reproduces an exact source archive without executing a local smudge filter",
    { timeout: 120_000 },
    async () => {
      const temporaryRoot = mkdtempSync(
        join(tmpdir(), "phase2-local-filter-source-"),
      );
      const source = join(temporaryRoot, "source");
      const checkout = join(temporaryRoot, "checkout");
      const marker = join(temporaryRoot, "filter-marker");
      const runGit = (args: string[]) => {
        const result = spawnSync("/usr/bin/git", args, {
          cwd: source,
          encoding: "utf8",
          shell: false,
        });
        expect(result.status, result.stderr).toBe(0);
      };
      try {
        mkdirSync(source);
        runGit(["init", "--quiet"]);
        runGit(["config", "filter.evil.smudge", `/usr/bin/touch ${marker}`]);
        runGit(["config", "filter.evil.clean", "/bin/cat"]);
        runGit(["config", "filter.evil.required", "true"]);
        writeFileSync(
          join(source, ".gitattributes"),
          [
            "payload filter=evil",
            "ignored export-ignore",
            "substituted export-subst",
            "",
          ].join("\n"),
        );
        writeFileSync(join(source, "payload"), "trusted payload\n");
        writeFileSync(join(source, "ignored"), "must remain\n");
        writeFileSync(join(source, "substituted"), "$Format:%H$\n");
        runGit(["add", ".gitattributes", "payload", "ignored", "substituted"]);
        runGit([
          "-c",
          "user.name=Phase2 Test",
          "-c",
          "user.email=phase2@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "local filter fixture",
        ]);
        rmSync(marker, { force: true });

        const result = await prepareExactSourceCheckout({
          repositoryRoot: source,
          checkout,
        });

        expect(result).toMatchObject({ ok: true, errors: [] });
        expect(existsSync(marker)).toBe(false);
        expect(readFileSync(join(checkout, "payload"), "utf8")).toBe(
          "trusted payload\n",
        );
        expect(readFileSync(join(checkout, "ignored"), "utf8")).toBe(
          "must remain\n",
        );
        expect(readFileSync(join(checkout, "substituted"), "utf8")).toBe(
          "$Format:%H$\n",
        );
        expect(existsSync(join(checkout, ".git"))).toBe(false);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects symlink entries before exact source materialization", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "phase2-symlink-source-"));
    const source = join(temporaryRoot, "source");
    const checkout = join(temporaryRoot, "checkout");
    const runGit = (args: string[]) => {
      const result = spawnSync("/usr/bin/git", args, {
        cwd: source,
        encoding: "utf8",
        shell: false,
      });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      mkdirSync(source);
      runGit(["init", "--quiet"]);
      writeFileSync(join(source, "payload"), "trusted payload\n");
      symlinkSync("payload", join(source, "payload-link"));
      runGit(["add", "payload", "payload-link"]);
      runGit([
        "-c",
        "user.name=Phase2 Test",
        "-c",
        "user.email=phase2@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "symlink fixture",
      ]);

      const result = await prepareExactSourceCheckout({
        repositoryRoot: source,
        checkout,
      });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toMatch(/materialize-head/u);
      expect(existsSync(checkout)).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("recognizes a symlinked script path as the CLI entry", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "phase2-gate-symlink-"));
    const link = join(temporaryRoot, "phase2-gate.mjs");
    symlinkSync(
      join(repositoryRoot, "scripts/gates/verify-phase2-local.mjs"),
      link,
    );
    const result = spawnSync(process.execPath, [link, "--mode", "invalid"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "unknown",
      success: false,
    });
    rmSync(temporaryRoot, { recursive: true, force: true });
  });
});
