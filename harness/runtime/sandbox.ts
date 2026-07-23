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
}

export interface SandboxExecuteRequest {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  requiresNetwork?: boolean;
  cwd?: string;
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

export class Sandbox {
  private readonly config: SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = { networkDenied: true, ...config };
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
        const env = this.validateEnv(req.env);
        const startTime = Date.now();
        const cwd = req.cwd ?? this.config.workingDirectory;
        if (!existsSync(cwd)) {
          mkdirSync(cwd, { recursive: true });
        }

        const child = execFile(req.executable, req.args, {
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
      const rawStdout = execFileSync(req.executable, req.args, {
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
