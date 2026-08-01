import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
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
    throw new Error(`trusted executable chain is group/world writable: ${path}`);
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
  if (
    target.uid !== 0 ||
    (target.mode & 0o022) !== 0 ||
    !target.isFile()
  )
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

const gitEnvironment = () =>
  Object.fromEntries(
    ["HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : [],
    ),
  );

export const spawnTrustedGitSync = (args, options = {}) =>
  spawnSync(TRUSTED_GIT_EXECUTABLE, args, {
    env: gitEnvironment(),
    shell: false,
    ...options,
  });
