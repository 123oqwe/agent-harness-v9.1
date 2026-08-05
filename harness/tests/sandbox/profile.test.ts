import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSandboxProfile,
  detectPlatform,
  isNativeSandboxAvailable,
  type SandboxConfig,
} from '../../runtime/sandbox.js';

function cfg(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    allowedExecutables: ['/bin/echo'],
    workingDirectory: mkdtempSync(join(tmpdir(), 'sandbox-test-')),
    envAllowlist: ['PATH'],
    timeoutMs: 5000,
    maxOutputBytes: 1024 * 1024,
    networkDenied: true,
    ...overrides,
  };
}

describe('AH-SANDBOX-001: OS-level sandbox profile (P1-03)', () => {
  it('detectPlatform returns current platform', () => {
    const platform = detectPlatform();
    expect(['darwin', 'linux', 'win32', 'other']).toContain(platform);
  });

  it('generateSandboxProfile returns a profile for the current platform', () => {
    const profile = generateSandboxProfile(cfg());
    expect(profile.platform).toBeDefined();
    expect(profile.profile).toBeDefined();
  });

  it('macOS profile includes Seatbelt deny default and workspace write', () => {
    const workspace = '/tmp/test-workspace';
    const profile = generateSandboxProfile({
      ...cfg({ workingDirectory: workspace }),
    });
    if (profile.platform === 'darwin') {
      expect(profile.profile).toContain('(deny default)');
      expect(profile.profile).toContain(workspace);
      expect(profile.profile).toContain('(allow file-write*');
      expect(profile.wrapperCommand).toBeDefined();
      expect(profile.wrapperCommand![0]).toBe('sandbox-exec');
    }
  });

  it('macOS profile with network denied does not allow network', () => {
    const profile = generateSandboxProfile(cfg({ networkDenied: true }));
    if (profile.platform === 'darwin') {
      expect(profile.profile).not.toContain('(allow network-outbound)');
    }
  });

  it('macOS profile with network allowed includes network rules', () => {
    const profile = generateSandboxProfile(cfg({ networkDenied: false }));
    if (profile.platform === 'darwin') {
      expect(profile.profile).toContain('(allow network-outbound)');
    }
  });

  it('Linux profile includes bwrap with workspace bind', () => {
    const workspace = '/tmp/test-workspace';
    const profile = generateSandboxProfile({
      ...cfg({ workingDirectory: workspace }),
    });
    if (profile.platform === 'linux') {
      expect(profile.profile).toContain('bwrap');
      expect(profile.profile).toContain('--ro-bind');
      expect(profile.profile).toContain(workspace);
      expect(profile.wrapperCommand).toBeDefined();
      expect(profile.wrapperCommand![0]).toBe('bwrap');
    }
  });

  it('isNativeSandboxAvailable returns boolean without throwing', () => {
    expect(() => isNativeSandboxAvailable()).not.toThrow();
    expect(typeof isNativeSandboxAvailable()).toBe('boolean');
  });
});
