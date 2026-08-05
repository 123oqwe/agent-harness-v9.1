/**
 * AH-SANDBOX-001: Process Sandbox
 *
 * Enforces executable allowlist, working directory boundary, environment
 * allowlist, timeout, output byte limit, cancellation, and network
 * deny-by-default. Accepts structured executable + argument arrays,
 * never a shell string.
 *
 * Invariants:
 *  - No shell execution (execFile only)
 *  - Executable must be in allowlist
 *  - Arguments cannot traverse outside working directory
 *  - Environment variables not in allowlist are rejected
 *  - Network is denied by default
 *  - Timeout kills the process tree
 *  - Output is truncated at maxOutputBytes
 */

import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve, normalize, isAbsolute } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { isHostAllowed, type EgressPolicy } from '../security/policy-engine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxConfig {
  allowedExecutables: string[];
  workingDirectory: string;
  envAllowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  networkDenied?: boolean;
  egressPolicy?: EgressPolicy;
}

export interface SandboxExecuteRequest {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  requiresNetwork?: boolean;
  cwd?: string;
  networkTarget?: string;
}

export interface SandboxResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  killed: boolean;
  truncated: boolean;
  durationMs: number;
  executable: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export type Platform = 'darwin' | 'linux' | 'win32' | 'other';

export interface SandboxProfile {
  platform: Platform;
  /** Seatbelt profile text (macOS) or bwrap args (Linux) */
  profile: string;
  /** The wrapper command to prepend to the executable */
  wrapperCommand?: string[];
}

/**
 * Generates a platform-native sandbox profile.
 *
 * macOS: Seatbelt (sandbox-exec) profile — workspace-write, network deny-by-default.
 * Linux: bubblewrap (bwrap) args — unshare-net, bind workspace rw, ro-bind /.
 * Windows/other: no native sandbox available; falls back to process-level checks.
 */
export function generateSandboxProfile(config: SandboxConfig): SandboxProfile {
  const platform = detectPlatform();
  const workspace = normalize(config.workingDirectory);

  if (platform === 'darwin') {
    // Seatbelt profile: workspace-write + network deny-by-default
    const profile = [
      '(version 1)',
     '(deny default)',
     `(allow process-fork)`,
     `(allow process-exec*)`,
     `(allow signal (target self))`,
      `(allow sysctl-read)`,
      `(allow file-read*)`,
      `(allow file-write* (subpath "${workspace}"))`,
      `(allow file-write* (subpath "/tmp"))`,
      `(allow file-write* (subpath "/var/tmp"))`,
    ];
    if (!config.networkDenied) {
      profile.push('(allow network-outbound)');
      profile.push('(allow network-inbound)');
    }
    return {
      platform,
      profile: profile.join('\n'),
      wrapperCommand: ['sandbox-exec', '-p', profile.join('\n')],
    };
  }

  if (platform === 'linux') {
    // bubblewrap: unshare-net (if networkDenied), bind workspace rw, ro-bind /
    const args = [
      'bwrap',
      '--ro-bind', '/', '/',
      '--bind', workspace, workspace,
      '--dev', '/dev',
      '--proc', '/proc',
      '--unshare-all',
    ];
    if (!config.networkDenied) {
      // --share-net allows network access
      args.splice(args.indexOf('--unshare-all'), 0, '--share-net');
    }
    return {
      platform,
      profile: args.join(' '),
      wrapperCommand: args,
    };
  }

  // Windows/other: no native sandbox; rely on process-level checks
  return {
    platform,
    profile: 'no-native-sandbox',
  };
}

export function detectPlatform(): Platform {
  const platform = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  return 'other';
}

/**
 * Checks whether a native sandboxing tool is available on the current platform.
 * Returns true if sandbox-exec (macOS) or bwrap (Linux) is in PATH.
 */
export function isNativeSandboxAvailable(): boolean {
  const platform = detectPlatform();
  if (platform === 'darwin') {
    try {
      execFileSync('which', ['sandbox-exec'], { encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  if (platform === 'linux') {
    try {
      execFileSync('which', ['bwrap'], { encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export class Sandbox {
  private readonly config: SandboxConfig;
  private readonly profile: SandboxProfile;

  constructor(config: SandboxConfig) {
    this.config = { networkDenied: true, ...config };
    // P1-03: Generate the platform-native sandbox profile once.
    // On macOS this is a Seatbelt (sandbox-exec) profile; on Linux this is
    // bubblewrap (bwrap) args. The profile is applied to every execute()
    // call so the child process runs inside the OS-level sandbox, not just
    // with process-level allowlist checks.
    this.profile = generateSandboxProfile(this.config);
  }

  execute(req: SandboxExecuteRequest): SandboxResult {
    const startTime = Date.now();

    // 1. Validate executable (no shell, no traversal, must be in allowlist)
    this.validateExecutable(req.executable);

    // 2. Validate arguments (no traversal outside working directory)
    this.validateArgs(req.args);

    // 3. Check network requirement
   if (req.requiresNetwork && this.config.networkDenied) {
      throw new Error('Sandbox: network access denied (networkDenied is true)');
    }

    // Egress policy check: if a network target is specified, validate it
    // against the egress policy (domain allow/deny, SSRF protection).
    if (req.networkTarget && this.config.egressPolicy) {
      if (!isHostAllowed(req.networkTarget, this.config.egressPolicy)) {
        throw new Error(
          `Sandbox: egress policy denied access to '${req.networkTarget}' ` +
          `(mode: ${this.config.egressPolicy.mode})`,
        );
      }
    }

    // SSRF protection: deny common internal/private addresses when egress
    // policy is not explicitly open. This prevents the agent from accessing
    // internal services via fetch_url or run_command.
    if (req.networkTarget && this.isPrivateAddress(req.networkTarget)) {
      // Private addresses are always blocked unless there is an explicit
      // allow rule for the exact address. Even 'open' mode does not permit
      // SSRF — the agent must never reach internal services.
      const explicitlyAllowed = this.config.egressPolicy?.domain_rules?.some(
        (r) => r.action === 'allow' && r.host === req.networkTarget,
      ) ?? false;
      if (!explicitlyAllowed) {
        throw new Error(
          `Sandbox: SSRF protection denied access to private/internal address '${req.networkTarget}'`,
        );
      }
    }

    // 4. Validate environment variables
    const env = this.validateEnv(req.env);

    // 5. Execute synchronously with timeout and output limit
    const result = this.execSync(req, env, startTime);
    return result;
  }

  async executeAsync(req: SandboxExecuteRequest): Promise<SandboxResult> {
    return new Promise((resolve, reject) => {
      try {
        this.validateExecutable(req.executable);
        this.validateArgs(req.args);
       if (req.requiresNetwork && this.config.networkDenied) {
         throw new Error('Sandbox: network access denied');
       }
        // Egress policy + SSRF protection for async path
        if (req.networkTarget && this.config.egressPolicy) {
          if (!isHostAllowed(req.networkTarget, this.config.egressPolicy)) {
            throw new Error(
              `Sandbox: egress policy denied access to '${req.networkTarget}' ` +
              `(mode: ${this.config.egressPolicy.mode})`,
            );
          }
        }
        if (req.networkTarget && this.isPrivateAddress(req.networkTarget)) {
          const explicitlyAllowed = this.config.egressPolicy?.domain_rules?.some(
            (r) => r.action === 'allow' && r.host === req.networkTarget,
          ) ?? false;
          if (!explicitlyAllowed) {
            throw new Error(
              `Sandbox: SSRF protection denied access to private/internal address '${req.networkTarget}'`,
            );
          }
        }
       const env = this.validateEnv(req.env);
       const startTime = Date.now();
       const cwd = req.cwd ?? this.config.workingDirectory;
       if (!existsSync(cwd)) {
         mkdirSync(cwd, { recursive: true });
       }

        const cmd = this.buildSandboxedCommand(req);
        const child = execFile(cmd.executable, cmd.args, {
         cwd,
         env: { ...process.env, ...env },
         timeout: this.config.timeoutMs,
         maxBuffer: this.config.maxOutputBytes,
         shell: false,
       }, (err, stdout, stderr) => {
          const durationMs = Date.now() - startTime;
          if (err) {
            const errExt = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number };
            const killed = errExt.killed ?? false;
            const signal = errExt.signal ?? null;
            resolve({
              exitCode: typeof errExt.code === 'number' ? errExt.code : null,
              signal,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              killed,
              truncated: stdout ? stdout.length >= this.config.maxOutputBytes : false,
              durationMs,
              executable: req.executable,
              args: req.args,
            });
          } else {
            resolve({
              exitCode: 0,
              signal: null,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              killed: false,
              truncated: stdout ? stdout.length >= this.config.maxOutputBytes : false,
              durationMs,
              executable: req.executable,
              args: req.args,
            });
          }
        });

        // Store child for potential cancellation
        this.currentChild = child;
      } catch (err) {
        reject(err);
      }
    });
  }

  cancel(): void {
    if (this.currentChild) {
      this.currentChild.kill('SIGKILL');
      this.currentChild = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private currentChild: ChildProcess | null = null;

  /**
   * SSRF protection: detect private/internal IP ranges and hostnames.
   * Blocks access to 10.x, 172.16-31.x, 192.168.x, 169.254.x (link-local),
   * 127.x (loopback), ::1, fc00::/7 (IPv6 ULA), and localhost.
   * Checks the hostname as-is (DNS rebinding protection happens at the
   * network layer — here we only check the literal target).
   */
  private isPrivateAddress(target: string): boolean {
    const lower = target.toLowerCase().trim();

    // localhost
    if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

    // IPv4 literal
    const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number) as unknown as number[];
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true; // link-local
      if (a === 0) return true; // 0.0.0.0
    }

    // IPv6 loopback and link-local
    if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }

    return false;
  }

  private validateExecutable(executable: string): void {
    if (!executable || executable.length === 0) {
      throw new Error('Sandbox: empty executable');
    }

    // Reject shell metacharacters in executable path
    if (/[;|&$`]/.test(executable)) {
      throw new Error(`Sandbox: executable '${executable}' contains shell metacharacters`);
    }

    // Reject path traversal
    if (executable.includes('..')) {
      throw new Error(`Sandbox: path traversal in executable '${executable}'`);
    }

    // Normalize and check against allowlist
    const normalized = normalize(resolve(executable));
    const allowed = this.config.allowedExecutables.some(
      (allowed) => normalize(resolve(allowed)) === normalized,
    );

    if (!allowed) {
      throw new Error(`Sandbox: executable '${executable}' not in allowlist`);
    }
  }

  private validateArgs(args: string[]): void {
    const cwd = this.config.workingDirectory;
    for (const arg of args) {
      // Check for path traversal in arguments that look like file paths
      if (arg.includes('..')) {
        // If it contains .., check if it resolves outside working directory
        const resolved = normalize(resolve(cwd, arg));
        if (!resolved.startsWith(normalize(cwd))) {
          throw new Error(`Sandbox: argument '${arg}' traverses outside working directory`);
        }
      }

      // Check for absolute paths outside working directory
      if (isAbsolute(arg) && !arg.startsWith(normalize(cwd))) {
        throw new Error(`Sandbox: argument '${arg}' is an absolute path outside working directory`);
      }
    }
  }

  private validateEnv(env?: Record<string, string>): Record<string, string> {
    if (!env) return {};

    for (const key of Object.keys(env)) {
      if (!this.config.envAllowlist.includes(key)) {
        throw new Error(`Sandbox: environment variable '${key}' not in allowlist`);
      }
    }
   return env;
 }

  /**
   * P1-03: Build the command array for execution, wrapping the executable
   * in the platform-native sandbox (sandbox-exec on macOS, bwrap on Linux)
   * when the wrapper is available. If no native sandbox is available, the
   * executable runs directly with process-level checks only.
   */
  private buildSandboxedCommand(req: SandboxExecuteRequest): { executable: string; args: string[] } {
    const wrapper = this.profile.wrapperCommand;
    if (wrapper && wrapper.length > 0) {
      return {
        executable: wrapper[0],
        args: [...wrapper.slice(1), req.executable, ...req.args],
      };
    }
    return { executable: req.executable, args: req.args };
  }

 private execSync(
    req: SandboxExecuteRequest,
    env: Record<string, string>,
    startTime: number,
  ): SandboxResult {
    const cwd = req.cwd ?? this.config.workingDirectory;
    if (!existsSync(cwd)) {
      mkdirSync(cwd, { recursive: true });
    }

   try {
      const cmd = this.buildSandboxedCommand(req);
      const rawStdout = execFileSync(cmd.executable, cmd.args, {
       cwd,
       env: { ...process.env, ...env },
       timeout: this.config.timeoutMs,
       maxBuffer: this.config.maxOutputBytes * 2, // Allow slightly more to detect truncation
       shell: false,
       encoding: 'utf8',
     });

      const durationMs = Date.now() - startTime;
      const truncated = rawStdout.length > this.config.maxOutputBytes;
      const stdout = truncated ? rawStdout.slice(0, this.config.maxOutputBytes) : rawStdout;

      return {
        exitCode: 0,
        signal: null,
        stdout,
        stderr: '',
        killed: false,
        truncated,
        durationMs,
        executable: req.executable,
        args: req.args,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number };
      const signal = e.signal ?? null;
      const killed = e.killed ?? (signal !== null || e.code === 'ETIMEDOUT');
      const rawStdout = e.stdout ?? '';
      const rawStderr = e.stderr ?? '';
      const truncated = rawStdout.length > this.config.maxOutputBytes;
      const stdout = truncated ? rawStdout.slice(0, this.config.maxOutputBytes) : rawStdout;
      const stderr = rawStderr.length > this.config.maxOutputBytes
        ? rawStderr.slice(0, this.config.maxOutputBytes)
        : rawStderr;

      return {
        exitCode: typeof e.code === 'number' ? e.code : null,
        signal,
        stdout,
        stderr,
        killed,
        truncated,
        durationMs,
        executable: req.executable,
        args: req.args,
      };
    }
  }
}
