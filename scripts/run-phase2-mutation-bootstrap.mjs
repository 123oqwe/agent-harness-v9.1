#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const GIT = "/usr/bin/git";
const PHASE1_BASELINE = "8dca581e11b8043aed257cb07c5161237633c40e";
export const PHASE2_BOOTSTRAP_AUTHORITY_PATHS = Object.freeze([
  "mutation/modules.mjs",
  "mutation/phase2-modules.mjs",
  "mutation/stryker.base.mjs",
  "package-lock.json",
  "package.json",
  "patches/@stryker-mutator+core+9.6.1.patch",
  "patches/@stryker-mutator+vitest-runner+9.6.1.patch",
  "scripts/gates/phase2-mutation.mjs",
  "scripts/gates/json-schema.mjs",
  "scripts/gates/workflow-contract.mjs",
  "scripts/gates/secure-publish.mjs",
  "scripts/gates/secure-publish.py",
  "scripts/gates/verify-phase2-mutation-bundle.mjs",
  "scripts/gates/verify-phase2-mutant-completeness.mjs",
  "scripts/run-phase2-mutation-launcher.mjs",
  "scripts/run-phase2-mutation-bootstrap.mjs",
  "scripts/run-phase2-mutation.mjs",
  "scripts/run-process-tree.mjs",
  "scripts/gates/trusted-git.mjs",
  "verification/gates/phase2-gate.json",
  "verification/gates/phase2-mutation-workflow-contract.json",
  "verification/schemas/phase2-mutation-publication-receipt.schema.json",
  "verification/schemas/phase2-mutation-draft.schema.json",
  "verification/schemas/phase2-mutation-candidate.schema.json",
  "verification/schemas/phase2-mutation-execution-receipt.schema.json",
  "verification/schemas/phase2-mutation-attestation-receipt.schema.json",
  "tests/phase-2/fixtures/native-clean-install/package.json",
  "tests/phase-2/fixtures/native-clean-install/package-lock.json",
  ".github/workflows/phase2-mutation.yml",
  "vitest.mutation.config.ts",
]);
const AUTHORITY_PATHS = PHASE2_BOOTSTRAP_AUTHORITY_PATHS;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const WORKFLOW_RAW_SHA256 = "d14a9c95ec953a0c4ff9855224fd24284e6106b4481dd825b21ac79af458a354";

export const validateCommittedWorkflowContract = (snapshot) => {
  const contract = JSON.parse(readFileSync(join(snapshot, "verification/gates/phase2-mutation-workflow-contract.json"), "utf8"));
  if (canonicalJson(contract) !== canonicalJson({
    schema_version: "phase2-mutation-workflow-contract/v1",
    workflow_path: ".github/workflows/phase2-mutation.yml",
    workflow_ast_sha256: "c76971d2ab2ef7ced7c47c4bcb95a938b978935cc02458720cbdda9729a4a09c",
    authority_scope: "candidate_only",
    formal_evidence_eligible: false,
    formal_authority_status: "external_required_unprovisioned",
    formal_signer_workflow: "123oqwe/phase2-authority/.github/workflows/verify.yml",
  })) throw new Error("Phase 2 mutation workflow contract is invalid");
  const workflow = readFileSync(join(snapshot, contract.workflow_path));
  if (sha256(workflow) !== WORKFLOW_RAW_SHA256)
    throw new Error("Phase 2 mutation workflow bytes differ from the candidate contract");
  return contract;
};
export const safeWrite = (stream, value) => {
  try { stream.write(value); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) throw error;
  }
};
for (const stream of [process.stdout, process.stderr]) stream.on("error", (error) => {
  if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) process.exitCode = 1;
});

export const collectStaticImportClosure = ({ entryPaths, readSource }) => {
  const pending = [...entryPaths];
  const visited = new Set();
  const sourceCache = new Map();
  const load = (path) => {
    if (!sourceCache.has(path)) sourceCache.set(path, Buffer.from(readSource(path)).toString("utf8"));
    return sourceCache.get(path);
  };
  const resolvable = (path) => {
    try { load(path); return true; } catch { return false; }
  };
  const resolveSpecifier = (origin, specifier) => {
    const exact = posix.normalize(posix.join(posix.dirname(origin), specifier));
    if (exact.startsWith("../") || exact.includes("/../"))
      throw new Error(`authority import escapes repository: ${specifier}`);
    if (resolvable(exact)) return exact;
    const candidates = exact.endsWith(".js") ? [`${exact.slice(0, -3)}.ts`, `${exact.slice(0, -3)}.tsx`] :
      exact.endsWith(".mjs") ? [`${exact.slice(0, -4)}.mts`] :
      exact.endsWith(".cjs") ? [`${exact.slice(0, -4)}.cts`] :
      [`${exact}.ts`, `${exact}.tsx`, `${exact}.mjs`, `${exact}.cjs`, `${exact}/index.ts`, `${exact}/index.tsx`];
    const matches = candidates.filter(resolvable);
    if (matches.length !== 1) throw new Error(`authority import must resolve uniquely: ${origin} -> ${specifier}`);
    return matches[0];
  };
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    const text = load(path);
    if (/\b(?:require|import)\s*\/\*/u.test(text) ||
        /(?:^|[;{}]\s*)[A-Za-z_$][\w$]*\s*=\s*require\b/mu.test(text) ||
        /\brequire\b(?!\s*\()/u.test(text))
      throw new Error(`unmodelled module graph syntax in authority closure: ${path}`);
    if (/import\s*\(\s*(?!["'])/u.test(text))
      throw new Error(`unknown dynamic import in authority closure: ${path}`);
    if (/\brequire\s*\(\s*(?!["'])/u.test(text) || /\bcreateRequire\s*\(/u.test(text))
      throw new Error(`unknown runtime require in authority closure: ${path}`);
    visited.add(path);
    const specifiers = [
      ...text.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/gu),
      ...text.matchAll(/import\s*\(\s*["'](\.[^"']+)["']\s*\)/gu),
      ...text.matchAll(/\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/gu),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      pending.push(resolveSpecifier(path, specifier));
    }
  }
  return [...visited].sort();
};

const dependencySnapshot = (dependencyRoot) => {
  const hash = createHash("sha256");
  const versions = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      hash.update(relative);
      hash.update("\0");
      hash.update(String(metadata.mode & 0o777));
      hash.update("\0");
      if (metadata.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        const resolved = resolve(dirname(absolute), target);
        const projectRoot = dirname(dependencyRoot);
        if (target.startsWith("/") || (resolved.startsWith(`${dependencyRoot}/`) === false && resolved.startsWith(`${projectRoot}/`) === false))
          throw new Error(`dependency snapshot symlink escapes root: ${relative}`);
        hash.update(target);
      } else if (metadata.isDirectory()) {
        visit(absolute, relative);
      } else if (metadata.isFile()) {
        const bytes = readFileSync(absolute);
        hash.update(bytes);
        if (entry.name === "package.json") {
          try {
            const value = JSON.parse(bytes.toString("utf8"));
            if (typeof value.name === "string" && typeof value.version === "string")
              versions.push(`${value.name}@${value.version}`);
          } catch {
            throw new Error(`dependency package manifest is invalid: ${relative}`);
          }
        }
      } else {
        throw new Error(`dependency snapshot contains special file: ${relative}`);
      }
      hash.update("\0");
    }
  };
  visit(dependencyRoot);
  return {
    sha256: hash.digest("hex"),
    versions: [...new Set(versions)].sort(),
  };
};

const applyCommittedPatch = (builder, patchPath) => {
  const executable = "/usr/bin/patch";
  const metadata = lstatSync(executable);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
    throw new Error("protected patch helper is unavailable");
  const applied = spawnSync(executable, ["--batch", "--forward", "-p1"], {
    cwd: builder,
    input: readFileSync(patchPath),
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    shell: false,
    timeout: 5 * 60 * 1000,
  });
  if (applied.error) throw applied.error;
  if (applied.status !== 0)
    throw new Error(`applyCommittedPatch failed: ${applied.stderr.trim()}`);
};

export const copyWorkspaceManifests = ({ snapshot, builder }) => {
  const rootManifest = JSON.parse(readFileSync(join(snapshot, "package.json"), "utf8"));
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages;
  if (!Array.isArray(patterns)) return [];
  const copied = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !/^[a-zA-Z0-9._-]+\/\*$/u.test(pattern))
      throw new Error(`unsupported private workspace pattern: ${String(pattern)}`);
    const parentName = pattern.slice(0, -2);
    const sourceParent = join(snapshot, parentName);
    const parentMetadata = lstatSync(sourceParent);
    if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory())
      throw new Error(`workspace parent is unsafe: ${parentName}`);
    for (const entry of readdirSync(sourceParent, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const relative = `${parentName}/${entry.name}/package.json`;
      const source = join(snapshot, relative);
      if (!existsSync(source)) continue;
      const metadata = lstatSync(source);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`workspace manifest is unsafe: ${relative}`);
      JSON.parse(readFileSync(source, "utf8"));
      const destination = join(builder, relative);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination);
      copied.push(relative);
    }
  }
  return copied.sort();
};

const commonRuntimeRoot = (left, right) => {
  const a = resolve(left).split("/").filter(Boolean);
  const b = resolve(right).split("/").filter(Boolean);
  const common = [];
  while (common.length < a.length && common.length < b.length && a[common.length] === b[common.length])
    common.push(a[common.length]);
  return `/${common.join("/")}`;
};

export const compileDependencyBuilderBubblewrapCommand = ({ builder, argv,
  executable = "/usr/bin/bwrap", nodeExecutable = realpathSync(process.execPath),
  npmExecutable = argv?.[0], extraBinds = [] }) => {
  const runtimeRoot = typeof npmExecutable === "string"
    ? commonRuntimeRoot(dirname(dirname(nodeExecutable)), dirname(dirname(dirname(dirname(npmExecutable)))))
    : dirname(dirname(nodeExecutable));
  const runtimeBind = runtimeRoot !== "/" && !runtimeRoot.startsWith("/usr") && !runtimeRoot.startsWith("/bin")
    ? ["--ro-bind", runtimeRoot, runtimeRoot]
    : [];
  return ({
  executable,
  args: [
    "--unshare-all", "--unshare-pid", "--new-session", "--die-with-parent",
    "--proc", "/proc", "--dev", "/dev",
    "--ro-bind", "/usr", "/usr",
    ...(existsSync("/bin") ? ["--ro-bind", "/bin", "/bin"] : []),
    ...(existsSync("/lib") ? ["--ro-bind", "/lib", "/lib"] : []),
    ...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
    ...runtimeBind,
    ...extraBinds,
    "--dir", dirname(builder), "--bind", builder, builder, "--chdir", builder,
    "--", "/usr/bin/prlimit", "--cpu=900", "--as=4294967296", "--nproc=128",
    "--nofile=2048", "--", nodeExecutable, ...argv,
  ],
  network: "none",
  });
};

export const verifyNativeCleanInstallFixture = ({ snapshot, parent }) => {
  if (process.platform !== "linux") throw new Error("native clean-install fixture is a Linux release gate");
  if (process.version !== "v20.19.0") throw new Error(`native fixture requires Node v20.19.0; received ${process.version}`);
  const bubblewrap = trustedBubblewrap();
  if (bubblewrap === null) throw new Error("native fixture requires trusted bubblewrap");
  const fixture = join(snapshot, "tests/phase-2/fixtures/native-clean-install");
  const builder = join(parent, "native-clean-install-builder");
  mkdirSync(builder, { recursive: true, mode: 0o700 });
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(fixture, name), join(builder, name));
  const npmExecutable = realpathSync(join(dirname(process.execPath), "npm"));
  const home = join(parent, "native-fixture-home");
  const cache = join(parent, "native-fixture-cache");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    npm_config_cache: cache, npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: join(home, ".npmrc"), npm_config_globalconfig: join(parent, "native-fixture-global.npmrc") };
  const version = spawnSync(process.execPath, [npmExecutable, "--version"], { encoding: "utf8", env, shell: false });
  if (version.status !== 0 || version.stdout.trim() !== "10.8.2") throw new Error(`native fixture requires npm@10.8.2 (status=${version.status}, stdout=${JSON.stringify(version.stdout?.trim())}, stderr=${JSON.stringify(version.stderr?.trim()?.slice(0, 500))}, npmExecutable=${npmExecutable})`);
  const install = spawnSync(process.execPath, [npmExecutable, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: builder, encoding: "utf8", env, shell: false, timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error(`native fixture clean install failed: ${install.stderr.trim()}`);
  const nodeGypResult = spawnSync(process.execPath, [npmExecutable, "exec", "--yes", "--", "node-gyp", "install"], {
    cwd: builder, encoding: "utf8", env, shell: false, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (nodeGypResult.status !== 0) {
    throw new Error(`native fixture node-gyp header pre-download failed: ${nodeGypResult.stderr?.trim()?.slice(0, 500)}`);
  }
  const rebuild = compileDependencyBuilderBubblewrapCommand({ builder, executable: bubblewrap.path,
    npmExecutable, argv: [npmExecutable, "rebuild", "better-sqlite3", "--no-audit", "--no-fund"],
    extraBinds: ["--ro-bind", home, home, "--ro-bind", "/etc", "/etc"] });
  const rebuilt = spawnSync(rebuild.executable, rebuild.args, { cwd: builder, encoding: "utf8",
    env: { ...env, npm_config_ignore_scripts: "false" }, shell: false, timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  if (rebuilt.error) throw rebuilt.error;
  if (rebuilt.status !== 0) throw new Error(`native fixture rebuild failed: ${rebuilt.stderr.trim()}`);
  const smoke = compileDependencyBuilderBubblewrapCommand({ builder, executable: bubblewrap.path,
    npmExecutable,
    argv: ["--input-type=module", "-e", "import Database from 'better-sqlite3'; const db=new Database(':memory:'); if(db.prepare('select 1 as value').get().value!==1)process.exit(9); db.close();"] });
  const smoked = spawnSync(smoke.executable, smoke.args, { cwd: builder, encoding: "utf8", env, shell: false, timeout: 60_000 });
  if (smoked.error) throw smoked.error;
  if (smoked.status !== 0) throw new Error(`native fixture load failed: ${smoked.stderr.trim()}`);
  const addon = join(builder, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
  const metadata = lstatSync(addon);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("native fixture addon is not a regular file");
  const manifest = {
    package_lock_sha256: sha256(readFileSync(join(builder, "package-lock.json"))),
    dependency_snapshot_sha256: dependencySnapshot(join(builder, "node_modules")).sha256,
    native_addon_sha256: sha256(readFileSync(addon)),
  };
  return { ...manifest, manifest_sha256: sha256(canonicalJson(manifest)) };
};

const installPrivateDependencies = (snapshot, parent) => {
  const builder = join(parent, "dependency-builder");
  mkdirSync(join(builder, "patches"), { recursive: true, mode: 0o700 });
  for (const path of ["package.json", "package-lock.json"])
    copyFileSync(join(snapshot, path), join(builder, path));
  copyWorkspaceManifests({ snapshot, builder });
  const patchNames = [
    "@stryker-mutator+core+9.6.1.patch",
    "@stryker-mutator+vitest-runner+9.6.1.patch",
  ];
  for (const name of patchNames)
    copyFileSync(join(snapshot, "patches", name), join(builder, "patches", name));
  for (const npmrc of [join(snapshot, ".npmrc"), join(dirname(snapshot), ".npmrc")])
    if (existsSync(npmrc)) throw new Error(`reject project/user .npmrc: ${npmrc}`);
  if (process.version !== "v20.19.0")
    throw new Error(`release candidate requires exact Node v20.19.0; received ${process.version}`);
  const npmUserConfig = join(parent, "npm-user.rc");
  const npmGlobalConfig = join(parent, "npm-global.rc");
  copyFileSync("/dev/null", npmUserConfig);
  copyFileSync("/dev/null", npmGlobalConfig);
  const npmEnvironment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(parent, "npm-home"),
    npm_config_cache: join(parent, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: npmUserConfig,
    npm_config_globalconfig: npmGlobalConfig,
  };
  const npmExecutable = realpathSync(join(dirname(process.execPath), "npm"));
  const npmVersion = spawnSync(process.execPath, [npmExecutable, "--version"], {
    encoding: "utf8",
    env: npmEnvironment,
    shell: false,
  });
  if (npmVersion.status !== 0 || npmVersion.stdout.trim() !== "10.8.2")
    throw new Error("release candidate requires npm@10.8.2");
  const env = npmEnvironment;
  mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  const installArgs = [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
  // Command contract: npm ci --ignore-scripts --no-audit --no-fund
  const install = spawnSync("npm", installArgs, {
    cwd: builder,
    encoding: "utf8",
    env,
    shell: false,
    timeout: 30 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (install.error) throw install.error;
  if (install.status !== 0)
    throw new Error(`private npm ci failed: ${install.stderr.trim()}`);
  for (const name of patchNames) applyCommittedPatch(builder, join(builder, "patches", name));
  const bubblewrap = trustedBubblewrap();
  if (process.platform === "linux" && bubblewrap === null)
    throw new Error("native dependency rebuild requires trusted bubblewrap");
  const nodeGypHdrResult = spawnSync(process.execPath, [npmExecutable, "exec", "--yes", "--", "node-gyp", "install"], {
    cwd: builder, encoding: "utf8", env, shell: false, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (nodeGypHdrResult.status !== 0)
    throw new Error("private npm node-gyp header pre-download failed: " + (nodeGypHdrResult.stderr || "").trim().slice(0, 500));
  const rebuildCommand = process.platform === "linux"
    ? compileDependencyBuilderBubblewrapCommand({ builder,
        argv: [npmExecutable, "rebuild", "better-sqlite3", "--no-audit", "--no-fund"],
        npmExecutable,
        executable: bubblewrap.path,
        extraBinds: ["--ro-bind", env.HOME, env.HOME, "--ro-bind", "/etc", "/etc"] })
    : { executable: process.execPath,
        argv: [npmExecutable, "rebuild", "better-sqlite3", "--no-audit", "--no-fund"] };
  const rebuildNative = spawnSync(rebuildCommand.executable, rebuildCommand.args ?? rebuildCommand.argv, {
    cwd: builder,
    encoding: "utf8",
    env: { ...env, npm_config_ignore_scripts: "false" },
    shell: false,
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (rebuildNative.error) throw rebuildNative.error;
  if (rebuildNative.status !== 0)
    throw new Error(`native clean install rebuild failed: ${rebuildNative.stderr.trim()}`);
  const smokeArgv = ["--input-type=module", "-e",
    "import Database from 'better-sqlite3'; const db = new Database(':memory:'); if (db.prepare('select 1 as value').get().value !== 1) process.exit(9); db.close();"];
  const smokeCommand = process.platform === "linux"
    ? compileDependencyBuilderBubblewrapCommand({ builder, argv: smokeArgv, npmExecutable, executable: bubblewrap.path,
        extraBinds: ["--ro-bind", "/etc", "/etc"] })
    : { executable: process.execPath, args: smokeArgv };
  const nativeSmoke = spawnSync(smokeCommand.executable, smokeCommand.args, {
    cwd: builder,
    encoding: "utf8",
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: env.HOME },
    shell: false,
    timeout: 60_000,
  });
  if (nativeSmoke.error) throw nativeSmoke.error;
  if (nativeSmoke.status !== 0)
    throw new Error(`native clean install smoke failed: ${nativeSmoke.stderr.trim()}`);
  renameSync(join(builder, "node_modules"), join(snapshot, "node_modules"));
  return {
    node_version: process.version,
    node_sha256: sha256(readFileSync(realpathSync(process.execPath))),
    npm_version: npmVersion.stdout.trim(),
    npm_sha256: sha256(readFileSync(npmExecutable)),
    registry: "https://registry.npmjs.org/",
  };
};

const sealDependencySnapshot = (root) => {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        visit(absolute);
        chmodSync(absolute, 0o555);
      } else if (metadata.isFile()) {
        chmodSync(absolute, (metadata.mode & 0o111) === 0 ? 0o444 : 0o555);
      }
    }
  };
  visit(root);
  chmodSync(root, 0o555);
};

const isolatedGitEnvironment = () => {
  const directory = mkdtempSync(join(tmpdir(), "phase2-bootstrap-git-"));
  return {
    directory,
    env: {
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LANG: "C",
      LC_ALL: "C",
    },
  };
};

const git = (root, args, { encoding = "utf8" } = {}) => {
  const isolated = isolatedGitEnvironment();
  try {
    const result = spawnSync(
      GIT,
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      {
        cwd: root,
        encoding,
        env: isolated.env,
        shell: false,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `trusted bootstrap git ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
      );
    }
    return result.stdout;
  } finally {
    rmSync(isolated.directory, { recursive: true, force: true });
  }
};

const safeRelativePath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes(":") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");

const assertWorkingRegular = (root, commitSha, path) => {
  if (!safeRelativePath(path)) throw new Error(`unsafe authority path: ${path}`);
  let cursor = root;
  for (const [index, part] of path.split("/").entries()) {
    cursor = join(cursor, part);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`authority path ancestor is a symlink: ${path}`);
    }
    if (index < path.split("/").length - 1 && !metadata.isDirectory()) {
      throw new Error(`authority path ancestor is not a directory: ${path}`);
    }
    if (index === path.split("/").length - 1 && !metadata.isFile()) {
      throw new Error(`authority path is not a regular file: ${path}`);
    }
  }
  const committed = git(root, ["cat-file", "blob", `${commitSha}:${path}`], {
    encoding: "buffer",
  });
  if (!readFileSync(join(root, path)).equals(committed)) {
    throw new Error(`authority working bytes differ from commit: ${path}`);
  }
};

const assertRegularCommitTree = (root, commitSha) => {
  const raw = git(root, ["ls-tree", "-r", "-z", commitSha], {
    encoding: "buffer",
  }).toString("utf8");
  for (const entry of raw.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const [mode, type] = entry.slice(0, separator).split(" ");
    const path = entry.slice(separator + 1);
    if (!safeRelativePath(path) || type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new Error(`exact-commit materialization rejects ${mode} ${type} ${path}`);
    }
  }
};

export const createIsolatedGitAuthority = ({ root, snapshot, commitSha, directory }) => {
  const objects = new Map([[commitSha, "commit"]]);
  const rootTree = git(root, ["rev-parse", `${commitSha}^{tree}`]).trim();
  if (!/^[a-f0-9]{40}$/u.test(rootTree)) throw new Error("isolated Git root tree identity is invalid");
  objects.set(rootTree, "tree");
  const listing = git(root, ["ls-tree", "-r", "-t", "-z", commitSha], { encoding: "buffer" }).toString("utf8");
  for (const entry of listing.split("\0").filter(Boolean)) {
    const header = entry.slice(0, entry.indexOf("\t"));
    const [, type, objectId] = header.split(" ");
    if (!["tree", "blob"].includes(type) || !/^[a-f0-9]{40}$/u.test(objectId))
      throw new Error("isolated Git authority encountered an unsupported object");
    objects.set(objectId, type);
  }
  mkdirSync(join(directory, "objects"), { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, "refs/heads"), { recursive: true, mode: 0o700 });
  for (const [objectId, type] of objects) {
    const content = git(root, ["cat-file", type, objectId], { encoding: "buffer" });
    const loose = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
    const objectSha1 = createHash("sha1").update(loose).digest("hex");
    if (objectSha1 !== objectId) throw new Error(`isolated Git object identity mismatch: ${objectId}`);
    const objectDirectory = join(directory, "objects", objectId.slice(0, 2));
    mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(objectDirectory, objectId.slice(2)), deflateSync(loose), { mode: 0o400, flag: "wx" });
  }
  writeFileSync(join(directory, "HEAD"), "ref: refs/heads/candidate\n", { mode: 0o400 });
  writeFileSync(join(directory, "refs/heads/candidate"), `${commitSha}\n`, { mode: 0o400 });
  writeFileSync(join(directory, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${snapshot}\n`, { mode: 0o400 });
  const indexed = git(snapshot, ["--git-dir", directory, "--work-tree", snapshot, "read-tree", commitSha]);
  if (indexed !== "") throw new Error("isolated Git index protocol mismatch");
  return { directory, objects: objects.size };
};

const sealSnapshotInputs = (root) => {
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (
        path === root &&
        ["node_modules", "reports", ".stryker-tmp"].includes(entry.name)
      ) {
        continue;
      }
      const absolute = join(path, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`exact-commit snapshot contains a symlink: ${absolute}`);
      }
      if (metadata.isDirectory()) {
        visit(absolute);
        chmodSync(absolute, 0o555);
      } else if (metadata.isFile()) {
        chmodSync(absolute, (metadata.mode & 0o111) === 0 ? 0o444 : 0o555);
      } else {
        throw new Error(`exact-commit snapshot contains a special file: ${absolute}`);
      }
    }
  };
  visit(root);
  chmodSync(root, 0o555);
};

const unsealSnapshotInputs = (root) => {
  chmodSync(root, 0o700);
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) {
        chmodSync(absolute, 0o700);
        visit(absolute);
      } else {
        chmodSync(absolute, 0o600);
      }
    }
  };
  visit(root);
};

export const compileMutationSeatbeltProfile = ({
  liveRoot,
  snapshot,
  dependencyRoot = join(snapshot, "node_modules"),
  nodeExecutable = process.execPath,
  systemRoots = ["/usr", "/bin", "/System", "/Library", "/opt/homebrew", dirname(dirname(realpathSync(nodeExecutable)))].filter(existsSync),
}) => {
  const quote = (value) => JSON.stringify(value);
  const canonicalSnapshot = existsSync(snapshot) ? realpathSync(snapshot) : snapshot;
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${quote(nodeExecutable)}))`,
    "(allow process-fork)",
    `(allow file-read* (subpath ${quote(canonicalSnapshot)}))`,
    `(allow file-read* (subpath ${quote(dependencyRoot)}))`,
    ...systemRoots.map((path) => `(allow file-read* (subpath ${quote(path)}))`),
    `(allow file-read* (literal ${quote(nodeExecutable)}))`,
    '(allow file-read* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))',
    ...(liveRoot ? [`(deny file-read* (subpath ${quote(liveRoot)}))`] : []),
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-write* (subpath ${quote(join(canonicalSnapshot, "reports"))}))`,
    `(allow file-write* (subpath ${quote(join(canonicalSnapshot, ".stryker-tmp"))}))`,
    "(deny network*)",
  ].join(" ");
};

export const compileMutationBubblewrapCommand = ({
  executable,
  snapshot,
  dependencyRoot,
  gitAuthorityRoot,
  target,
  nodeExecutable = realpathSync(process.execPath),
  nodeRuntimeRoot = dirname(dirname(nodeExecutable)),
  systemRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64"].filter(
    existsSync,
  ),
  argv = [
    nodeExecutable,
    join(snapshot, "scripts/run-phase2-mutation.mjs"),
    target,
  ],
}) => {
  const mountSources = [
    ...systemRoots,
    snapshot,
    dependencyRoot,
    ...(gitAuthorityRoot === undefined ? [] : [gitAuthorityRoot]),
    nodeRuntimeRoot,
  ];
  const mountParents = [
    ...new Set(
      mountSources.flatMap((path) => {
        const parents = [];
        for (let cursor = dirname(path); cursor !== "/"; cursor = dirname(cursor)) {
          parents.push(cursor);
        }
        return parents.reverse();
      }),
    ),
  ].filter(
    (path) =>
      !systemRoots.some(
        (systemRoot) =>
          path === systemRoot || path.startsWith(`${systemRoot}/`),
      ),
  );
  const readonlyMounts = [
    ...new Set([...systemRoots, snapshot, dependencyRoot, nodeRuntimeRoot,
      ...(gitAuthorityRoot === undefined ? [] : [gitAuthorityRoot])]),
  ];
  return {
    mechanism: "bubblewrap",
    wallClockTimeoutMs: 24 * 60 * 60 * 1000,
    executable,
    args: [
    "--unshare-all",
    "--unshare-pid",
    "--new-session",
    "--die-with-parent",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...mountParents.flatMap((path) => ["--dir", path]),
    ...readonlyMounts.flatMap((path) => ["--ro-bind", path, path]),
    "--bind",
    join(snapshot, "reports"),
    join(snapshot, "reports"),
    "--bind",
    join(snapshot, ".stryker-tmp"),
    join(snapshot, ".stryker-tmp"),
    "--chdir",
    snapshot,
    "--",
    "/usr/bin/prlimit",
    "--cpu=21600",
    "--as=8589934592",
    "--nproc=256",
    "--nofile=4096",
    "--",
    ...argv,
  ],
  };
};

const trustedBubblewrap = () => {
  const path = "/usr/bin/bwrap";
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("bubblewrap executable authority is unsafe");
  }
  accessSync(path, constants.X_OK);
  const version = spawnSync(path, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, shell: false });
  if (version.status !== 0 || version.stdout.trim() !== "bubblewrap 0.6.1")
    throw new Error("bubblewrap version authority mismatch");
  return { path, version: version.stdout.trim(), sha256: sha256(readFileSync(path)) };
};

const trustedResourceLimiter = () => {
  const path = "/usr/bin/prlimit";
  if (!existsSync(path)) throw new Error("prlimit resource authority is unavailable");
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
    throw new Error("prlimit resource authority is unsafe");
  accessSync(path, constants.X_OK);
  return { path, sha256: sha256(readFileSync(path)) };
};

const isolatedCommand = ({ root, snapshot, dependencyRoot, gitAuthorityRoot, target, argv }) => {
  if (process.platform === "darwin")
    throw new Error("Seatbelt is diagnostic-only; release candidate CI requires Linux bubblewrap");
  if (process.platform === "linux") {
    const bubblewrap = trustedBubblewrap();
    if (bubblewrap !== null) {
      const limiter = trustedResourceLimiter();
      return {
        ...compileMutationBubblewrapCommand({
        executable: bubblewrap.path,
        root,
        snapshot,
        dependencyRoot,
        gitAuthorityRoot,
        target,
        ...(argv === undefined ? {} : { argv }),
        }),
        isolationToolchain: {
          bubblewrap_version: bubblewrap.version,
          bubblewrap_sha256: bubblewrap.sha256,
          prlimit_sha256: limiter.sha256,
        },
      };
    }
  }
  throw new Error(
    "Phase 2 release candidate requires trusted Linux rootless bubblewrap",
  );
};

export const candidateMutationChildEnvironment = ({
  snapshot,
  nodeExecutable = process.execPath,
}) => ({
  PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin`,
  TMPDIR: join(snapshot, ".stryker-tmp"),
  LANG: "C",
  LC_ALL: "C",
});

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

const fileSetSha256 = (files) => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path); hash.update("\0");
    hash.update(Buffer.from(file.contentBase64, "base64")); hash.update("\0");
  }
  return hash.digest("hex");
};

const rebuildCandidateChunk = (chunk, batchSha256, requirementId) => ({
  chunk_id: chunk.chunk_id,
  source_file: chunk.source_file,
  start_line: chunk.start_line,
  end_line: chunk.end_line,
  mutate_pattern: chunk.mutate_pattern,
  complete: chunk.complete,
  raw_report_uri: `bundle://${batchSha256}/raw/${requirementId}/${chunk.chunk_id}/mutation.json`,
  config_uri: `bundle://${batchSha256}/raw/${requirementId}/${chunk.chunk_id}/stryker.config.json`,
  raw_report_sha256: chunk.raw_report_sha256,
  config_sha256: chunk.config_sha256,
  raw_source_path_sha256: chunk.raw_source_path_sha256,
  normalized_source_file: chunk.normalized_source_file,
  mutant_identity_sha256: chunk.mutant_identity_sha256,
});

const rebuildCandidateResult = (result, batchSha256) => {
  const chunks = result.chunks.map((chunk) =>
    rebuildCandidateChunk(chunk, batchSha256, result.requirement_id));
  return {
    requirement_id: result.requirement_id,
    mutation_class: result.mutation_class,
    threshold: result.threshold,
    status: result.status,
    evidence_eligible: false,
    synthetic_fixture: false,
    execution_provenance: "isolated_candidate",
    isolation_mechanism: "bubblewrap",
    candidate_run_id: result.candidate_run_id,
    snapshot_sha256: result.snapshot_sha256,
    batch_sha256: batchSha256,
    commit_sha: result.commit_sha,
    tree_sha: result.tree_sha,
    registry_sha256: result.registry_sha256,
    manifest_sha256: result.manifest_sha256,
    phase1_mutation_registry_sha256: result.phase1_mutation_registry_sha256,
    configuration_hash: result.configuration_hash,
    run_id: result.run_id,
    vitest_config_path: result.vitest_config_path,
    sources: [...result.sources],
    integration_sources: [...result.integration_sources],
    integration_source_modules: Object.fromEntries(Object.entries(result.integration_source_modules).map(([path, modules]) => [path, [...modules]])),
    tests: [...result.tests],
    counts: { ...result.counts },
    score: result.score,
    per_file: Object.fromEntries(Object.entries(result.per_file).map(([path, metrics]) => [path, { ...metrics }])),
    expected_chunk_count: result.expected_chunk_count,
    chunks,
    mutant_identity_sha256: result.mutant_identity_sha256,
  };
};

const rawPublicationFiles = (snapshot, draft) => {
  const reportRoot = join(snapshot, "reports/mutation/phase2");
  const files = [];
  for (const result of draft.results) for (const chunk of result.chunks) {
    for (const [sourceField, name, digestField] of [
      ["raw_report_path", "mutation.json", "raw_report_sha256"],
      ["config_path", "stryker.config.json", "config_sha256"],
    ]) {
      if (!safeRelativePath(chunk[sourceField])) throw new Error(`unsafe candidate artifact path: ${String(chunk[sourceField])}`);
      const bytes = readFileSync(join(reportRoot, chunk[sourceField]));
      if (sha256(bytes) !== chunk[digestField]) throw new Error(`candidate artifact hash mismatch: ${chunk.chunk_id}/${name}`);
      files.push({
        path: `raw/${result.requirement_id}/${chunk.chunk_id}/${name}`,
        contentBase64: bytes.toString("base64"),
      });
    }
  }
  return files;
};

const ensureCandidateDirectory = (repositoryRoot, relativePath) => {
  if (!safeRelativePath(relativePath)) throw new Error(`unsafe candidate directory: ${String(relativePath)}`);
  const root = realpathSync(repositoryRoot);
  let cursor = root;
  for (const part of relativePath.split("/")) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error(`candidate directory is not a real directory: ${relativePath}`);
  }
  return cursor;
};

export const recoverPhase2MutationPublications = ({ repositoryRoot }) => {
  const phase2 = ensureCandidateDirectory(repositoryRoot, "reports/phase2");
  for (const entry of readdirSync(phase2, { withFileTypes: true })) {
    if (!entry.name.startsWith("mutation-publication-staging-") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    rmSync(join(phase2, entry.name), { recursive: true, force: true });
  }
};

const publishCandidateTree = ({ repositoryRoot, batchSha256, files }) => {
  if (!/^[a-f0-9]{64}$/u.test(batchSha256)) throw new Error("candidate batch identity is invalid");
  const phase2 = ensureCandidateDirectory(repositoryRoot, "reports/phase2");
  const publications = ensureCandidateDirectory(repositoryRoot, "reports/phase2/mutation-publications");
  const final = join(publications, batchSha256);
  if (existsSync(final)) throw new Error("candidate publication already exists");
  const staging = join(phase2, `mutation-publication-staging-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const seen = new Set();
    for (const file of files) {
      if (!safeRelativePath(file.path) || seen.has(file.path))
        throw new Error(`unsafe or duplicate candidate file: ${String(file.path)}`);
      seen.add(file.path);
      const parts = file.path.split("/");
      let directory = staging;
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
        const metadata = lstatSync(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory())
          throw new Error(`candidate file ancestor is unsafe: ${file.path}`);
      }
      writeFileSync(join(staging, parts.at(-1)), Buffer.from(file.contentBase64, "base64"), {
        flag: "wx",
        mode: 0o600,
      });
    }
    renameSync(staging, final);
    const identity = lstatSync(final);
    return { path: final, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
};

const removePublishedCandidate = ({ path, dev, ino }) => {
  if (!existsSync(path)) return;
  const identity = lstatSync(path);
  if (identity.isSymbolicLink() || !identity.isDirectory() || identity.dev !== dev || identity.ino !== ino)
    throw new Error("candidate cleanup identity changed");
  rmSync(path, { recursive: true, force: true });
};

const run = async () => {
  const root = resolve(process.cwd());
  const target = process.argv[2];
  if (!target) throw new Error("missing Phase 2 mutation target");
  const commitSha = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("invalid commit SHA");
  git(root, ["merge-base", "--is-ancestor", PHASE1_BASELINE, commitSha]);
  for (const path of AUTHORITY_PATHS) assertWorkingRegular(root, commitSha, path);
  assertRegularCommitTree(root, commitSha);

  // This is fail-fast only: source inspection can reject a not-ready registry,
  // but only the isolated snapshot verifier below can authorize execution.
  const committedRegistrySource = git(root, [
    "cat-file",
    "blob",
    `${commitSha}:mutation/phase2-modules.mjs`,
  ]);
  const committedExplicitReady =
    committedRegistrySource.match(/status\s*:\s*["']ready["']/gu)?.length ?? 0;
  const committedReadyByDefault = /status\s*=\s*["']ready["']/u.test(
    committedRegistrySource,
  );
  if (!committedReadyByDefault && committedExplicitReady !== 64) {
    safeWrite(
      process.stdout,
      `${JSON.stringify({ batch_sha256: null, report_sha256: null, path: null, status: "FAIL" })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const parent = mkdtempSync(join(tmpdir(), "phase2-candidate-snapshot-"));
  const snapshot = join(parent, "repository");
  let worktreeAdded = false;
  let success = false;
  let livePublication = null;
  let originalGitPointer = null;
  let gitAuthorityRoot;
  try {
    git(root, ["worktree", "add", "--detach", snapshot, commitSha]);
    worktreeAdded = true;
    originalGitPointer = readFileSync(join(snapshot, ".git"));
    gitAuthorityRoot = join(parent, "git-authority");
    createIsolatedGitAuthority({ root, snapshot, commitSha, directory: gitAuthorityRoot });
    writeFileSync(join(snapshot, ".git"), `gitdir: ${gitAuthorityRoot}\n`, { mode: 0o600 });
    mkdirSync(join(snapshot, "reports/mutation/phase2"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(snapshot, ".stryker-tmp"), {
      recursive: true,
      mode: 0o700,
    });
    await validateCommittedWorkflowContract(snapshot);
    if (target === "native-fixture") {
      const manifest = verifyNativeCleanInstallFixture({ snapshot, parent });
      safeWrite(process.stdout, `${JSON.stringify({ status: "PASS", native_fixture: manifest })}\n`);
      success = true;
      process.exitCode = 0;
      return;
    }
    const registrySource = readFileSync(
      join(snapshot, "mutation/phase2-modules.mjs"),
      "utf8",
    );
    const explicitReady = registrySource.match(/status\s*:\s*["']ready["']/gu)?.length ?? 0;
    const allReadyByDefault = /status\s*=\s*["']ready["']/u.test(registrySource);
    if (!allReadyByDefault && explicitReady !== 64) {
      safeWrite(process.stdout, `${JSON.stringify({ batch_sha256: null, report_sha256: null, path: null, status: "FAIL" })}\n`);
      process.exitCode = 1;
      return;
    }
    const toolchain = installPrivateDependencies(snapshot, parent);
    const dependencyRoot = join(snapshot, "node_modules");
    sealDependencySnapshot(dependencyRoot);
    const dependencies = dependencySnapshot(dependencyRoot);
    sealSnapshotInputs(snapshot);
    const command = isolatedCommand({ root, snapshot, dependencyRoot, gitAuthorityRoot, target });
    const child = spawnSync(
      command.executable,
      command.args,
      {
        cwd: snapshot,
        encoding: "utf8",
        env: candidateMutationChildEnvironment({
          snapshot,
        }),
        shell: false,
        timeout: 24 * 60 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (child.error) throw child.error;
    const dependencyAfter = dependencySnapshot(dependencyRoot);
    if (
      dependencyAfter.sha256 !== dependencies.sha256 ||
      JSON.stringify(dependencyAfter.versions) !== JSON.stringify(dependencies.versions)
    )
      throw new Error("private dependency snapshot changed during execution");
    if (child.status === 0) {
      let protocol;
      try { protocol = JSON.parse(child.stdout); } catch { throw new Error("candidate runner stdout protocol is invalid"); }
      if (protocol?.status !== "PASS" || protocol?.path !== "candidate-report.json" || !/^[a-f0-9]{64}$/u.test(protocol?.report_sha256 ?? ""))
        throw new Error("candidate runner returned an invalid stdout protocol");
      const draftBytes = readFileSync(join(snapshot, "reports/mutation/phase2/candidate-report.json"));
      if (sha256(draftBytes) !== protocol.report_sha256) throw new Error("candidate runner protocol digest mismatch");
      const draft = JSON.parse(draftBytes.toString("utf8"));
      if (draft?.schema_version !== "phase2-mutation-draft/v1" || draft?.status !== "PASS" || draft?.evidence_eligible !== false || draft?.commit_sha !== commitSha)
        throw new Error("candidate runner produced an invalid draft");
      if (!Array.isArray(draft.results) || draft.results.length !== 64) throw new Error("candidate draft is incomplete");
      const completenessCommand = isolatedCommand({ root, snapshot, dependencyRoot, gitAuthorityRoot, target,
        argv: [realpathSync(process.execPath), join(snapshot, "scripts/gates/verify-phase2-mutant-completeness.mjs")] });
      const completeness = spawnSync(completenessCommand.executable, completenessCommand.args, {
        cwd: snapshot, encoding: "utf8", env: candidateMutationChildEnvironment({ snapshot }), shell: false,
        timeout: 6 * 60 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
      });
      if (completeness.error) throw completeness.error;
      if (completeness.status !== 0) throw new Error(`independent mutant completeness failed: ${completeness.stderr.trim()}`);
      let completenessReceipt;
      try { completenessReceipt = JSON.parse(completeness.stdout); } catch { throw new Error("independent mutant completeness protocol is invalid"); }
      if (completenessReceipt?.schema_version !== "phase2-mutant-completeness/v1" || completenessReceipt?.requirements !== 64 ||
          !/^[a-f0-9]{64}$/u.test(completenessReceipt?.mutant_identity_sha256 ?? ""))
        throw new Error("independent mutant completeness receipt is invalid");
      const completenessReceiptBytes = Buffer.from(`${JSON.stringify(completenessReceipt, null, 2)}\n`);
      const candidateRunId = draft.results[0]?.candidate_run_id;
      const sourceSnapshotSha256 = draft.results[0]?.snapshot_sha256;
      if (draft.results.some((result) => result.candidate_run_id !== candidateRunId || result.snapshot_sha256 !== sourceSnapshotSha256))
        throw new Error("candidate draft contains mixed execution identity");
      const closureRoots = [...new Set([
        "scripts/run-phase2-mutation.mjs",
        "scripts/gates/verify-phase2-mutation-bundle.mjs",
        "scripts/gates/verify-phase2-mutant-completeness.mjs",
        "vitest.mutation.config.ts",
        ...draft.results.flatMap((result) => [
          ...result.sources,
          ...result.integration_sources,
          ...result.tests,
          result.vitest_config_path,
        ]),
      ])];
      const importClosurePaths = collectStaticImportClosure({
        entryPaths: closureRoots,
        readSource: (path) => git(root, ["cat-file", "blob", `${commitSha}:${path}`], { encoding: "buffer" }),
      });
      const closurePaths = [...new Set(importClosurePaths)].sort();
      for (const path of closurePaths) assertWorkingRegular(root, commitSha, path);
      const authorityClosureSha256 = sha256(canonicalJson(closurePaths.map((path) => [path, sha256(git(root, ["cat-file", "blob", `${commitSha}:${path}`], { encoding: "buffer" }))])));
      const dependencyManifestSha256 = sha256(canonicalJson(dependencies.versions));
      const executionReceipt = {
        schema_version: "phase2-mutation-execution-receipt/v1",
        child_exit_status: 0,
        runner_sha256: sha256(git(root, ["cat-file", "blob", `${commitSha}:scripts/run-phase2-mutation.mjs`], { encoding: "buffer" })),
        configuration_sha256: draft.configuration_hash,
        source_snapshot_sha256: sourceSnapshotSha256,
        dependency_snapshot_sha256: dependencies.sha256,
        dependency_manifest_sha256: dependencyManifestSha256,
        authority_closure_sha256: authorityClosureSha256,
        mutant_completeness_sha256: sha256(canonicalJson(completenessReceipt)),
        toolchain: { ...toolchain, ...command.isolationToolchain },
        isolation_mechanism: "bubblewrap",
      };
      const treeSha = draft.tree_sha;
      const batchSha256 = sha256(canonicalJson({
        commit_sha: commitSha, tree_sha: treeSha, candidate_run_id: candidateRunId,
        source_snapshot_sha256: sourceSnapshotSha256, configuration_sha256: draft.configuration_hash,
        dependency_snapshot_sha256: dependencies.sha256, authority_closure_sha256: authorityClosureSha256,
      }));
      const candidate = {
        schema_version: "phase2-mutation-candidate/v1",
        phase: 2,
        target: "phase2",
        status: draft.status,
        evidence_eligible: false,
        commit_sha: commitSha,
        tree_sha: treeSha,
        batch_sha256: batchSha256,
        source_root: `commit://${commitSha}/`,
        artifact_root: `bundle://${batchSha256}/`,
        registry_sha256: draft.registry_sha256,
        manifest_sha256: draft.manifest_sha256,
        phase1_mutation_registry_sha256: draft.phase1_mutation_registry_sha256,
        configuration_hash: draft.configuration_hash,
        thresholds: { ...draft.thresholds },
        completed: draft.completed,
        required: draft.required,
        aggregate: { ...draft.aggregate },
        aggregate_score: draft.aggregate_score,
        results: draft.results.map((result) => rebuildCandidateResult(result, batchSha256)),
        errors: [...draft.errors],
        execution_receipt: executionReceipt,
      };
      const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
      const rawFiles = rawPublicationFiles(snapshot, draft);
      const payloadFiles = [
        { path: "candidate-report.json", contentBase64: candidateBytes.toString("base64") },
        { path: "mutant-completeness-receipt.json", contentBase64: completenessReceiptBytes.toString("base64") },
        ...rawFiles,
      ];
      const publicationPath = `reports/phase2/mutation-publications/${batchSha256}`;
      const receipt = {
        schema_version: "phase2-mutation-publication-receipt/v2",
        commit_sha: commitSha,
        tree_sha: treeSha,
        batch_sha256: batchSha256,
        publication_path: publicationPath,
        publication_set_sha256: fileSetSha256(payloadFiles),
        candidate_report_sha256: sha256(candidateBytes),
        execution_receipt_sha256: sha256(canonicalJson(executionReceipt)),
      };
      const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
      recoverPhase2MutationPublications({ repositoryRoot: root });
      const currentCommit = git(root, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]).trim();
      if (currentCommit !== commitSha) {
        throw new Error("live repository commit changed during candidate mutation");
      }
      for (const path of AUTHORITY_PATHS) {
        assertWorkingRegular(root, commitSha, path);
      }
      livePublication = publishCandidateTree({ repositoryRoot: root, batchSha256,
        files: [...payloadFiles, { path: "publication-receipt.json", contentBase64: receiptBytes.toString("base64") }] });
      safeWrite(process.stdout, `${JSON.stringify({ batch_sha256: batchSha256, report_sha256: receipt.candidate_report_sha256,
        path: publicationPath, status: "CANDIDATE_ONLY", formal_evidence_eligible: false,
        external_authority_required: true })}\n`);
      success = true;
    } else {
      safeWrite(process.stdout, child.stdout ?? "");
    }
    safeWrite(process.stderr, child.stderr ?? "");
    process.exitCode = child.status ?? 1;
  } finally {
    if (!success && livePublication !== null) {
      const cleanupErrors = [];
      try {
        removePublishedCandidate(livePublication);
      } catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length > 0) process.exitCode = 1;
    }
    if (worktreeAdded) {
      try {
        if (existsSync(snapshot)) unsealSnapshotInputs(snapshot);
        if (originalGitPointer !== null && existsSync(snapshot))
          writeFileSync(join(snapshot, ".git"), originalGitPointer, { mode: 0o600 });
        git(root, ["worktree", "remove", "--force", snapshot]);
      } catch {
        // Cleanup continues below; a leaked worktree is never treated as success.
        process.exitCode = 1;
      }
    }
    rmSync(parent, { recursive: true, force: true });
  }
};

const scriptPath = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] !== undefined &&
  existsSync(resolve(process.argv[1])) &&
  realpathSync(resolve(process.argv[1])) === realpathSync(resolve(scriptPath));
if (isMain) {
  try {
    await run();
  } catch (error) {
    safeWrite(process.stderr,
      `Phase 2 mutation bootstrap FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
