import { describe, expect, it } from 'vitest';
import { runInOciSandbox, ToolUnavailableError } from '../../../packages/tools/src/index.js';

describe('AH-SANDBOX-OCI-001: Rootless OCI sandbox adapter with security hardening', () => {
  it('throws ToolUnavailableError with tool_name=oci_sandbox and reason=provider_unavailable when no runtime exists', async () => {
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
  });

  it('rejects empty image name by passing through to runtime detection (still unavailable)', async () => {
    await expect(runInOciSandbox({
      image: '', command: ['echo'], workspace_mount: '/tmp',
    })).rejects.toThrow(ToolUnavailableError);
  });

  it('rejects empty command array by passing through to runtime detection (still unavailable)', async () => {
    await expect(runInOciSandbox({
      image: 'alpine', command: [], workspace_mount: '/tmp',
    })).rejects.toThrow(ToolUnavailableError);
  });

  it('passes toolchain_mount and memory/cpu/pids limits through config without early validation errors', async () => {
    // These options are only used when a runtime IS available.
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
  });
});
