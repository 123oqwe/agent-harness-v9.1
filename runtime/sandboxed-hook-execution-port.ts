/**
 * Trusted external Hook execution boundary.
 *
 * This port never falls back to an ordinary child process. It accepts only the
 * repository's real Seatbelt or bubblewrap mechanisms, passes one JSON value
 * over stdin/stdout, mounts no Harness VFS, denies network and host env, and
 * relies on execSandboxed's detached process-group SIGKILL for cancellation.
 */
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type {
  RuntimeExternalHookRegistration,
  RuntimeHookExecutionPort,
  RuntimeHookHandlerInput,
  RuntimeHookHandlerResult,
} from './hook-port.js';
import {
  detectMechanism,
  execSandboxed,
  SandboxError,
  type SandboxMechanism,
  type SandboxResult,
} from '../sandbox/process-sandbox.js';

const MAX_JSON_BYTES = 256 * 1024;

function assertExecutable(path: string): string {
  if (!isAbsolute(path)) {
    throw new SandboxError('external hook executable must be absolute');
  }
  accessSync(path, constants.X_OK);
  return realpathSync(path);
}

function assertSource(path: string): string {
  if (!isAbsolute(path)) {
    throw new SandboxError('external hook source must be absolute');
  }
  const resolved = realpathSync(path);
  if (!statSync(resolved).isFile()) {
    throw new SandboxError('external hook source must be a regular file');
  }
  return resolved;
}

export function assertTrustedHookPlatform(
  mechanism: SandboxMechanism,
  platform: NodeJS.Platform,
): SandboxMechanism {
  if (mechanism === 'seatbelt') {
    if (platform !== 'darwin') {
      throw new SandboxError(
        'simulated Seatbelt is not a trusted Hook boundary',
      );
    }
    return mechanism;
  }
  if (mechanism === 'bubblewrap') {
    if (platform !== 'linux') {
      throw new SandboxError(
        'simulated bubblewrap is not a trusted Hook boundary',
      );
    }
    return mechanism;
  }
  throw new SandboxError(
    'no trusted external Hook sandbox with enforced file, network, env and process-tree isolation',
  );
}

function trustedMechanism(): SandboxMechanism {
  const mechanism = assertTrustedHookPlatform(detectMechanism(), process.platform);
  if (mechanism === 'seatbelt') {
    accessSync('/usr/bin/sandbox-exec', constants.X_OK);
  }
  return mechanism;
}

export function assertTrustedHookSandboxResult(
  expected: SandboxMechanism,
  actual: SandboxMechanism,
): void {
  if (
    !['seatbelt', 'bubblewrap'].includes(expected) ||
    actual !== expected
  ) {
    throw new SandboxError(
      `external Hook sandbox mechanism changed from ${expected} to ${actual}`,
    );
  }
}

/**
 * Validate the complete result returned by the canonical process sandbox.
 * Keeping this check as a pure boundary makes every fail-closed condition
 * independently testable while the active execution path always invokes it.
 */
export function assertTrustedHookExecutionResult(
  expectedMechanism: SandboxMechanism,
  result: SandboxResult,
): void {
  assertTrustedHookSandboxResult(expectedMechanism, result.mechanism);
  if (
    result.timedOut ||
    result.canceled ||
    result.truncated ||
    result.limitExceeded !== undefined ||
    result.exitCode !== 0
  ) {
    throw new SandboxError(
      `external Hook sandbox execution failed closed ` +
        `(mechanism=${result.mechanism}, exit=${String(result.exitCode)}, ` +
        `timeout=${String(result.timedOut)}, canceled=${String(result.canceled)}, ` +
        `truncated=${String(result.truncated)}, limit=${result.limitExceeded ?? 'none'})`,
    );
  }
}

function parseSingleJson(stdout: Buffer): RuntimeHookHandlerResult {
  if (stdout.byteLength === 0 || stdout.byteLength > MAX_JSON_BYTES) {
    throw new SandboxError(
      'external Hook returned an invalid JSON envelope size',
    );
  }
  try {
    return JSON.parse(stdout.toString('utf8')) as RuntimeHookHandlerResult;
  } catch {
    throw new SandboxError(
      'external Hook stdout must contain exactly one JSON value',
    );
  }
}

export class SandboxedHookExecutionPort implements RuntimeHookExecutionPort {
  async execute(
    registration: RuntimeExternalHookRegistration,
    input: RuntimeHookHandlerInput,
    signal: AbortSignal,
  ): Promise<RuntimeHookHandlerResult> {
    const expectedMechanism = trustedMechanism();
    const executable = assertExecutable(registration.execution.executable_path);
    const source = assertSource(registration.execution.source_path);
    if (
      executable !== realpathSync(process.execPath) ||
      registration.execution.argv.length !== 1 ||
      !isAbsolute(registration.execution.argv[0]!) ||
      realpathSync(registration.execution.argv[0]!) !== source
    ) {
      throw new SandboxError(
        'external Hook execution must use the trusted Node runtime with the reviewed source as its only argv',
      );
    }
    const sourceBytes = readFileSync(source);
    if (registration.trust === 'hash_reviewed') {
      const actualHash = createHash('sha256').update(sourceBytes).digest('hex');
      if (actualHash !== registration.content_hash) {
        throw new SandboxError('external Hook content hash mismatch');
      }
    }
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ah-external-hook-'));
    try {
      const stagedSource = join(workspaceRoot, 'reviewed-hook.mjs');
      writeFileSync(stagedSource, sourceBytes, { mode: 0o400 });
      const stdin = Buffer.from(JSON.stringify(input), 'utf8');
      if (stdin.byteLength > MAX_JSON_BYTES) {
        throw new SandboxError('external Hook input exceeds JSON limit');
      }
      const result = await execSandboxed({
        argv: [executable, '--preserve-symlinks-main', stagedSource],
        cwd: workspaceRoot,
        stdin,
        limits: {
          timeoutMs: registration.timeout_ms,
          outputBytes: MAX_JSON_BYTES,
          memoryMb: 256,
          processLimit: 16,
        },
        profile: {
          workspaceRoot,
          allowNetwork: false,
          allowUnixSockets: false,
          allowRead: [executable, dirname(executable)],
          environment: {},
          egressAllowlist: [],
        },
        signal,
      });
      assertTrustedHookExecutionResult(expectedMechanism, result);
      return parseSingleJson(result.stdout);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
}
