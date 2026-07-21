/** AH-TOOL-EXEC-001: execute_command_sandboxed tool. Runs via OS sandbox. */
import { execSandboxed, type SandboxProfile, type SandboxLimits } from '../runtime/sandbox.js';

export interface ExecCommandInput {
  argv: string[];
  cwd: string;
  stdin?: string;
  timeout_ms?: number;
}
export interface ExecCommandOutput {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
}

export async function executeCommand(
  profile: SandboxProfile,
  input: ExecCommandInput,
): Promise<ExecCommandOutput> {
  const limits: Partial<SandboxLimits> = input.timeout_ms ? { timeoutMs: input.timeout_ms } : {};
  const opts: Parameters<typeof execSandboxed>[0] = { argv: input.argv, cwd: input.cwd, profile, limits };
  if (input.stdin !== undefined) opts.stdin = input.stdin;
  const r = await execSandboxed(opts);
  return {
    exit_code: r.exitCode, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'),
    timed_out: r.timedOut, truncated: r.truncated, duration_ms: r.durationMs,
  };
}
