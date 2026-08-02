import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const TRUSTED_TOOL_PATHS = Object.freeze({
  git: "/usr/bin/git",
  python3: "/usr/bin/python3",
});

const defaultFilesystem = Object.freeze({
  accessSync,
  lstatSync,
  realpathSync,
  statSync,
});

const pathChain = (path) => {
  const chain = [];
  let current = path;
  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) return chain.reverse();
    current = parent;
  }
};

const assertProtectedNode = (path, stats, { final }) => {
  if (stats.uid !== 0)
    throw new Error(`trusted executable chain is not root-owned: ${path}`);
  if (!stats.isSymbolicLink() && (stats.mode & 0o022) !== 0)
    throw new Error(
      `trusted executable chain is group/world writable: ${path}`,
    );
  if (!final && !stats.isDirectory() && !stats.isSymbolicLink())
    throw new Error(`trusted executable ancestor is not a directory: ${path}`);
};

export const validateProtectedExecutable = (
  candidate,
  filesystem = defaultFilesystem,
) => {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate)
    throw new Error("trusted executable path must be absolute and normalized");
  const resolved = filesystem.realpathSync(candidate);
  for (const chainPath of new Set([
    ...pathChain(candidate),
    ...pathChain(resolved),
  ])) {
    const stats = filesystem.lstatSync(chainPath);
    assertProtectedNode(chainPath, stats, {
      final: chainPath === candidate || chainPath === resolved,
    });
  }
  const target = filesystem.statSync(resolved);
  if (target.uid !== 0 || (target.mode & 0o022) !== 0 || !target.isFile())
    throw new Error("trusted executable target ownership or mode is unsafe");
  filesystem.accessSync(resolved, constants.X_OK);
  return resolved;
};

export const TRUSTED_GIT_EXECUTABLE = validateProtectedExecutable(
  TRUSTED_TOOL_PATHS.git,
);
export const TRUSTED_PYTHON_EXECUTABLE = validateProtectedExecutable(
  TRUSTED_TOOL_PATHS.python3,
);
export const TRUSTED_GIT_CONFIG_ARGUMENTS = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=never",
]);

export const TRUSTED_GIT_ENVIRONMENT = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "/usr/bin/false",
  SSH_ASKPASS: "/usr/bin/false",
});
const TRUSTED_GIT_HOME = mkdtempSync(`${tmpdir()}/phase2-trusted-git-`);
process.once("exit", () => rmSync(TRUSTED_GIT_HOME, { recursive: true, force: true }));

const HASH_OR_REF = /^(?:[0-9a-f]{40}(?:\^\{(?:commit|tree)\})?|HEAD(?:\^\{(?:commit|tree)\})?)$/u;
const OBJECT_PATH = /^(?:[0-9a-f]{40}|HEAD)(?::[^:\0\\]+(?:\/[^:\0\\]+)*)$/u;
const SAFE_PATH = /^(?!-)(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*[\\:\0])[^*?{}[\]]+$/u;

const matchesGrammar = (args) => {
  const [command, ...rest] = args;
  if (command === "rev-parse")
    return (rest.length === 1 && HASH_OR_REF.test(rest[0])) ||
      (rest.length === 2 && rest[0] === "--verify" && HASH_OR_REF.test(rest[1]));
  if (command === "merge-base")
    return rest.length === 3 && rest[0] === "--is-ancestor" &&
      HASH_OR_REF.test(rest[1]) && HASH_OR_REF.test(rest[2]);
  if (command === "cat-file")
    return rest.length === 2 && rest[0] === "blob" &&
      (/^[0-9a-f]{40}$/u.test(rest[1]) || OBJECT_PATH.test(rest[1]));
  if (command === "status")
    return JSON.stringify(rest) === JSON.stringify(["--porcelain=v1", "--untracked-files=all"]) ||
      JSON.stringify(rest) === JSON.stringify(["--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (command === "ls-tree")
    return (rest.length === 3 && [
      JSON.stringify(["-rz", "--full-tree"]),
      JSON.stringify(["-r", "-z"]),
    ].includes(JSON.stringify(rest.slice(0, 2))) && /^[0-9a-f]{40}$/u.test(rest[2])) ||
      (rest.length === 4 && JSON.stringify(rest.slice(0, 3)) === JSON.stringify(["-r", "-z", "--full-tree"]) &&
        /^[0-9a-f]{40}$/u.test(rest[3])) ||
      (rest.length === 5 && JSON.stringify(rest.slice(0, 2)) === JSON.stringify(["--full-tree", "-z"]) &&
        /^[0-9a-f]{40}$/u.test(rest[2]) && rest[3] === "--" && SAFE_PATH.test(rest[4])) ||
      (rest.length === 5 && JSON.stringify(rest.slice(0, 2)) === JSON.stringify(["-r", "-z"]) &&
        /^[0-9a-f]{40}$/u.test(rest[2]) && rest[3] === "--" && SAFE_PATH.test(rest[4]));
  if (command === "ls-files")
    return JSON.stringify(rest) === JSON.stringify(["-z", "--"]) ||
      JSON.stringify(rest) === JSON.stringify(["-v"]) ||
      (rest.length >= 1 && rest.every((arg) => ["--stage", "-z", "--error-unmatch"].includes(arg) || SAFE_PATH.test(arg)));
  if (command === "diff-index")
    return rest.length === 3 && rest[0] === "--quiet" && HASH_OR_REF.test(rest[1]) && rest[2] === "--";
  if (command === "diff-files")
    return JSON.stringify(rest) === JSON.stringify(["--quiet"]);
  return false;
};

const trustedArguments = (args) => {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
    throw new TypeError("trusted Git arguments must be an array of strings");
  if (!matchesGrammar(args))
    throw new TypeError(
      `trusted Git command or option is outside the exact read grammar: ${args.join(" ")}`,
    );
  return [...TRUSTED_GIT_CONFIG_ARGUMENTS, ...args];
};

export const trustedGitReadArguments = (args) =>
  trustedArguments(args);

const gitEnvironment = (home) => ({
  ...Object.fromEntries(
    ["TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : [],
    ),
  ),
  HOME: home,
  XDG_CONFIG_HOME: home,
  ...TRUSTED_GIT_ENVIRONMENT,
});

export const spawnTrustedGitSync = (args, options = {}) => {
  const safeOptions = { ...options };
  delete safeOptions.env;
  delete safeOptions.shell;
  return spawnSync(TRUSTED_GIT_EXECUTABLE, trustedGitReadArguments(args), {
    ...safeOptions,
    env: gitEnvironment(TRUSTED_GIT_HOME),
    shell: false,
  });
};

export const runTrustedGit = (repositoryRoot, args, options = {}) => {
  const result = spawnTrustedGitSync(args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`trusted git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
};

const assertOwnedWorktreePath = (repositoryRoot, worktreePath) => {
  if (!isAbsolute(worktreePath) || resolve(worktreePath) !== worktreePath ||
      dirname(dirname(worktreePath)) !== dirname(repositoryRoot) ||
      !dirname(worktreePath).split('/').at(-1)?.startsWith('.phase2-mutation-isolated-') ||
      worktreePath.split('/').at(-1) !== 'repository')
    throw new Error("trusted worktree path is outside the owned Phase 2 namespace");
};

const runOwnedWorktree = (repositoryRoot, args) => {
  const result = spawnSync(TRUSTED_GIT_EXECUTABLE,
    [...TRUSTED_GIT_CONFIG_ARGUMENTS, ...args], {
      cwd: repositoryRoot, encoding: "utf8", env: gitEnvironment(TRUSTED_GIT_HOME),
      shell: false, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`trusted owned worktree failed: ${result.stderr.trim()}`);
};

export const addTrustedDetachedWorktree = (repositoryRoot, worktreePath, commitSha) => {
  assertOwnedWorktreePath(repositoryRoot, worktreePath);
  if (!/^[a-f0-9]{40}$/u.test(commitSha ?? "")) throw new Error("trusted worktree requires an exact commit SHA");
  runOwnedWorktree(repositoryRoot, ["worktree", "add", "--detach", worktreePath, commitSha]);
};

export const removeTrustedOwnedWorktree = (repositoryRoot, worktreePath) => {
  assertOwnedWorktreePath(repositoryRoot, worktreePath);
  runOwnedWorktree(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
};

const assertGitRelativePath = (path) => {
  if (
    typeof path !== "string" || path.length === 0 || path.startsWith("/") ||
    path.includes("\\") || path.includes(":") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error(`unsafe Git object path: ${String(path)}`);
};

export const readTrustedGitBlob = (repositoryRoot, commitSha, relativePath) => {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? ""))
    throw new Error("Git blob read requires a full lowercase commit SHA");
  assertGitRelativePath(relativePath);
  return runTrustedGit(repositoryRoot, ["cat-file", "blob", `${commitSha}:${relativePath}`], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
};
