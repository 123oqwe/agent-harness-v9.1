import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

export const trustedToolPaths = Object.freeze({
  git: '/usr/bin/git',
  python3: '/usr/bin/python3',
});

const defaultFilesystem = Object.freeze({
  accessSync,
  lstatSync,
  realpathSync,
  statSync,
});

function pathChain(path) {
  const chain = [];
  for (let cursor = path; ; cursor = dirname(cursor)) {
    chain.push(cursor);
    if (dirname(cursor) === cursor) return chain.reverse();
  }
}

export function validateProtectedExecutable(
  candidate,
  filesystem = defaultFilesystem,
) {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
    throw new Error('trusted executable path must be absolute and normalized');
  }
  const resolved = filesystem.realpathSync(candidate);
  for (const path of new Set([...pathChain(candidate), ...pathChain(resolved)])) {
    const metadata = filesystem.lstatSync(path);
    const final = path === candidate || path === resolved;
    if (metadata.uid !== 0) {
      throw new Error(`trusted executable chain is not root-owned: ${path}`);
    }
    if (!metadata.isSymbolicLink() && (metadata.mode & 0o022) !== 0) {
      throw new Error(
        `trusted executable chain is group/world writable: ${path}`,
      );
    }
    if (!final && !metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new Error(`trusted executable ancestor is not a directory: ${path}`);
    }
  }
  const target = filesystem.statSync(resolved);
  if (target.uid !== 0 || (target.mode & 0o022) !== 0 || !target.isFile()) {
    throw new Error('trusted executable target ownership or mode is unsafe');
  }
  filesystem.accessSync(resolved, constants.X_OK);
  return resolved;
}

export const trustedGitExecutable = validateProtectedExecutable(
  trustedToolPaths.git,
);
export const trustedPythonExecutable = validateProtectedExecutable(
  trustedToolPaths.python3,
);

function isolatedGitEnvironment(directory) {
  return {
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
}

export function spawnTrustedGitSync(args, options = {}) {
  const isolated = mkdtempSync(resolve(tmpdir(), 'phase1-trusted-git-'));
  const safeOptions = { ...options };
  delete safeOptions.env;
  delete safeOptions.shell;
  try {
    return spawnSync(trustedGitExecutable, [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.file.allow=never',
      '-c',
      'protocol.ext.allow=never',
      ...args,
    ], {
      ...safeOptions,
      env: isolatedGitEnvironment(isolated),
      shell: false,
    });
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

export function runTrustedGit(repositoryRoot, args, options = {}) {
  const result = spawnTrustedGitSync(args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `trusted git ${args.join(' ')} failed: ${String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

function assertGitRelativePath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe Git object path: ${String(path)}`);
  }
}

export function readTrustedGitBlob(repositoryRoot, commitSha, relativePath) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) {
    throw new Error('Git blob read requires a full lowercase commit SHA');
  }
  assertGitRelativePath(relativePath);
  return runTrustedGit(
    repositoryRoot,
    ['cat-file', 'blob', `${commitSha}:${relativePath}`],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
}
