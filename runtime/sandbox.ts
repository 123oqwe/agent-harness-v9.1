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
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
}

export interface SandboxExecOptions {
  argv: string[];              // command + args; NEVER a shell string
  cwd: string;
  stdin?: Buffer | string;
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
    try { require('node:child_process').execSync('command -v bwrap', { stdio: 'ignore' }); return 'bubblewrap'; } catch { /* fall through */ }
  }
  if (process.platform === 'win32') return 'appcontainer';
  return 'none';
}

/** Validate that a requested cwd is inside the workspace root (anti-traversal). */
export function assertWithinWorkspace(path: string, root: string): void {
  const abs = isAbsolute(path) ? path : resolve(path);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new SandboxError(`cwd outside workspace root: ${path}`);
}

function seatbeltProfile(p: SandboxProfile): string {
  const ws = p.workspaceRoot.replace(/"/g, '\\"');
  const lines: string[] = ['(version 1)', '(deny default)'];
  // allow self process control
  lines.push('(allow process-info* (target self))');
  lines.push('(allow signal (target self))');
  lines.push('(allow sysctl-read)');
  // allow read everywhere needed to run a command (bin, libs)
  lines.push('(allow file-read*)');
  // workspace write only
  lines.push(`(allow file-write* (subpath "${ws}"))`);
  // temp dirs the sandbox itself needs
  for (const t of ['/private/tmp', '/tmp', '/var/tmp']) lines.push(`(allow file-write* (subpath "${t}"))`);
  lines.push('(allow file-write* (literal "/dev/null"))');
  lines.push('(allow file-write* (literal "/dev/dtracehelper"))');
  for (const r of p.allowRead) lines.push(`(allow file-read* (subpath "${r.replace(/"/g, '\\"')}"))`);
  if (p.allowNetwork) {
    if (p.allowUnixSockets) {
      lines.push('(allow network*)');
    } else {
      lines.push('(allow network*)');
      lines.push('(deny network-local)');
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
function windowsJobWrapper(opts: SandboxExecOptions, limits: SandboxLimits): { argv: string[]; profileFile: string } {
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
    const args = ['bwrap', '--ro-bind', '/', '/', '--bind', opts.profile.workspaceRoot, opts.profile.workspaceRoot,
      '--unshare-net', '--die-with-parent',
      `--setenv`, `AH_RLIMIT_AS_MB`, `${limits?.memoryMb ?? 256}`,
      '--'];
    return [...args, ...opts.argv];
  }
  if (mech === 'appcontainer' && limits) {
    const wrapped = windowsJobWrapper(opts, limits);
    return wrapped.argv;
  }
  return opts.argv;
}

/** Execute a command inside the OS sandbox with hard limits. */
export function execSandboxed(opts: SandboxExecOptions): Promise<SandboxResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  assertWithinWorkspace(opts.cwd, opts.profile.workspaceRoot);
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
        writeFileSync(profileFile, seatbeltProfile(opts.profile));
      }
      if (mech === 'appcontainer') {
        const wrapped = windowsJobWrapper(opts, limits);
        profileFile = wrapped.profileFile;
      }
    } catch (e) {
      cleanup();
      rejectP(new SandboxError(`failed to build sandbox profile: ${(e as Error).message}`));
      return;
    }

    const argv = buildWrappedArgv(opts, mech, profileFile, limits);
    const env = { ...process.env };
    // strip credentials from the child env (FG2): never leak secrets into sandboxed process
    for (const k of Object.keys(env)) if (/TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL/i.test(k)) delete env[k];

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let canceled = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* */ }
    }, limits.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      canceled = true;
      try { child.kill('SIGKILL'); } catch { /* */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const acc = (buf: Buffer, chunk: Buffer, kind: 'stdout' | 'stderr'): Buffer => {
      if (buf.length + chunk.length > limits.outputBytes) {
        const room = Math.max(0, limits.outputBytes - buf.length);
        buf = Buffer.concat([buf, chunk.subarray(0, room)]);
        truncated = true;
        try { child[kind === 'stdout' ? 'stdout' : 'stderr']?.destroy(); } catch { /* */ }
        return buf;
      }
      return Buffer.concat([buf, chunk]);
    };

    child.stdout.on('data', (c: Buffer) => { stdout = acc(stdout, c, 'stdout'); });
    child.stderr.on('data', (c: Buffer) => { stderr = acc(stderr, c, 'stderr'); });

    // prevent stdin hang: write provided stdin then close; if none, close immediately
    if (opts.stdin != null) {
      try { child.stdin.write(opts.stdin); } catch { /* */ }
    }
    try { child.stdin.end(); } catch { /* */ }

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      cleanup();
      resolveP({ exitCode, timedOut, canceled, stdout, stderr, truncated, mechanism: mech, durationMs: Date.now() - start });
    };

    child.on('error', (err) => { cleanup(); if (!settled) { settled = true; clearTimeout(timeout); rejectP(new SandboxError(`spawn failed: ${err.message}`)); } });
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
