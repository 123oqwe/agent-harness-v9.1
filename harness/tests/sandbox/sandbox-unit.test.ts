import { describe, it, expect } from 'vitest';
import {
  detectMechanism, assertWithinWorkspace, SandboxError, DEFAULT_LIMITS,
} from '../../runtime/sandbox.js';

describe('AH-SANDBOX-001 unit-level mutation tests', () => {
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
