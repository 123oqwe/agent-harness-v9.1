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
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkWorkspaceBoundaries,
  EXPECTED_WORKSPACES,
} from "../check-workspace-boundaries.mjs";

import {
  createSafeCommandEnvironment,
  executeGateCommands,
  runCommand,
} from "./run-command.mjs";
import { spawnTrustedGitSync } from "./trusted-git.mjs";

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
  "HookRestrictionError",
  "SandboxedHookExecutionPort",
  "SessionSteeringJournal",
];

export const parseNpmJson = (stdout) => {
  const starts = [
    0,
    ...[...stdout.matchAll(/\n/gu)].map((match) => match.index + 1),
  ].reverse();
  for (const start of starts) {
    const candidate = stdout.slice(start).trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // npm 10 can emit lifecycle output before the final --json document.
    }
  }
  throw new SyntaxError("npm output did not contain a trailing JSON document");
};

export const runPackedPackageSmoke = async ({ repositoryRoot = root } = {}) => {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  const temporaryRoot = mkdtempSync(join(tmpdir(), "phase2-package-smoke-"));
  const errors = [];
  let entry = "";
  let tarballSha256 = null;
  let exported = [];
  let installed = false;
  let packedFiles = [];
  const workspaceNames = new Set(EXPECTED_WORKSPACES.map(({ name }) => name));
  const workspaceDependencies = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].flatMap((section) =>
    Object.keys(packageJson[section] ?? {}).filter((name) => workspaceNames.has(name)),
  );
  try {
    const packed = spawnSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--silent",
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
    const packResult = parseNpmJson(packed.stdout);
    packedFiles = packResult[0].files.map(({ path }) => path);
    const leakedWorkspaceFiles = packedFiles.filter((path) =>
      /^(?:packages|apps|dist\/(?:packages|apps))\//u.test(path),
    );
    if (leakedWorkspaceFiles.length > 0) {
      throw new Error(
        `packed root contains private workspace files: ${leakedWorkspaceFiles.join(", ")}`,
      );
    }
    if (workspaceDependencies.length > 0) {
      throw new Error(
        `packed root declares private workspace dependencies: ${workspaceDependencies.join(", ")}`,
      );
    }
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
    packedFiles,
    workspaceDependencies,
    releaseReady: installed && errors.length === 0,
  };
};

export const runWorkspaceCompositionSmoke = async ({
  repositoryRoot = root,
} = {}) => {
  const errors = [];
  const workspaces = [];
  let compositionBound = false;
  let runtimeCorePacked = false;
  let runtimeCoreRestartReplay = false;
  let runtimeCoreTarballSha256 = null;
  const externalRoot = mkdtempSync(
    join(tmpdir(), "phase2-runtime-core-consumer-"),
  );
  try {
    const boundaries = checkWorkspaceBoundaries({ repositoryRoot });
    if (!boundaries.ok) {
      throw new Error(
        `workspace boundary validation failed: ${boundaries.errors.join("; ")}`,
      );
    }
    for (const workspace of EXPECTED_WORKSPACES) {
      const entrypoint = join(repositoryRoot, workspace.path, "dist/index.js");
      if (!existsSync(entrypoint)) {
        throw new Error(
          `workspace entry is missing: ${workspace.path}/dist/index.js`,
        );
      }
      const module = await import(pathToFileURL(entrypoint).href);
      const identity = module.workspaceIdentity;
      if (
        identity?.name !== workspace.name ||
        identity?.path !== workspace.path
      ) {
        throw new Error(`workspace identity mismatch: ${workspace.path}`);
      }
      workspaces.push({
        name: identity.name,
        path: identity.path,
        entrypoint,
      });
    }

    const rootEntrypoint = join(repositoryRoot, "dist/index.js");
    const apiEntrypoint = join(repositoryRoot, "apps/api/dist/index.js");
    if (!existsSync(rootEntrypoint))
      throw new Error("root dist/index.js is missing");
    const api = await import(pathToFileURL(rootEntrypoint).href);
    const apiApp = await import(pathToFileURL(apiEntrypoint).href);
    const composition = apiApp.composeApiApp(api);
    compositionBound =
      composition.kernel.Harness === api.Harness &&
      composition.kernel.createDefaultExecutionContext ===
        api.createDefaultExecutionContext;
    if (!compositionBound) {
      throw new Error("API composition did not bind built root authorities");
    }

    const tarballs = {};
    for (const workspacePath of [
      "packages/contracts",
      "packages/runtime-core",
    ]) {
      const packed = spawnSync(
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--silent",
          "--pack-destination",
          externalRoot,
        ],
        {
          cwd: join(repositoryRoot, workspacePath),
          env: createSafeCommandEnvironment(),
          shell: false,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 120_000,
        },
      );
      if (packed.status !== 0) {
        throw new Error(
          `${workspacePath} npm pack failed with exit ${String(packed.status)}`,
        );
      }
      const result = parseNpmJson(packed.stdout);
      tarballs[workspacePath] = join(
        externalRoot,
        basename(result[0].filename),
      );
    }
    runtimeCoreTarballSha256 = createHash("sha256")
      .update(readFileSync(tarballs["packages/runtime-core"]))
      .digest("hex");
    writeFileSync(
      join(externalRoot, "package.json"),
      `${JSON.stringify({ name: "runtime-core-external-consumer", private: true, type: "module" })}\n`,
    );
    const install = spawnSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--prefer-offline",
        tarballs["packages/contracts"],
        tarballs["packages/runtime-core"],
      ],
      {
        cwd: externalRoot,
        env: createSafeCommandEnvironment(),
        shell: false,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 180_000,
      },
    );
    if (install.status !== 0) {
      throw new Error(
        `runtime-core external install failed with exit ${String(install.status)}`,
      );
    }
    const databasePath = join(externalRoot, "hook-restart.sqlite");
    const smokeSource = [
      `import {createDurableHookSystem} from "@agent-harness/runtime-core";`,
      "let executions=0;",
      "const registration={id:'packed-hook',event:'pre_tool_use',trust:'managed',priority:1,timeout_ms:100,handler:{handle:async()=>{executions+=1;return {action:'continue'}}}};",
      "const input={event:'pre_tool_use',invocation_id:'packed-invocation',idempotency_key:'packed-idempotency',scope:{tenant_id:'packed-tenant',run_id:'packed-run',session_id:'packed-session'},payload:{value:'packed'}};",
      `const options={databasePath:${JSON.stringify(databasePath)},masterKey:Buffer.alloc(32,0x46),leaseMs:1000,registrations:[registration]};`,
      "const first=createDurableHookSystem({...options,ownerId:'packed-first'});",
      "const initial=await first.hooks.dispatch(input);first.close();",
      "const restarted=createDurableHookSystem({...options,ownerId:'packed-restart'});",
      "const replay=await restarted.hooks.dispatch(input);restarted.close();",
      "if(initial.replayed||!replay.replayed||executions!==1)throw new Error('runtime-core restart replay failed');",
      "process.stdout.write(JSON.stringify({restartReplay:true,executions}));",
    ].join("");
    const smoke = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", smokeSource],
      {
        cwd: externalRoot,
        env: createSafeCommandEnvironment(),
        shell: false,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    if (smoke.status !== 0) {
      const stderrSha256 = createHash("sha256")
        .update(smoke.stderr)
        .digest("hex");
      throw new Error(
        `runtime-core external restart smoke failed with exit ${String(smoke.status)} (stderr_sha256=${stderrSha256})`,
      );
    }
    const smokeResult = JSON.parse(smoke.stdout);
    runtimeCoreRestartReplay =
      smokeResult.restartReplay === true && smokeResult.executions === 1;
    runtimeCorePacked = runtimeCoreRestartReplay;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
  return {
    mode: "workspace",
    errors,
    workspaces,
    compositionBound,
    runtimeCorePacked,
    runtimeCoreRestartReplay,
    runtimeCoreTarballSha256,
    workspaceReady: errors.length === 0,
  };
};

export const runPackageSmoke = runPackedPackageSmoke;

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
          id: "materialize-head",
          command: process.execPath,
          args: [
            join(root, "scripts/gates/materialize-git-tree.mjs"),
            "--repository",
            repositoryRoot,
            "--commit",
            sourceIdentity.commitSha,
            "--destination",
            checkout,
          ],
          cwd: repositoryRoot,
          timeoutMs: 300_000,
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
      checkoutIdentity = { ...sourceIdentity };
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
        [
          "architecture",
          [
            "run",
            "test:phase2:architecture",
            "--silent",
            "--",
            "--maxWorkers=1",
          ],
        ],
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
      {
        id: "source-workspace-smoke",
        command: process.execPath,
        args: [
          join(checkout, "scripts/gates/package-smoke.mjs"),
          "--mode",
          "workspace",
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
    ["packed", "workspace", "source-checkout"].includes(argv[1])
  )
    return argv[1];
  throw new Error(
    "usage: package-smoke.mjs --mode <packed|workspace|source-checkout>",
  );
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
        ? await runPackedPackageSmoke()
        : mode === "workspace"
          ? await runWorkspaceCompositionSmoke()
          : await runSourceCheckoutReproduction();
  } catch (error) {
    result = {
      mode: "unknown",
      errors: [error instanceof Error ? error.message : String(error)],
      releaseReady: false,
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode =
    result.mode === "workspace"
      ? result.workspaceReady
        ? 0
        : 1
      : result.releaseReady
        ? 0
        : 1;
}
