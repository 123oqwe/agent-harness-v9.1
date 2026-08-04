/**
 * AH-SANDBOX-OCI-001: Optional rootless OCI sandbox adapter.
 * Returns typed unavailable when no OCI runtime is configured.
 */
import { existsSync } from 'node:fs';
import type { ToolResult } from './types.js';
import { ToolUnavailableError } from './types.js';

interface OciSandboxConfig {
  image: string;
  command: string[];
  workspace_mount: string;
  network?: boolean;
  memory_limit_mb?: number;
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
  // OCI execution would go here — for now, return typed unavailable
  throw new ToolUnavailableError(
    `OCI runtime ${runtime} detected but execution not implemented`,
    'oci_sandbox',
    'not_implemented',
  );
}

function detectOciRuntime(): string | null {
  for (const rt of ['podman', 'crun', 'runc']) {
    try {
      if (existsSync(`/usr/bin/${rt}`) || existsSync(`/usr/local/bin/${rt}`)) return rt;
    } catch { /* continue */ }
  }
  return null;
}
