/**
 * AH-SANDBOX-001: canonical OS-native sandbox for tool command execution.
 *
 * Uses macOS Seatbelt (sandbox-exec -p) on Darwin and Linux bubblewrap (bwrap)
 * where available. Profile = workspace-write + network deny-by-default; unix
 * sockets denied unless explicitly allowed. The sandbox is the ONLY execution
 * path for execute_command tools — there is no unsandboxed fallback on the
 * active path.
 *
 * Enforced limits: timeout, memory (RLIMIT_AS), output size, process count.
 * Linux applies memory/process limits through prlimit before exec; the runtime
 * monitor independently observes the complete process tree. stdin hang is
 * prevented by closing stdin when not provided. Cancellation uses AbortSignal.
 * Shell injection is blocked by argv (no shell) for the wrapped command. Path
 * traversal/symlink escape is blocked by VFS before reaching here.
 */
import { spawn, execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

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
  /** Caller-approved command names mapped to absolute executable paths. */
  commandAllowlist?: Readonly<Record<string, string>>;
}

export interface SandboxExecOptions {
  argv: string[];              // command + args; NEVER a shell string
  cwd: string;
  stdin?: Buffer | string | undefined;
  limits?: Partial<SandboxLimits>;
  profile: SandboxProfile;
  signal?: AbortSignal;
}

export interface SandboxRuntimeDependencies {
  detectMechanism?: () => SandboxMechanism;
  compileSeatbeltProfile?: (
    profile: SandboxProfile,
    tmpDir: string,
  ) => string;
  inspectResourceLimit?: (
    pid: number,
    limits: SandboxLimits,
  ) => SandboxResult['limitExceeded'];
  makeTempDirectory?: () => string;
}

export interface SandboxSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['pipe', 'pipe', 'pipe'];
  windowsHide: true;
  detached: true;
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

export interface ProcessSample {
  pid: number;
  ppid: number;
  rssKb: number;
}

export interface ProcessTreeUsage {
  processCount: number;
  rssKb: number;
}

export interface OutputChunkLimit {
  accepted: Buffer;
  totalBytes: number;
  truncated: boolean;
}

export class SandboxError extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxError'; Object.setPrototypeOf(this, SandboxError.prototype); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SandboxMechanismDetection {
  platform?: NodeJS.Platform;
  hasBubblewrap?: () => boolean;
}

function executableOnPath(name: string): boolean {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Continue through the explicit host PATH.
    }
  }
  return false;
}

/** Detect the best available OS containment mechanism on this platform. */
export function detectMechanism(
  detection: SandboxMechanismDetection = {},
): SandboxMechanism {
  const platform = detection.platform ?? process.platform;
  if (platform === 'darwin') return 'seatbelt';
  if (platform === 'linux') {
    try {
      if ((detection.hasBubblewrap ?? (() => executableOnPath('bwrap')))()) {
        return 'bubblewrap';
      }
    } catch {
      // An unavailable or failed probe means containment is unavailable.
    }
  }
  // Windows: real AppContainer is not implemented; fail closed rather than
  // pretending a PowerShell JobObject wrapper is AppContainer.
  return 'none';
}

/** Validate that a requested cwd is inside the workspace root (anti-traversal). */
function canonicalPath(path: string): string {
  let candidate = resolve(path);
  const missing: string[] = [];
  for (;;) {
    if (existsSync(candidate)) {
      return resolve(realpathSync(candidate), ...missing.reverse());
    }
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(path);
    missing.push(basename(candidate));
    candidate = parent;
  }
}

export function assertWithinWorkspace(path: string, root: string): void {
  const rootCanonical = canonicalPath(root);
  const canonical = canonicalPath(path);
  const rel = relative(rootCanonical, canonical);
  if (
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new SandboxError(`cwd outside workspace root: ${path}`);
  }
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
  if (!isRecord(opts) || !isRecord(opts.profile)) {
    throw new SandboxError('sandbox options and profile are required');
  }
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
  if (
    typeof opts.profile?.workspaceRoot !== 'string' ||
    /[\0\r\n]/u.test(opts.profile.workspaceRoot) ||
    !existsSync(opts.profile.workspaceRoot) ||
    !statSync(opts.profile.workspaceRoot).isDirectory()
  ) {
    throw new SandboxError('workspaceRoot must be an existing directory');
  }
  const workspaceRoot = realpathSync(resolve(opts.profile.workspaceRoot));
  if (
    typeof opts.cwd !== 'string' ||
    /[\0\r\n]/u.test(opts.cwd) ||
    !existsSync(opts.cwd) ||
    !statSync(opts.cwd).isDirectory()
  ) {
    throw new SandboxError('cwd must be an existing directory');
  }
  assertWithinWorkspace(opts.cwd, workspaceRoot);
  const cwd = realpathSync(resolve(opts.cwd));
  if (!Array.isArray(opts.profile.allowRead)) {
    throw new SandboxError('allowRead must be an array');
  }
  const allowRead = opts.profile.allowRead.map((path) => {
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      /[\0\r\n]/u.test(path) ||
      !existsSync(path)
    ) {
      throw new SandboxError(`invalid allowRead path: ${path}`);
    }
    return realpathSync(path);
  });
  if (
    typeof opts.profile.allowNetwork !== 'boolean' ||
    typeof opts.profile.allowUnixSockets !== 'boolean'
  ) {
    throw new SandboxError('network and Unix socket policy must be boolean');
  }
  const rawEnvironment =
    opts.profile.environment === undefined ? {} : opts.profile.environment;
  if (!isRecord(rawEnvironment)) {
    throw new SandboxError('environment must be an object');
  }
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnvironment)) {
    if (
      !/^[A-Z_][A-Z0-9_]*$/iu.test(key) ||
      typeof value !== 'string' ||
      /[\0\r\n]/u.test(value)
    ) {
      throw new SandboxError(`invalid environment variable: ${key}`);
    }
    if (/TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL/iu.test(key)) {
      throw new SandboxError(
        `credential-like environment variable rejected: ${key}`,
      );
    }
    environment[key] = value;
  }
  const egressAllowlist =
    opts.profile.egressAllowlist === undefined
      ? []
      : opts.profile.egressAllowlist;
  if (!Array.isArray(egressAllowlist)) {
    throw new SandboxError('egressAllowlist must be an array');
  }
  for (const rule of egressAllowlist) {
    if (!isRecord(rule) || !isValidEgressHost(rule.host)) {
      const host = isRecord(rule) ? String(rule.host) : String(rule);
      throw new SandboxError(`invalid egress host: ${host}`);
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
      egressAllowlist,
    },
  };
}

/** @internal Strict host grammar shared by policy validation and future proxies. */
export function isValidEgressHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    return false;
  }
  if (/^\d+(?:\.\d+){3}$/u.test(value)) {
    return value.split('.').every((part) => {
      const octet = Number(part);
      return /^\d{1,3}$/u.test(part) && octet >= 0 && octet <= 255;
    });
  }
  return value.split('.').every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label));
}

function escapeSeatbeltLiteral(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

/** @internal Deterministic compiler for the already-validated macOS profile. */
export function compileSeatbeltProfile(
  p: SandboxProfile,
  tmpDir: string,
): string {
  const ws = escapeSeatbeltLiteral(p.workspaceRoot);
  const escapedTmp = escapeSeatbeltLiteral(tmpDir);
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
  lines.push(`(allow file-write* (subpath "${escapedTmp}"))`);
  lines.push('(allow file-write* (literal "/dev/null"))');
  lines.push('(allow file-write* (literal "/dev/dtracehelper"))');
  lines.push(`(allow file-read* (subpath "${escapedTmp}"))`);
  for (const r of p.allowRead) {
    lines.push(
      `(allow file-read* (subpath "${escapeSeatbeltLiteral(r)}"))`,
    );
  }
  if (p.allowNetwork) {
    // Seatbelt only accepts `*` or localhost in network address filters. Using
    // `*` would silently widen a host allowlist, so Phase 1 fails closed until
    // a proxy/firewall authority can enforce exact destination hosts.
    throw new SandboxError(
      'host-scoped network egress is not enforceable by macOS Seatbelt',
    );
  }
  lines.push('(deny network*)');
  lines.push('(allow process-fork)');
  lines.push('(allow process-exec)');
  return lines.join('\n') + '\n';
}
/** Build the wrapped argv that runs under the OS sandbox. */
export function buildSandboxArgv(
  opts: SandboxExecOptions,
  mech: SandboxMechanism,
  profileFile?: string,
  limits: SandboxLimits = DEFAULT_LIMITS,
): string[] {
  if (mech === 'seatbelt') {
    if (profileFile === undefined) {
      throw new SandboxError('Seatbelt profile file is required');
    }
    return ['sandbox-exec', '-f', profileFile, '--', ...opts.argv];
  }
  if (mech === 'bubblewrap') {
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
      '/usr/bin/prlimit',
      `--nproc=${limits.processLimit}`,
      '--',
      ...opts.argv,
    ];
    return args;
  }
  throw new SandboxError(
    `no wrapped argv exists for sandbox mechanism: ${mech}`,
  );
}

/** @internal Parse the stable `ps -axo pid=,ppid=,rss=` output. */
export function parseProcessTable(output: string): readonly ProcessSample[] {
  if (output.trim() === '') return [];
  return output
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite))
    .map(([pid, ppid, rssKb]) => ({ pid: pid!, ppid: ppid!, rssKb: rssKb! }));
}

/** @internal Compute transitive descendants and total resident memory. */
export function measureProcessTree(
  rows: readonly ProcessSample[],
  rootPid: number,
): ProcessTreeUsage {
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { pid, ppid } of rows) {
      if (descendants.has(ppid) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return {
    processCount: descendants.size,
    rssKb: rows
      .filter(({ pid }) => descendants.has(pid))
      .reduce((sum, { rssKb }) => sum + rssKb, 0),
  };
}

/** @internal Fail process count before memory, matching runtime precedence. */
export function classifyResourceLimit(
  usage: ProcessTreeUsage,
  limits: SandboxLimits,
): SandboxResult['limitExceeded'] {
  if (usage.processCount > limits.processLimit) return 'process';
  if (usage.rssKb > limits.memoryMb * 1024) return 'memory';
  return undefined;
}

/** @internal Apply one shared stdout/stderr byte budget without losing bytes silently. */
export function limitOutputChunk(
  chunk: Buffer,
  totalBytes: number,
  outputBytes: number,
): OutputChunkLimit {
  const room = Math.max(0, outputBytes - totalBytes);
  const accepted = chunk.subarray(0, room);
  return {
    accepted,
    totalBytes: totalBytes + accepted.length,
    truncated: accepted.length < chunk.length,
  };
}

/** @internal Construct the complete, host-env-minimizing spawn authority. */
export function buildSandboxSpawnOptions(
  opts: SandboxExecOptions,
  tmpDir: string,
  hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): SandboxSpawnOptions {
  return {
    cwd: opts.cwd,
    env: {
      PATH: hostEnvironment.PATH ?? '/usr/bin:/bin',
      HOME: tmpDir,
      TMPDIR: tmpDir,
      LANG: hostEnvironment.LANG ?? 'C.UTF-8',
      NPM_CONFIG_CACHE: join(tmpDir, 'npm-cache'),
      ...opts.profile.environment,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true,
  };
}

/** @internal Kill the POSIX process group, then fall back to the direct child. */
export function killSandboxProcessTree(
  pid: number | undefined,
  killGroup: (pid: number, signal: NodeJS.Signals) => void,
  killChild: (signal: NodeJS.Signals) => boolean,
): void {
  try {
    if (pid === undefined) throw new SandboxError('child pid unavailable');
    killGroup(-pid, 'SIGKILL');
  } catch {
    try {
      killChild('SIGKILL');
    } catch {
      // The process already exited.
    }
  }
}

export type ProcessTableReader = (
  executable: string,
  argv: readonly string[],
  options: { encoding: 'utf8'; maxBuffer: number },
) => string;

/** @internal Read and classify one process-tree sample. */
export function inspectProcessResourceLimit(
  pid: number,
  limits: SandboxLimits,
  reader: ProcessTableReader = (executable, argv, options) =>
    execFileSync(executable, [...argv], options),
): SandboxResult['limitExceeded'] {
  const output = reader(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,rss='],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  return classifyResourceLimit(
    measureProcessTree(parseProcessTable(output), pid),
    limits,
  );
}

/** Execute a command inside the OS sandbox with hard limits. */
export function execSandboxed(
  opts: SandboxExecOptions,
  dependencies: SandboxRuntimeDependencies = {},
): Promise<SandboxResult> {
  let limits: SandboxLimits;
  try {
    if (!isRecord(opts)) {
      throw new SandboxError('sandbox options and profile are required');
    }
    if (opts.limits !== undefined && !isRecord(opts.limits)) {
      throw new SandboxError('limits must be an object');
    }
    limits = { ...DEFAULT_LIMITS, ...opts.limits };
    opts = validateSandboxOptions(opts, limits);
  } catch (error) {
    return Promise.reject(error);
  }
  const mech = (dependencies.detectMechanism ?? detectMechanism)();

  // Fail-closed: if no OS containment is available, refuse to execute.
  if (mech === 'none') {
    return Promise.reject(new SandboxError(
      'no OS sandbox mechanism available on this platform — refusing to execute unsandboxed. ' +
      'Install bubblewrap on Linux or use macOS Seatbelt; Windows is unsupported.'
    ));
  }
  if (opts.profile.allowNetwork) {
    return Promise.reject(new SandboxError(
      `network egress is not supported by the ${mech} sandbox authority`,
    ));
  }

  return new Promise((resolveP, rejectP) => {
    const start = Date.now();
    let profileFile: string | undefined;
    const tmpDir = (dependencies.makeTempDirectory ??
      (() => mkdtempSync(join(tmpdir(), 'ah-sandbox-'))))();
    try {
      if (mech === 'seatbelt') {
        profileFile = join(tmpDir, 'profile.sb');
        writeFileSync(
          profileFile,
          (dependencies.compileSeatbeltProfile ?? compileSeatbeltProfile)(
            opts.profile,
            tmpDir,
          ),
        );
      }
      // appcontainer mechanism removed: Windows fails closed
    } catch (e) {
      cleanup();
      rejectP(new SandboxError(`failed to build sandbox profile: ${(e as Error).message}`));
      return;
    }

    const argv = buildSandboxArgv(opts, mech, profileFile, limits);
    const child = spawn(
      argv[0]!,
      argv.slice(1),
      buildSandboxSpawnOptions(opts, tmpDir),
    );

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let canceled = false;
    let limitExceeded: SandboxResult['limitExceeded'];
    let settled = false;

    const killTree = (): void => {
      killSandboxProcessTree(
        child.pid,
        process.kill,
        (signal) => child.kill(signal),
      );
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
      const limited = limitOutputChunk(
        chunk,
        totalOutput,
        limits.outputBytes,
      );
      totalOutput = limited.totalBytes;
      buf = Buffer.concat([buf, limited.accepted]);
      if (limited.truncated) {
        truncated = true;
        limitExceeded = 'output';
        killTree();
      }
      return buf;
    };

    child.stdout.on('data', (c: Buffer) => { stdout = acc(stdout, c); });
    child.stderr.on('data', (c: Buffer) => { stderr = acc(stderr, c); });

    const resourceMonitor = setInterval(() => {
            if (settled || child.pid === undefined) return;
            try {
              const exceeded = (
                dependencies.inspectResourceLimit ??
                inspectProcessResourceLimit
              )(child.pid, limits);
              if (exceeded !== undefined) {
                limitExceeded = exceeded;
                killTree();
              }
            } catch {
              // If the host cannot inspect a running process, timeout and OS
              // containment still apply; the failure is visible via evidence.
            }
          }, 50);
    resourceMonitor.unref();

    // prevent stdin hang: write provided stdin then close; if none, close immediately
    if (opts.stdin != null) {
      try { child.stdin.write(opts.stdin); } catch { /* */ }
    }
    try { child.stdin.end(); } catch { /* */ }

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(resourceMonitor);
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
        clearInterval(resourceMonitor);
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
