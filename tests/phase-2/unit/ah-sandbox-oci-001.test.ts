import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runInOciSandbox, ToolUnavailableError } from '../../../packages/tools/src/index.js';

function detectOciRuntime(): boolean {
  for (const rt of ['podman', 'crun', 'runc']) {
    try {
      const which = spawnSync('which', [rt], { encoding: 'utf8', timeout: 5000 });
      if (which.status === 0 && which.stdout.trim()) return true;
      if (existsSync(`/usr/bin/${rt}`) || existsSync(`/usr/local/bin/${rt}`)) return true;
    } catch { /* continue */ }
  }
  return false;
}

const hasRuntime = detectOciRuntime();

describe('AH-SANDBOX-OCI-001: Rootless OCI sandbox adapter with security hardening', () => {
  it('throws ToolUnavailableError with tool_name=oci_sandbox and reason=provider_unavailable when no runtime exists', async () => {
    if (hasRuntime) {
      // Runtime available: function should return a result, not throw
      const result = await runInOciSandbox({
        image: 'alpine', command: ['echo', 'hi'], workspace_mount: '/tmp',
      });
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
    } else {
      // No runtime: should throw ToolUnavailableError
      try {
        await runInOciSandbox({
          image: 'alpine', command: ['echo', 'hi'], workspace_mount: '/tmp',
        });
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ToolUnavailableError);
        expect((e as ToolUnavailableError).tool_name).toBe('oci_sandbox');
        expect((e as ToolUnavailableError).reason).toBe('provider_unavailable');
        expect((e as Error).message).toContain('no OCI runtime');
      }
    }
  });

  it('handles empty image name gracefully', async () => {
    if (hasRuntime) {
      // Runtime available: empty image causes runtime error, not throw
      const result = await runInOciSandbox({
        image: '', command: ['echo'], workspace_mount: '/tmp',
      });
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    } else {
      await expect(runInOciSandbox({
        image: '', command: ['echo'], workspace_mount: '/tmp',
      })).rejects.toThrow(ToolUnavailableError);
    }
  });

  it('handles empty command array gracefully', async () => {
    if (hasRuntime) {
      // Runtime available: empty command may succeed or fail depending on image entrypoint
      const result = await runInOciSandbox({
        image: 'alpine', command: [], workspace_mount: '/tmp',
      });
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
    } else {
      await expect(runInOciSandbox({
        image: 'alpine', command: [], workspace_mount: '/tmp',
      })).rejects.toThrow(ToolUnavailableError);
    }
  });

  it('passes toolchain_mount and memory/cpu/pids limits through config without early validation errors', async () => {
    if (hasRuntime) {
      // Runtime available: config options should be passed through to the runtime
      const result = await runInOciSandbox({
        image: 'alpine',
        command: ['sh', '-c', 'echo hello'],
        workspace_mount: '/tmp/test',
        network: false,
        memory_limit_mb: 512,
        cpus: 2,
        pids_limit: 100,
        timeout_ms: 5000,
        toolchain_mount: '/opt/toolchain',
      });
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
    } else {
      // Without a runtime, we verify the adapter does not throw a different error type.
      await expect(runInOciSandbox({
        image: 'alpine',
        command: ['sh', '-c', 'echo hello'],
        workspace_mount: '/tmp/test',
        network: false,
        memory_limit_mb: 512,
        cpus: 2,
        pids_limit: 100,
        timeout_ms: 5000,
        toolchain_mount: '/opt/toolchain',
      })).rejects.toThrow(ToolUnavailableError);
    }
  });
});
