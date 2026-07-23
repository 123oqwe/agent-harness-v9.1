import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, type SandboxConfig } from '../../runtime/sandbox.js';

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

describe('AH-SANDBOX-001: network deny-by-default', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = new Sandbox(cfg());
  });

  it('rejects execution when network is denied and tool requires network', () => {
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
    })).toThrow(/network|denied/i);
  });

  it('allows execution when network is denied but tool does not require network', () => {
    const result = sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('network denied is the default', () => {
    const s = new Sandbox({
      allowedExecutables: ['/bin/echo'],
      workingDirectory: mkdtempSync(join(tmpdir(), 'sandbox-test-')),
      envAllowlist: ['PATH'],
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    });
    // Should deny network by default
    expect(() => s.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
    })).toThrow(/network|denied/i);
  });
});
