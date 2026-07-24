/**
 * AH-SANDBOX-001: OS-native sandbox for tool command execution.
 *
 * Uses macOS Seatbelt (sandbox-exec -p) on Darwin and Linux bubblewrap (bwrap)
 * where available. Profile = workspace-write + network deny-by-default; unix
 * sockets denied unless explicitly allowed. The sandbox is the ONLY execution
 * path for execute_command tools — there is no unsandboxed fallback on the
 * active path.
 *
 * Enforced limits: timeout, memory (RLIMIT_AS/ulimit -v), output size, process
 * count. stdin hang prevented by closing stdin when not provided. Cancellation
 * via AbortSignal. Shell injection blocked by argv (no shell) for the wrapped
 * command. Path traversal/symlink escape blocked by VFS before reaching here.
 */
import { spawn, execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, relative } from 'node:path';

export type SandboxMechanism = 'seatbelt' | 'bubblewrap' | 'appcontainer' | 'none';

export interface SandboxLimits {
  timeoutMs: number;
  memoryMb: number;
  outputBytes: number;
  processLimit: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  memoryMb: 256,
  outputBytes: 1_024 * 1_024,
  processLimit: 32,
};

export interface EgressAllowRule { host: string }

export interface SandboxProfile {
  workspaceRoot: string;       // the only directory tree writable
  allowNetwork: boolean;       // default false
  allowUnixSockets: boolean;   // default false
  allowRead: string[];         // extra readable paths
  egressAllowlist?: EgressAllowRule[];
  /** Explicit non-secret variables exposed to the child. Host env is not inherited. */
  environment?: Readonly<Record<string, string>>;
}

export interface SandboxExecOptions {
  argv: string[];              // command + args; NEVER a shell string
  cwd: string;
  stdin?: Buffer | string | undefined;
  limits?: Partial<SandboxLimits>;
  profile: SandboxProfile;
  signal?: AbortSignal;
}

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  canceled: boolean;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  mechanism: SandboxMechanism;
  durationMs: number;
  limitExceeded?: 'memory' | 'process' | 'output';
}

export class SandboxError extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxError'; Object.setPrototypeOf(this, SandboxError.prototype); }
}

const isDarwin = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

/** Detect the best available OS containment mechanism on this platform. */
export function detectMechanism(): SandboxMechanism {
  if (isDarwin) return 'seatbelt';
  if (isLinux) {
    try { execSync('command -v bwrap', { stdio: 'ignore' }); return 'bubblewrap'; } catch { /* fall through */ }
  }
  // Windows: real AppContainer is not implemented; fail closed rather than
  // pretending a PowerShell JobObject wrapper is AppContainer.
  return 'none';
}

/** Validate that a requested cwd is inside the workspace root (anti-traversal). */
export function assertWithinWorkspace(path: string, root: string): void {
  const rootAbsolute = resolve(root);
  const rootCanonical = existsSync(rootAbsolute)
    ? realpathSync(rootAbsolute)
    : rootAbsolute;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(path);
  const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
  const rel = relative(rootCanonical, canonical);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new SandboxError(`cwd outside workspace root: ${path}`);
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SandboxError(`${name} must be a positive safe integer`);
  }
}

function validateSandboxOptions(
  opts: SandboxExecOptions,
  limits: SandboxLimits,
): SandboxExecOptions {
  if (
    !Array.isArray(opts.argv) ||
    opts.argv.length === 0 ||
    opts.argv.some(
      (arg) =>
        typeof arg !== 'string' ||
        arg.length === 0 ||
        arg.includes('\0'),
    )
  ) {
    throw new SandboxError('argv must be a non-empty array of safe strings');
  }
  if (!isAbsolute(opts.argv[0]!)) {
    throw new SandboxError('argv[0] must be an absolute executable path');
  }
  validatePositiveInteger('timeoutMs', limits.timeoutMs);
  validatePositiveInteger('memoryMb', limits.memoryMb);
  validatePositiveInteger('outputBytes', limits.outputBytes);
  validatePositiveInteger('processLimit', limits.processLimit);
  if (!existsSync(opts.profile.workspaceRoot)) {
    throw new SandboxError('workspaceRoot does not exist');
  }
  const workspaceRoot = realpathSync(resolve(opts.profile.workspaceRoot));
  assertWithinWorkspace(opts.cwd, workspaceRoot);
  const cwd = realpathSync(resolve(opts.cwd));
  const allowRead = opts.profile.allowRead.map((path) => {
    if (
      !isAbsolute(path) ||
      /[\0\r\n]/.test(path) ||
      !existsSync(path)
    ) {
      throw new SandboxError(`invalid allowRead path: ${path}`);
    }
    return realpathSync(path);
  });
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.profile.environment ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || value.includes('\0')) {
      throw new SandboxError(`invalid environment variable: ${key}`);
    }
    if (/TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL/i.test(key)) {
      throw new SandboxError(
        `credential-like environment variable rejected: ${key}`,
      );
    }
    environment[key] = value;
  }
  for (const rule of opts.profile.egressAllowlist ?? []) {
    if (
      !/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$/i.test(
        rule.host,
      )
    ) {
      throw new SandboxError(`invalid egress host: ${rule.host}`);
    }
  }
  return {
    ...opts,
    cwd,
    profile: {
      ...opts.profile,
      workspaceRoot,
      allowRead,
      environment,
    },
  };
}

function seatbeltProfile(p: SandboxProfile, tmpDir: string): string {
  const ws = p.workspaceRoot.replace(/"/g, '\\"');
  const lines: string[] = ['(version 1)', '(deny default)'];
  // allow self process control
  lines.push('(allow process-info* (target self))');
  lines.push('(allow signal (target self))');
  lines.push('(allow sysctl-read)');
  // macOS executables access system resources through paths that are not
  // stable API. Permit reads, then carve out user/volume/temp data; explicit
  // workspace and allowRead rules below re-open only scoped roots.
  lines.push('(allow file-read*)');
  lines.push('(deny file-read* (subpath "/Users"))');
  lines.push('(deny file-read* (subpath "/Volumes"))');
  lines.push('(deny file-read* (subpath "/private/var/folders"))');
  lines.push('(deny file-read* (subpath "/etc/ssh"))');
  lines.push('(deny file-read* (subpath "/etc/ssl/private"))');
  lines.push('(deny file-read* (literal "/etc/passwd"))');
  lines.push('(deny file-read* (literal "/etc/master.passwd"))');
  lines.push('(deny file-read* (literal "/etc/shadow"))');
  lines.push('(deny file-read* (literal "/private/etc/passwd"))');
  lines.push('(deny file-read* (literal "/private/etc/master.passwd"))');
  lines.push('(deny file-read* (literal "/private/etc/shadow"))');
  lines.push(`(allow file-read* (subpath "${ws}"))`);
  // workspace write only
  lines.push(`(allow file-write* (subpath "${ws}"))`);
  // temp dirs: only the sandbox's own temp dir
  lines.push(`(allow file-write* (subpath "${tmpDir.replace(/"/g, '\\"'  )}"))`);
  lines.push('(allow file-write* (literal "/dev/null"))');
  lines.push('(allow file-write* (literal "/dev/dtracehelper"))');
  lines.push(`(allow file-read* (subpath "${tmpDir.replace(/"/g, '\\"')}"))`);
  lines.push('(allow file-write* (literal "/dev/dtracehelper"))');
  for (const r of p.allowRead) lines.push(`(allow file-read* (subpath "${r.replace(/"/g, '\\"')}"))`);
  if (p.allowNetwork) {
    if (p.egressAllowlist && p.egressAllowlist.length > 0) {
      // Allow only specific hosts from the egress allowlist
      for (const rule of p.egressAllowlist) {
        lines.push(`(allow network-outbound (remote tcp "${rule.host}:443"))`);
        lines.push(`(allow network-outbound (remote tcp "${rule.host}:80"))`);
      }
      if (p.allowUnixSockets) lines.push('(allow network-local)');
      else lines.push('(deny network-local)');
    } else {
      // No allowlist = no network, even if allowNetwork is true
      lines.push('(deny network*)');
    }
  } else {
    lines.push('(deny network*)');
  }
  lines.push('(allow process-fork)');
  lines.push('(allow process-exec)');
  return lines.join('\n') + '\n';
}


/** Windows: build a PowerShell wrapper that applies JobObject process/memory limits.
 *  Weaker than AppContainer but provides real OS-level process containment.
 *  Network denied by default; egress policy enforced separately by caller. */
function _windowsJobWrapper(opts: SandboxExecOptions, limits: SandboxLimits): { argv: string[]; profileFile: string } {
  const memBytes = limits.memoryMb * 1024 * 1024;
  const exe = (opts.argv[0] ?? 'cmd.exe').replace(/'/g, "''");
  const args = opts.argv.slice(1).map(a => a.replace(/'/g, "''")).join(' ');
  const cwd = opts.cwd.replace(/\\/g, '/').replace(/'/g, "''");
  const psLines = [
    "$ErrorActionPreference = 'Stop'",
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    `$psi.FileName = '${exe}'`,
    `$psi.Arguments = '${args}'`,
    '$psi.UseShellExecute = $false',
    '$psi.RedirectStandardOutput = $true',
    '$psi.RedirectStandardError = $true',
    '$psi.RedirectStandardInput = $true',
    `$psi.WorkingDirectory = '${cwd}'`,
    '$p = [System.Diagnostics.Process]::Start($psi)',
    `$p.MaxWorkingSet = ${memBytes}`,
    '$p.WaitForExit()',
    '[Console]::Out.Write($p.StandardOutput.ReadToEnd())',
    '[Console]::Error.Write($p.StandardError.ReadToEnd())',
    'exit $p.ExitCode',
  ].join('\n');
  const tmpDir = mkdtempSync(join(tmpdir(), 'ah-win-'));
  const profileFile = join(tmpDir, 'sandbox.ps1');
  writeFileSync(profileFile, psLines);
  return { argv: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', profileFile], profileFile };
}

/** Build the wrapped argv that runs under the OS sandbox. */
function buildWrappedArgv(opts: SandboxExecOptions, mech: SandboxMechanism, profileFile?: string, limits?: SandboxLimits): string[] {
  if (mech === 'seatbelt' && profileFile) {
    return ['sandbox-exec', '-f', profileFile, '--', ...opts.argv];
  }
  if (mech === 'bubblewrap') {
    const memMb = limits?.memoryMb ?? 256;
    const args = [
      'bwrap',
      '--unshare-all',
      '--new-session',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      ...['/usr', '/bin', '/sbin', '/lib', '/lib64']
        .filter(existsSync)
        .flatMap((path) => ['--ro-bind', path, path]),
      ...opts.profile.allowRead.flatMap((path) => ['--ro-bind', path, path]),
      '--bind', opts.profile.workspaceRoot, opts.profile.workspaceRoot,
      '--die-with-parent',
      '--hostname', 'sandbox',
      '--',
      '/bin/sh', '-c',
      'ulimit -v "$1" && ulimit -u "$2" && shift 2 && exec "$@"',
      '--',
      String(memMb * 1024),
      String(limits?.processLimit ?? 32),
      ...opts.argv,
    ];
    return args;
  }
  // appcontainer mechanism removed: Windows must use fail-closed (mechanism='none')
  return opts.argv;
}

/** Execute a command inside the OS sandbox with hard limits. */
export function execSandboxed(opts: SandboxExecOptions): Promise<SandboxResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  try {
    opts = validateSandboxOptions(opts, limits);
  } catch (error) {
    return Promise.reject(error);
  }
  const mech = detectMechanism();

  // Fail-closed: if no OS containment is available, refuse to execute.
  if (mech === 'none') {
    return Promise.reject(new SandboxError(
      'no OS sandbox mechanism available on this platform — refusing to execute unsandboxed. ' +
      'Install bubblewrap (Linux), use macOS (seatbelt), or Windows (JobObject fallback).'
    ));
  }

  return new Promise((resolveP, rejectP) => {
    const start = Date.now();
    let profileFile: string | undefined;
    const tmpDir = mkdtempSync(join(tmpdir(), 'ah-sandbox-'));
    try {
      if (mech === 'seatbelt') {
        profileFile = join(tmpDir, 'profile.sb');
        writeFileSync(profileFile, seatbeltProfile(opts.profile, tmpDir));
      }
      // appcontainer mechanism removed: Windows fails closed
    } catch (e) {
      cleanup();
      rejectP(new SandboxError(`failed to build sandbox profile: ${(e as Error).message}`));
      return;
    }

    const argv = buildWrappedArgv(opts, mech, profileFile, limits);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmpDir,
      TMPDIR: tmpDir,
      LANG: process.env.LANG ?? 'C.UTF-8',
      NPM_CONFIG_CACHE: join(tmpDir, 'npm-cache'),
      ...opts.profile.environment,
    };

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let canceled = false;
    let limitExceeded: SandboxResult['limitExceeded'];
    let settled = false;

    const killTree = (): void => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree();
    }, limits.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      canceled = true;
      killTree();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    let totalOutput = 0;
    const acc = (buf: Buffer, chunk: Buffer): Buffer => {
      const room = Math.max(0, limits.outputBytes - totalOutput);
      const accepted = chunk.subarray(0, room);
      totalOutput += accepted.length;
      buf = Buffer.concat([buf, accepted]);
      if (accepted.length < chunk.length || totalOutput >= limits.outputBytes) {
        truncated = true;
        limitExceeded = 'output';
        killTree();
      }
      return buf;
    };

    child.stdout.on('data', (c: Buffer) => { stdout = acc(stdout, c); });
    child.stderr.on('data', (c: Buffer) => { stderr = acc(stderr, c); });

    const resourceMonitor =
      process.platform === 'win32'
        ? undefined
        : setInterval(() => {
            if (settled || child.pid === undefined) return;
            try {
              const rows = execFileSync(
                '/bin/ps',
                ['-axo', 'pid=,ppid=,rss='],
                { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
              )
                .trim()
                .split('\n')
                .map((line) => line.trim().split(/\s+/).map(Number))
                .filter(
                  (row): row is [number, number, number] =>
                    row.length === 3 && row.every(Number.isFinite),
                );
              const descendants = new Set<number>([child.pid]);
              let changed = true;
              while (changed) {
                changed = false;
                for (const [pid, ppid] of rows) {
                  if (descendants.has(ppid) && !descendants.has(pid)) {
                    descendants.add(pid);
                    changed = true;
                  }
                }
              }
              const rssKb = rows
                .filter(([pid]) => descendants.has(pid))
                .reduce((sum, [, , rss]) => sum + rss, 0);
              if (descendants.size > limits.processLimit) {
                limitExceeded = 'process';
                killTree();
              } else if (rssKb > limits.memoryMb * 1024) {
                limitExceeded = 'memory';
                killTree();
              }
            } catch {
              // If the host cannot inspect a running process, timeout and OS
              // containment still apply; the failure is visible via evidence.
            }
          }, 50);
    resourceMonitor?.unref();

    // prevent stdin hang: write provided stdin then close; if none, close immediately
    if (opts.stdin != null) {
      try { child.stdin.write(opts.stdin); } catch { /* */ }
    }
    try { child.stdin.end(); } catch { /* */ }

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (resourceMonitor) clearInterval(resourceMonitor);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      cleanup();
      resolveP({
        exitCode,
        timedOut,
        canceled,
        stdout,
        stderr,
        truncated,
        mechanism: mech,
        durationMs: Date.now() - start,
        ...(limitExceeded === undefined ? {} : { limitExceeded }),
      });
    };

    child.on('error', (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (resourceMonitor) clearInterval(resourceMonitor);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        rejectP(new SandboxError(`spawn failed: ${err.message}`));
      }
    });
    child.on('close', (code) => finish(code));

    function cleanup() { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } }
  });
}

/** Convenience: run a shell-free command and return trimmed text. Throws on non-zero unless ignoreExit. */
export async function runSandboxedText(opts: SandboxExecOptions, ignoreExit = false): Promise<string> {
  const r = await execSandboxed(opts);
  if (!ignoreExit && r.exitCode !== 0 && !r.timedOut && !r.canceled) {
    throw new SandboxError(`exit ${r.exitCode}: ${r.stderr.toString('utf8').slice(0, 500)}`);
  }
  return r.stdout.toString('utf8');
}
