import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import {
  readTrustedGitBlob,
  trustedPythonExecutable,
  runTrustedGit,
} from './gates/trusted-git.mjs';

const helperPath = 'scripts/secure-release-io.py';

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function openAuthorityRoot(path) {
  const namedBefore = lstatSync(path);
  if (namedBefore.isSymbolicLink()) {
    throw new Error('release I/O root must not be a symlink');
  }
  const resolved = realpathSync(path);
  const descriptor = openSync(
    resolved,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    const namedAfter = lstatSync(resolved);
    if (
      !opened.isDirectory() ||
      namedAfter.isSymbolicLink() ||
      !sameIdentity(opened, namedAfter)
    ) {
      throw new Error('release I/O root changed while opening');
    }
    return { descriptor, resolved };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function safeEnvironment(testing) {
  const environment = Object.fromEntries(
    ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'].flatMap((name) =>
      typeof process.env[name] === 'string' ? [[name, process.env[name]]] : [],
    ),
  );
  if (testing) environment.PHASE1_SECURE_IO_TESTING = '1';
  return environment;
}

function assertAuthority(authority) {
  if (
    !authority ||
    Object.getPrototypeOf(authority) !== Object.prototype ||
    Object.keys(authority).sort().join(',') !== 'commitSha,repositoryRoot' ||
    typeof authority.repositoryRoot !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(authority.commitSha ?? '')
  ) {
    throw new Error('secure release I/O requires an exact Git commit authority');
  }
}

export function secureReleaseIo(request) {
  if (process.platform === 'win32') {
    throw new Error('descriptor-relative release I/O is unsupported on this platform');
  }
  if (
    !request ||
    Object.getPrototypeOf(request) !== Object.prototype ||
    typeof request.ioRoot !== 'string'
  ) {
    throw new Error('secure release I/O request must be a plain object');
  }
  assertAuthority(request.authority);
  const testOptions = Object.fromEntries(
    ['testShortWriteMax', 'testFailAfterRenameFsync'].flatMap((name) =>
      Object.hasOwn(request, name) ? [[name, request[name]]] : [],
    ),
  );
  const testing =
    Object.keys(testOptions).length > 0 || Object.hasOwn(request, 'testAfterRootOpen');
  if (testing && process.env.NODE_ENV !== 'test') {
    throw new Error('release I/O test hooks are forbidden');
  }
  const repositoryRoot = realpathSync(request.authority.repositoryRoot);
  const resolvedCommit = runTrustedGit(repositoryRoot, [
    'rev-parse',
    `${request.authority.commitSha}^{commit}`,
  ]).trim();
  if (resolvedCommit !== request.authority.commitSha) {
    throw new Error('secure release I/O commit authority mismatch');
  }
  const helper = readTrustedGitBlob(
    repositoryRoot,
    request.authority.commitSha,
    helperPath,
  );
  const { descriptor } = openAuthorityRoot(request.ioRoot);
  try {
    if (Object.hasOwn(request, 'testAfterRootOpen')) {
      if (
        process.env.NODE_ENV !== 'test' ||
        typeof request.testAfterRootOpen !== 'function'
      ) {
        throw new Error('release I/O test hook is forbidden');
      }
      request.testAfterRootOpen();
    }
    const pythonRequest =
      request.operation === 'write_file_exclusive'
        ? {
            operation: request.operation,
            rootFd: 3,
            path: request.path,
            contentBase64: request.contentBase64,
            ...testOptions,
          }
        : request.operation === 'read_tree'
          ? { operation: request.operation, rootFd: 3, path: request.path }
          : request.operation === 'publish_tree'
            ? {
                operation: request.operation,
                rootFd: 3,
                temporary: request.temporary,
                final: request.final,
                files: request.files,
                ...testOptions,
              }
            : request.operation === 'remove_tree'
              ? {
                  operation: request.operation,
                  rootFd: 3,
                  path: request.path,
                  expected: request.expected,
                }
              : (() => {
                  throw new Error(`unsupported secure release I/O: ${request.operation}`);
                })();
    const result = spawnSync(
      trustedPythonExecutable,
      ['-I', '-B', '-c', helper.toString('utf8')],
      {
        input: JSON.stringify(pythonRequest),
        encoding: 'utf8',
        env: safeEnvironment(testing),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', descriptor],
        maxBuffer: 128 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout || 'null');
    } catch {
      parsed = null;
    }
    if (result.error || result.status !== 0 || parsed?.ok !== true) {
      throw new Error(
        `descriptor-relative release I/O failed: ${
          parsed?.error ?? result.error?.message ?? result.stderr.trim()
        }`,
      );
    }
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}
