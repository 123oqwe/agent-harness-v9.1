/**
 * AH-SANDBOX-OCI-001: Optional rootless OCI sandbox adapter.
 * Executes commands in rootless OCI containers when a runtime is available.
 * Falls back to typed unavailable when no OCI runtime is detected.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ToolResult } from './types.js';
import { ToolUnavailableError } from './types.js';

interface OciSandboxConfig {
  image: string;
  command: string[];
  workspace_mount: string;
  network?: boolean;
  memory_limit_mb?: number;
  cpus?: number;
  pids_limit?: number;
  timeout_ms?: number;
  toolchain_mount?: string;
}

export async function runInOciSandbox(config: OciSandboxConfig): Promise<ToolResult> {
  const runtime = detectOciRuntime();
  if (!runtime) {
    throw new ToolUnavailableError(
      'no OCI runtime (podman/crun/runc) available',
      'oci_sandbox',
      'provider_unavailable',
    );
  }
  const args: string[] = [];
  if (runtime === 'podman') {
    args.push('run', '--rm', '--read-only');
    if (!config.network) args.push('--network=none');
    args.push('--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--userns=keep-id');
    args.push('--mount', `type=bind,source=${config.workspace_mount},target=/workspace`);
    if (config.toolchain_mount) {
      args.push('--mount', `type=bind,source=${config.toolchain_mount},target=${config.toolchain_mount},ro`);
    }
    if (config.memory_limit_mb) args.push('--memory', `${config.memory_limit_mb}m`);
    if (config.cpus) args.push('--cpus', String(config.cpus));
    if (config.pids_limit) args.push('--pids-limit', String(config.pids_limit));
    args.push(config.image, ...config.command);
  } else {
    args.push('run', '--rm', '--read-only');
    if (!config.network) args.push('--network', 'none');
    args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
    args.push('-v', `${config.workspace_mount}:/workspace`);
    if (config.toolchain_mount) {
      args.push('-v', `${config.toolchain_mount}:${config.toolchain_mount}:ro`);
    }
    if (config.memory_limit_mb) args.push('--memory', `${config.memory_limit_mb}m`);
    if (config.cpus) args.push('--cpus', String(config.cpus));
    if (config.pids_limit) args.push('--pids-limit', String(config.pids_limit));
    args.push(config.image, ...config.command);
  }
  const result = spawnSync(runtime, args, {
    encoding: 'utf8',
    timeout: config.timeout_ms ?? 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    return { success: false, output: null, error: `OCI execution failed: ${result.error.message}` };
  }
  return {
    success: result.status === 0,
    output: { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, runtime },
    error: result.status === 0 ? undefined : `OCI container exited with code ${result.status}`,
  };
}

function detectOciRuntime(): string | null {
  for (const rt of ['podman', 'crun', 'runc']) {
    try {
      const which = spawnSync('which', [rt], { encoding: 'utf8', timeout: 5000 });
      if (which.status === 0 && which.stdout.trim()) return rt;
      if (existsSync(`/usr/bin/${rt}`) || existsSync(`/usr/local/bin/${rt}`)) return rt;
    } catch { /* continue */ }
  }
  return null;
}
