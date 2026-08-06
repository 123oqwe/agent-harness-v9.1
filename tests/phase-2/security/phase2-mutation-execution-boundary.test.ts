import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runPhase2RequirementDiagnostic,
  // @ts-expect-error The mutation runner intentionally ships as plain Node ESM.
} from "../../../scripts/run-phase2-mutation.mjs";
import {
  compileMutationBubblewrapCommand,
  compileMutationSeatbeltProfile,
  candidateMutationChildEnvironment,
  // @ts-expect-error The mutation bootstrap intentionally ships as plain Node ESM.
} from "../../../scripts/run-phase2-mutation-bootstrap.mjs";

const harnessRoot = resolve(import.meta.dirname, "../../..");

const write = (root: string, path: string, content: string) => {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};

const git = (root: string, ...args: string[]) => {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

const createFixture = (root: string, strykerBase?: string) => {
  write(root, "src/predicate.ts", "export const predicate = true;\n");
  write(
    root,
    "tests/predicate.test.ts",
    'import { expect, it } from "vitest";\nit("works", () => expect(true).toBe(true));\n',
  );
  write(
    root,
    "vitest.phase2-mutation.config.mjs",
    'export default { test: { environment: "node" } };\n',
  );
  write(
    root,
    "mutation/stryker.base.mjs",
    strykerBase ??
      readFileSync(join(harnessRoot, "mutation/stryker.base.mjs"), "utf8"),
  );
  write(root, "package.json", '{"name":"mutation-boundary","type":"module"}\n');
  write(root, ".gitignore", "reports/\n.stryker-tmp/\nnode_modules\nlive-touch.txt\n");
  git(root, "init");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Phase2 Boundary Test",
    "-c",
    "user.email=phase2-boundary@example.invalid",
    "commit",
    "-m",
    "mutation boundary fixture",
  );
  return {
    commitSha: git(root, "rev-parse", "HEAD"),
    treeSha: git(root, "rev-parse", "HEAD^{tree}"),
  };
};

const diagnosticInput = (
  root: string,
  identity: { commitSha: string; treeSha: string },
  strykerExecutable: string,
  reportRoot = join(root, "reports/mutation/phase2-diagnostic"),
) => ({
  repositoryRoot: root,
  requirement: {
    id: "AH-SYNTHETIC-MUTATION-001",
    mutationClass: "critical",
    threshold: 90,
    status: "ready",
    sources: ["src/predicate.ts"],
    tests: ["tests/predicate.test.ts"],
  },
  commitSha: identity.commitSha,
  treeSha: identity.treeSha,
  registrySha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  phase1MutationSha256: "c".repeat(64),
  configurationHash: "d".repeat(64),
  strykerExecutable,
  vitestConfigPath: "vitest.phase2-mutation.config.mjs",
  reportRoot,
  timeoutMs: 10_000,
});

describe("Phase 2 mutation execution security boundary", () => {
  it("keeps a direct full-phase core invocation permanently draft-only", () => {
    const runner = readFileSync(join(harnessRoot, "scripts/run-phase2-mutation.mjs"), "utf8");
    expect(runner).toContain("candidate-report.json");
    expect(runner).not.toMatch(/evidence_eligible:\s*true/u);
    expect(runner).not.toMatch(/PHASE2_FORMAL_/u);
  });

  it("compiles fail-closed Seatbelt and rootless bubblewrap formal policies", () => {
    const seatbelt = compileMutationSeatbeltProfile({
      liveRoot: "/live",
      snapshot: "/snapshot",
      dependencyRoot: "/dependencies",
    });
    expect(seatbelt).toMatch(/\(deny default\)/u);
    expect(seatbelt).toMatch(/allow file-read/u);
    expect(seatbelt).toMatch(/allow process/u);
    expect(seatbelt).toMatch(/allow file-write.*\/snapshot\/reports/u);
    expect(seatbelt).toMatch(/deny network/u);

    const bubblewrap = compileMutationBubblewrapCommand({
      executable: "/usr/bin/bwrap",
      root: "/live",
      snapshot: "/tmp/formal/snapshot",
      dependencyRoot: "/dependencies",
      target: "phase2",
      nodeExecutable: "/opt/hostedtoolcache/node/22/x64/bin/node",
      nodeRuntimeRoot: "/opt/hostedtoolcache/node/22/x64",
      systemRoots: ["/usr", "/bin"],
    });
    expect(bubblewrap.mechanism).toBe("bubblewrap");
    expect(bubblewrap.args).toEqual(
      expect.arrayContaining([
        "--unshare-all",
        "--new-session",
        "--die-with-parent",
        "--ro-bind",
        "/tmp/formal/snapshot",
        "/dependencies",
        "/opt/hostedtoolcache/node/22/x64",
        "--bind",
        "/tmp/formal/snapshot/reports",
        "/tmp/formal/snapshot/.stryker-tmp",
        "--chdir",
      ]),
    );
    expect(bubblewrap.args).toEqual(
      expect.arrayContaining(["--dir", "/tmp", "--dir", "/opt"]),
    );
    expect(bubblewrap.args).not.toContain("--tmpfs");
    expect(bubblewrap.args).not.toContain("--share-net");
    expect(bubblewrap.args).not.toContain("/live");

    expect(
      candidateMutationChildEnvironment({
        snapshot: "/tmp/formal/snapshot",
        nodeExecutable: "/opt/hostedtoolcache/node/22/x64/bin/node",
      }),
    ).toEqual({
      PATH: "/opt/hostedtoolcache/node/22/x64/bin:/usr/bin:/bin",
      TMPDIR: "/tmp/formal/snapshot/.stryker-tmp",
      LANG: "C",
      LC_ALL: "C",
    });
  });

  it("uses a tiny committed launcher, a pinned exact-SHA workflow, and a private dependency snapshot", () => {
    const packageJson = JSON.parse(
      readFileSync(join(harnessRoot, "package.json"), "utf8"),
    );
    expect(packageJson.scripts["test:mutation:phase2"]).toBe(
      "node scripts/run-phase2-mutation-launcher.mjs phase2",
    );
    const launcher = readFileSync(
      join(harnessRoot, "scripts/run-phase2-mutation-launcher.mjs"),
      "utf8",
    );
    expect(launcher).toContain("/usr/bin/git");
    expect(launcher).toMatch(/cat-file[\s\S]*\$\{attestedSha\}:scripts\/run-phase2-mutation-bootstrap\.mjs/u);
    expect(launcher).not.toMatch(/from\s+["']\.\.?\//u);

    const bootstrap = readFileSync(
      join(harnessRoot, "scripts/run-phase2-mutation-bootstrap.mjs"),
      "utf8",
    );
    expect(bootstrap).not.toMatch(/symlinkSync\([\s\S]{0,120}node_modules/u);
    expect(bootstrap).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(bootstrap).not.toContain("node_modules/patch-package/index.js");
    expect(bootstrap).toContain("applyCommittedPatch");
    expect(bootstrap).toMatch(/dependency.*sha256/iu);

    const workflow = readFileSync(
      join(harnessRoot, ".github/workflows/phase2-mutation.yml"),
      "utf8",
    );
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toMatch(/uses:\s+[^\s]+@[0-9a-f]{40}/gu);
    expect(workflow).toContain("$GITHUB_SHA:scripts/run-phase2-mutation-launcher.mjs");
    expect(workflow).toContain("$RUNNER_TEMP");
  });

  it("runs a real bubblewrap read/write/live/network smoke when available", () => {
    if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
    const parent = mkdtempSync(join(tmpdir(), "phase2-bwrap-smoke-"));
    const liveRoot = join(parent, "live");
    const snapshot = join(parent, "snapshot");
    const dependencyRoot = join(parent, "dependencies");
    try {
      mkdirSync(liveRoot);
      mkdirSync(dependencyRoot);
      mkdirSync(join(snapshot, "reports"), { recursive: true });
      mkdirSync(join(snapshot, ".stryker-tmp"));
      writeFileSync(join(snapshot, "input.txt"), "committed\n");
      const nodeExecutable = realpathSync(process.execPath);
      const script = [
        'const fs = require("node:fs");',
        'const net = require("node:net");',
        `if (fs.readFileSync(${JSON.stringify(join(snapshot, "input.txt"))}, "utf8") !== "committed\\n") process.exit(10);`,
        `fs.writeFileSync(${JSON.stringify(join(snapshot, ".stryker-tmp/tmp-ok"))}, "ok");`,
        `fs.writeFileSync(${JSON.stringify(join(snapshot, "reports/report-ok"))}, "ok");`,
        `try { fs.writeFileSync(${JSON.stringify(join(liveRoot, "forbidden"))}, "bad"); process.exit(11); } catch {}`,
        'const socket = net.connect({ host: "1.1.1.1", port: 80 });',
        "socket.once(\"connect\", () => process.exit(12));",
        "socket.once(\"error\", () => process.exit(0));",
        "setTimeout(() => process.exit(0), 500);",
      ].join("\n");
      const command = compileMutationBubblewrapCommand({
        executable: "/usr/bin/bwrap",
        root: liveRoot,
        snapshot,
        dependencyRoot,
        target: "phase2",
        nodeExecutable,
        nodeRuntimeRoot: dirname(dirname(nodeExecutable)),
        argv: [nodeExecutable, "-e", script],
      });
      const run = spawnSync(command.executable, command.args, {
        cwd: snapshot,
        encoding: "utf8",
        env: candidateMutationChildEnvironment({
          snapshot,
          nodeExecutable,
        }),
        shell: false,
        timeout: 10_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(join(snapshot, ".stryker-tmp/tmp-ok"), "utf8")).toBe(
        "ok",
      );
      expect(readFileSync(join(snapshot, "reports/report-ok"), "utf8")).toBe(
        "ok",
      );
      expect(existsSync(join(liveRoot, "forbidden"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it(
    "runs a real Seatbelt read/write/live/network smoke when available",
    { timeout: 20_000 },
    () => {
      if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
        return;
      const parent = mkdtempSync(join(tmpdir(), "phase2-seatbelt-smoke-"));
      const liveRoot = join(parent, "live");
      const snapshot = join(parent, "snapshot");
      const dependencyRoot = join(snapshot, "node_modules");
      try {
        mkdirSync(liveRoot);
        mkdirSync(dependencyRoot, { recursive: true });
        mkdirSync(join(snapshot, "reports"));
        mkdirSync(join(snapshot, ".stryker-tmp"));
        writeFileSync(join(snapshot, "input.txt"), "committed\n");
        const forbidden = [
          join(liveRoot, "forbidden"),
          join(dependencyRoot, "forbidden"),
          join(parent, "outside"),
        ];
        const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const script = [
          `IFS= read -r value < ${shellQuote(join(snapshot, "input.txt"))}`,
          "test \"$value\" = committed || exit 10",
          `printf ok > ${shellQuote(join(snapshot, "reports/ok"))}`,
          `printf ok > ${shellQuote(join(snapshot, ".stryker-tmp/ok"))}`,
          ...forbidden.map((path, index) =>
            `if printf bad > ${shellQuote(path)} 2>/dev/null; then exit ${20 + index}; fi`),
          "exit 0",
        ].join("\n");
        const profile = compileMutationSeatbeltProfile({ liveRoot, snapshot, dependencyRoot, nodeExecutable: "/bin/bash" });
        expect(profile).toContain(`(deny file-read* (subpath ${JSON.stringify(liveRoot)}))`);
        expect(profile).toContain("(deny network*)");
        const run = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", script], {
          encoding: "utf8", shell: false, timeout: 20_000,
        });
        expect(run.status, run.stderr).toBe(0);
        expect(forbidden.every((path) => !existsSync(path))).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
  it("does not execute a forged authority module before snapshot validation", () => {
    const parent = mkdtempSync(join(tmpdir(), "phase2-bootstrap-import-"));
    const root = join(parent, "repository");
    const sentinel = join(parent, "authority-import-executed");
    try {
      git(parent, "clone", "--shared", harnessRoot, root);
      symlinkSync(join(harnessRoot, "node_modules"), join(root, "node_modules"), "dir");
      const authorityPath = join(root, "mutation/phase2-modules.mjs");
      writeFileSync(
        authorityPath,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "executed");\n${readFileSync(authorityPath, "utf8")}`,
      );
      git(root, "update-index", "--assume-unchanged", "mutation/phase2-modules.mjs");
      expect(git(root, "status", "--porcelain=v1")).toBe("");

      writeFileSync(
        join(root, "scripts/run-phase2-mutation-bootstrap.mjs"),
        `${readFileSync(
          join(harnessRoot, "scripts/run-phase2-mutation-bootstrap.mjs"),
          "utf8",
        )}\n`,
      );
      git(root, "add", "scripts/run-phase2-mutation-bootstrap.mjs");
      git(
        root,
        "-c",
        "user.name=Phase2 Boundary Test",
        "-c",
        "user.email=phase2-boundary@example.invalid",
        "commit",
        "-m",
        "add mutation bootstrap",
      );
      spawnSync("node", ["scripts/run-phase2-mutation-bootstrap.mjs", "phase2"], {
        cwd: root,
        encoding: "utf8",
        shell: false,
        timeout: 30_000,
      });

      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each(["live", "snapshot"])(
    "OS-isolates a committed authority module that tries to rewrite the %s tree",
    (target) => {
      const parent = mkdtempSync(join(tmpdir(), `phase2-formal-${target}-`));
      const root = join(parent, "repository");
      const liveSentinel = join(root, "authority-live-touch");
      try {
        git(parent, "clone", "--shared", harnessRoot, root);
        for (const path of [
          "package.json",
          "scripts/gates/phase2-mutation.mjs",
          "scripts/run-phase2-mutation-bootstrap.mjs",
          "scripts/run-phase2-mutation.mjs",
  "scripts/gates/trusted-git.mjs",
          "scripts/gates/verify-phase2-mutation-bundle.mjs",
          "scripts/run-phase2-mutation-launcher.mjs",
          "verification/schemas/phase2-mutation-publication-receipt.schema.json",
          ".github/workflows/phase2-mutation.yml",
        ]) {
          mkdirSync(join(root, path, ".."), { recursive: true });
          copyFileSync(join(harnessRoot, path), join(root, path));
        }
        const authorityPath = join(root, "mutation/phase2-modules.mjs");
        const attack =
          target === "live"
            ? `writeFileSync(${JSON.stringify(liveSentinel)}, "forged");`
            : 'writeFileSync(new URL("../package.json", import.meta.url), "forged");';
        writeFileSync(
          authorityPath,
          `import { writeFileSync } from "node:fs";\n${attack}\n${readFileSync(authorityPath, "utf8")}`,
        );
        git(root, "add", "package.json", "scripts", "verification", ".github", "mutation/phase2-modules.mjs");
        git(
          root,
          "-c",
          "user.name=Phase2 Boundary Test",
          "-c",
          "user.email=phase2-boundary@example.invalid",
          "commit",
          "-m",
          `commit ${target} rewrite attack`,
        );
        symlinkSync(
          join(harnessRoot, "node_modules"),
          join(root, "node_modules"),
          "dir",
        );
        const packageBytes = readFileSync(join(root, "package.json"));

        const run = spawnSync(
          "node",
          ["scripts/run-phase2-mutation-bootstrap.mjs", "phase2"],
          {
            cwd: root,
           encoding: "utf8",
           shell: false,
            timeout: 60_000,
         },
       );

       expect(run.status).toBe(1);
       expect(existsSync(liveSentinel)).toBe(false);
       expect(readFileSync(join(root, "package.json"))).toEqual(packageBytes);
     } finally {
       rmSync(parent, { recursive: true, force: true });
     }
   },
    90_000,
 );

  it("rejects unknown literal Stryker base keys before launching an executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-stryker-schema-"));
    const sentinel = join(root, "executable-launched");
    try {
      const base = readFileSync(
        join(harnessRoot, "mutation/stryker.base.mjs"),
        "utf8",
      ).replace(
        "export const strykerBase = {",
        "export const strykerBase = {\n  forgedLiteral: true,",
      );
      const identity = createFixture(root, base);
      const executable = join(root, "fake-stryker.mjs");
      writeFileSync(
        executable,
        `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "launched");\nprocess.exit(1);\n`,
      );
      chmodSync(executable, 0o755);

      await expect(
        runPhase2RequirementDiagnostic(
          diagnosticInput(root, identity, executable),
        ),
      ).rejects.toThrow(/Stryker base.*unknown|unknown.*Stryker base/u);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked report-root ancestor before any external write", async () => {
    const parent = mkdtempSync(join(tmpdir(), "phase2-report-symlink-"));
    const root = join(parent, "repository");
    const external = join(parent, "external");
    try {
      mkdirSync(root);
      mkdirSync(external);
      const identity = createFixture(root);
      symlinkSync(external, join(root, "reports"), "dir");

      await expect(
        runPhase2RequirementDiagnostic(
          diagnosticInput(
            root,
            identity,
            "/usr/bin/false",
            join(root, "reports/mutation/phase2-diagnostic"),
          ),
        ),
      ).rejects.toThrow(/report.*symlink|symlink.*report|ancestor.*symlink/u);
      expect(readdirSync(external)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it(
    "never launches mutation execution in the live authoritative worktree",
    { timeout: 20_000 },
    async () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-live-worktree-"));
    try {
      const identity = createFixture(root);
      const executable = join(root, "fake-stryker.mjs");
      writeFileSync(
        executable,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          'writeFileSync("live-touch.txt", "mutation executed here\\n");',
          "process.exit(1);",
          "",
        ].join("\n"),
      );
      chmodSync(executable, 0o755);

      await expect(
        runPhase2RequirementDiagnostic(
          diagnosticInput(root, identity, executable),
        ),
      ).rejects.toThrow();
      expect(existsSync(join(root, "live-touch.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    },
  );
});
