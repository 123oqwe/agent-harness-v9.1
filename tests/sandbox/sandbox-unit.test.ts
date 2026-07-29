import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectMechanism,
  assertWithinWorkspace,
  execSandboxed,
  SandboxError,
  DEFAULT_LIMITS,
} from '../../sandbox/process-sandbox.js';

describe('AH-SANDBOX-001 unit-level mutation tests', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
    delete process.env.AH_UNRELATED_HOST_VALUE;
  });
  it('detectMechanism returns a valid mechanism for the current platform', () => {
    const m = detectMechanism();
    expect(['seatbelt', 'bubblewrap', 'appcontainer', 'none']).toContain(m);
    if (process.platform === 'darwin') expect(m).toBe('seatbelt');
  });

  it('assertWithinWorkspace rejects absolute path outside root', () => {
    expect(() => assertWithinWorkspace('/etc/passwd', '/workspace')).toThrow(SandboxError);
  });

  it('assertWithinWorkspace rejects relative path that escapes', () => {
    expect(() => assertWithinWorkspace('../escape', '/workspace')).toThrow(SandboxError);
  });

  it('assertWithinWorkspace rejects sibling prefix', () => {
    expect(() => assertWithinWorkspace('/workspace-evil/file', '/workspace')).toThrow(SandboxError);
  });

  it('assertWithinWorkspace accepts path inside workspace', () => {
    expect(() => assertWithinWorkspace('/workspace/subdir/file', '/workspace')).not.toThrow();
  });

  it('assertWithinWorkspace accepts the workspace root itself', () => {
    expect(() => assertWithinWorkspace('/workspace', '/workspace')).not.toThrow();
  });

  it('assertWithinWorkspace resolves relative paths against cwd', () => {
    const origCwd = process.cwd;
    process.cwd = () => '/workspace';
    try {
      expect(() => assertWithinWorkspace('subdir/file', '/workspace')).not.toThrow();
    } finally {
      process.cwd = origCwd;
    }
  });

  it('assertWithinWorkspace rejects an existing symlink cwd escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-sandbox-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'ah-sandbox-outside-'));
    cleanup.push(root, outside);
    symlinkSync(outside, join(root, 'escape'));
    expect(() => assertWithinWorkspace(join(root, 'escape'), root)).toThrow(
      SandboxError,
    );
  });

  it('passes only the explicit safe environment allowlist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-sandbox-env-'));
    cleanup.push(root);
    process.env.AH_UNRELATED_HOST_VALUE = 'must-not-leak';
    const result = await execSandboxed({
      argv: [
        '/bin/sh',
        '-c',
        'printf "%s:%s" "${SAFE_VALUE:-none}" "${AH_UNRELATED_HOST_VALUE:-none}"',
      ],
      cwd: root,
      profile: {
        workspaceRoot: root,
        allowNetwork: false,
        allowUnixSockets: false,
        allowRead: [],
        environment: { SAFE_VALUE: 'visible' },
      },
    });
    expect(result.stdout.toString()).toBe('visible:none');
  });

  it('rejects credentials even when explicitly supplied as environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-sandbox-secret-'));
    cleanup.push(root);
    await expect(
      execSandboxed({
        argv: ['/bin/echo', 'no'],
        cwd: root,
        profile: {
          workspaceRoot: root,
          allowNetwork: false,
          allowUnixSockets: false,
          allowRead: [],
          environment: { API_KEY: 'secret' },
        },
      }),
    ).rejects.toThrow(/credential-like environment variable/);
  });

  it('rejects empty argv and invalid resource limits before spawning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-sandbox-input-'));
    cleanup.push(root);
    const profile = {
      workspaceRoot: root,
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: [],
    };
    await expect(
      execSandboxed({ argv: [], cwd: root, profile }),
    ).rejects.toThrow(/argv/);
    await expect(
      execSandboxed({
        argv: ['/bin/echo', 'no'],
        cwd: root,
        profile,
        limits: { timeoutMs: 0 },
      }),
    ).rejects.toThrow(/timeoutMs/);
  });

  it('DEFAULT_LIMITS values are correct', () => {
    expect(DEFAULT_LIMITS.timeoutMs).toBe(10_000);
    expect(DEFAULT_LIMITS.memoryMb).toBe(256);
    expect(DEFAULT_LIMITS.outputBytes).toBe(1_048_576);
    expect(DEFAULT_LIMITS.processLimit).toBe(32);
  });

  it('SandboxError has correct name and prototype', () => {
    const e = new SandboxError('test');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SandboxError);
    expect(e.name).toBe('SandboxError');
    expect(e.message).toBe('test');
  });

  it('SandboxError can be caught with instanceof', () => {
    try {
      throw new SandboxError('thrown');
    } catch (e) {
      expect(e instanceof SandboxError).toBe(true);
      expect((e as SandboxError).message).toBe('thrown');
    }
  });
});
