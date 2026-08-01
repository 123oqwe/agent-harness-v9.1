#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSafeCommandEnvironment,
  executeGateCommands,
  runCommand,
} from "./run-command.mjs";
import {
  spawnTrustedGitSync,
  TRUSTED_GIT_EXECUTABLE,
} from "./trusted-git.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED_EXPORTS = [
  "ScriptedTestProvider",
  "ModelGateway",
  "PolicyEngine",
  "PolicyEnforcementPoint",
  "AuthorizationService",
  "VirtualFilesystem",
  "execSandboxed",
  "ToolRegistry",
  "SkillRegistry",
  "DurableSession",
  "LoopEngine",
  "SecretsBroker",
  "SecretsBrokerApi",
];

export const runPackageSmoke = async ({ repositoryRoot = root } = {}) => {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  const temporaryRoot = mkdtempSync(join(tmpdir(), "phase2-package-smoke-"));
  const errors = [];
  let entry = "";
  let tarballSha256 = null;
  let exported = [];
  let installed = false;
  try {
    const packed = spawnSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryRoot,
      ],
      {
        cwd: repositoryRoot,
        env: createSafeCommandEnvironment(),
        shell: false,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    if (packed.status !== 0)
      throw new Error(`npm pack failed with exit ${String(packed.status)}`);
    const packResult = JSON.parse(packed.stdout);
    const tarball = join(temporaryRoot, basename(packResult[0].filename));
    tarballSha256 = createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex");
    writeFileSync(
      join(temporaryRoot, "package.json"),
      `${JSON.stringify({ name: "phase2-package-consumer", private: true, type: "module" })}\n`,
    );
    const install = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--prefer-offline",
        tarball,
      ],
      {
        cwd: temporaryRoot,
        env: createSafeCommandEnvironment(),
        shell: false,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 180_000,
      },
    );
    if (install.status !== 0)
      throw new Error(
        `isolated consumer install failed with exit ${String(install.status)}`,
      );
    installed = true;
    entry = resolve(
      temporaryRoot,
      "node_modules",
      packageJson.name,
      packageJson.main ?? "dist/index.js",
    );
    if (!existsSync(entry))
      throw new Error(`packed package entry is missing: ${entry}`);
    const smokeSource = [
      `import * as api from ${JSON.stringify(packageJson.name)};`,
      `const required=${JSON.stringify(REQUIRED_EXPORTS)};`,
      "const missing=required.filter((name)=>!(name in api));",
      "if(missing.length>0)throw new Error(`missing exports: ${missing.join(',')}`);",
      "const tools=new api.ToolRegistry();",
      "const skills=new api.SkillRegistry();skills.loadBaseSkills();",
      "process.stdout.write(JSON.stringify({exported:Object.keys(api),tools:tools.size(),skills:skills.size()}));",
    ].join("");
    const smoke = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", smokeSource],
      {
        cwd: temporaryRoot,
        env: createSafeCommandEnvironment(),
        shell: false,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    if (smoke.status !== 0)
      throw new Error(
        `isolated ESM import/instantiation failed with exit ${String(smoke.status)}`,
      );
    const smokeResult = JSON.parse(smoke.stdout);
    exported = smokeResult.exported;
    if (smokeResult.tools !== 0 || smokeResult.skills !== 8) {
      throw new Error(
        "isolated registry instantiation returned unexpected state",
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return {
    mode: "packed",
    errors,
    entry,
    exported,
    tarballSha256,
    installed,
    releaseReady: installed && errors.length === 0,
  };
};

const resolveGitIdentity = (repositoryRoot) => {
  const resolveRevision = (revision) => {
    const result = spawnTrustedGitSync(["rev-parse", "--verify", revision], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `cannot resolve source reproduction ${revision} (exit ${String(result.status)})`,
      );
    }
    return result.stdout.trim();
  };
  return {
    commitSha: resolveRevision("HEAD^{commit}"),
    treeSha: resolveRevision("HEAD^{tree}"),
  };
};

export const prepareExactSourceCheckout = async ({
  repositoryRoot = root,
  checkout,
  archive,
  runner = runCommand,
}) => {
  const errors = [];
  let sourceIdentity = { commitSha: null, treeSha: null };
  let checkoutIdentity = { commitSha: null, treeSha: null };
  let execution = { ok: false, results: [] };
  try {
    sourceIdentity = resolveGitIdentity(repositoryRoot);
    execution = await executeGateCommands(
      [
        {
          id: "archive-head",
          command: TRUSTED_GIT_EXECUTABLE,
          args: ["archive", "--format=tar", "--output", archive, "HEAD"],
          cwd: repositoryRoot,
          timeoutMs: 120_000,
        },
        {
          id: "clone-head",
          command: TRUSTED_GIT_EXECUTABLE,
          args: [
            "clone",
            "--shared",
            "--no-checkout",
            repositoryRoot,
            checkout,
          ],
          cwd: dirname(checkout),
          timeoutMs: 120_000,
        },
        {
          id: "checkout-head",
          command: TRUSTED_GIT_EXECUTABLE,
          args: ["checkout", "--detach", sourceIdentity.commitSha],
          cwd: checkout,
          timeoutMs: 120_000,
        },
      ],
      { runner },
    );
    if (!execution.ok) {
      const failure = execution.results.at(-1);
      errors.push(
        `source checkout command failed: ${failure?.id ?? "unknown"} (${failure?.status ?? "unknown"})`,
      );
    } else {
      checkoutIdentity = resolveGitIdentity(checkout);
      if (checkoutIdentity.commitSha !== sourceIdentity.commitSha) {
        errors.push("source checkout commit does not match the requested HEAD");
      }
      if (checkoutIdentity.treeSha !== sourceIdentity.treeSha) {
        errors.push(
          "source checkout tree does not match the requested HEAD tree",
        );
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    ok: execution.ok && errors.length === 0,
    errors,
    commitSha: sourceIdentity.commitSha,
    treeSha: sourceIdentity.treeSha,
    checkoutCommitSha: checkoutIdentity.commitSha,
    checkoutTreeSha: checkoutIdentity.treeSha,
    commands: execution.results,
  };
};

export const runSourceCheckoutReproduction = async ({
  repositoryRoot = root,
} = {}) => {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), "phase2-source-reproduction-"),
  );
  const checkout = join(temporaryRoot, "checkout");
  const archive = join(temporaryRoot, "source.tar");
  let commitSha = null;
  let treeSha = null;
  let checkoutCommitSha = null;
  let checkoutTreeSha = null;
  let execution = { ok: false, results: [] };
  const errors = [];
  try {
    const sourceCheckout = await prepareExactSourceCheckout({
      repositoryRoot,
      checkout,
      archive,
    });
    commitSha = sourceCheckout.commitSha;
    treeSha = sourceCheckout.treeSha;
    checkoutCommitSha = sourceCheckout.checkoutCommitSha;
    checkoutTreeSha = sourceCheckout.checkoutTreeSha;
    errors.push(...sourceCheckout.errors);
    if (!sourceCheckout.ok) {
      execution = { ok: false, results: sourceCheckout.commands };
      return {
        mode: "source-checkout",
        commitSha,
        treeSha,
        checkoutCommitSha,
        checkoutTreeSha,
        success: false,
        releaseReady: false,
        errors,
        commands: execution.results,
      };
    }
    const commands = [
      {
        id: "clean-install",
        command: "npm",
        args: ["ci", "--no-audit", "--no-fund"],
        cwd: checkout,
        timeoutMs: 900_000,
      },
      ...[
        ["typecheck", ["run", "typecheck", "--silent"]],
        ["cycles", ["run", "check:cycles", "--silent"]],
        ["build", ["run", "build", "--silent"]],
        ["lint", ["run", "lint", "--silent"]],
        [
          "contract",
          ["run", "test:contract", "--silent", "--", "--maxWorkers=1"],
        ],
        ["unit", ["run", "test:unit", "--silent", "--", "--maxWorkers=1"]],
        [
          "integration",
          ["run", "test:integration", "--silent", "--", "--maxWorkers=1"],
        ],
        [
          "security",
          ["run", "test:security", "--silent", "--", "--maxWorkers=1"],
        ],
        ["e2e", ["run", "test:e2e", "--silent", "--", "--maxWorkers=1"]],
      ].map(([id, args]) => ({
        id: `source-${id}`,
        command: "npm",
        args,
        cwd: checkout,
        timeoutMs: 900_000,
      })),
      {
        id: "source-package-smoke",
        command: process.execPath,
        args: [
          join(checkout, "scripts/gates/package-smoke.mjs"),
          "--mode",
          "packed",
        ],
        cwd: checkout,
        timeoutMs: 300_000,
      },
    ];
    const reproduction = await executeGateCommands(commands, {
      runner: runCommand,
    });
    execution = {
      ok: sourceCheckout.ok && reproduction.ok,
      results: [...sourceCheckout.commands, ...reproduction.results],
    };
    if (!execution.ok) {
      const failure = execution.results.at(-1);
      errors.push(
        `source reproduction command failed: ${failure?.id ?? "unknown"} (${failure?.status ?? "unknown"})`,
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return {
    mode: "source-checkout",
    commitSha,
    treeSha,
    checkoutCommitSha,
    checkoutTreeSha,
    success: execution.ok && errors.length === 0,
    releaseReady: execution.ok && errors.length === 0,
    errors,
    commands: execution.results,
  };
};

const parseArguments = (argv) => {
  if (argv.length === 0) return "packed";
  if (
    argv.length === 2 &&
    argv[0] === "--mode" &&
    ["packed", "source-checkout"].includes(argv[1])
  )
    return argv[1];
  throw new Error("usage: package-smoke.mjs --mode <packed|source-checkout>");
};

const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  let result;
  try {
    const mode = parseArguments(process.argv.slice(2));
    result =
      mode === "packed"
        ? await runPackageSmoke()
        : await runSourceCheckoutReproduction();
  } catch (error) {
    result = {
      mode: "unknown",
      errors: [error instanceof Error ? error.message : String(error)],
      releaseReady: false,
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.releaseReady ? 0 : 1;
}
