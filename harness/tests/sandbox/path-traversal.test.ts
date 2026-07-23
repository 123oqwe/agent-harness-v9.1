import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, type SandboxConfig } from '../../runtime/sandbox.js';

function cfg(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    allowedExecutables: ['/bin/echo', '/bin/cat', '/usr/bin/true'],
    workingDirectory: mkdtempSync(join(tmpdir(), 'sandbox-test-')),
    envAllowlist: ['PATH', 'HOME'],
    timeoutMs: 5000,
    maxOutputBytes: 1024 * 1024,
    networkDenied: true,
    ...overrides,
  };
}

describe('AH-SANDBOX-001: path traversal prevention', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = new Sandbox(cfg());
  });

  it('rejects executable path with ..', () => {
    expect(() => sandbox.execute({
      executable: '/bin/../etc/passwd',
      args: [],
    })).toThrow(/traversal|escape|\.\./i);
  });

  it('rejects executable path outside allowlist', () => {
    expect(() => sandbox.execute({
      executable: '/usr/bin/rm',
      args: ['-rf', '/'],
    })).toThrow(/allowlist|not.*allowed|forbidden/i);
  });

  it('rejects argument with path traversal in working directory context', () => {
    expect(() => sandbox.execute({
      executable: '/bin/cat',
      args: ['../../../etc/passwd'],
    })).toThrow(/traversal|escape|\.\./i);
  });

  it('rejects argument with absolute path outside working directory', () => {
    expect(() => sandbox.execute({
      executable: '/bin/cat',
      args: ['/etc/passwd'],
    })).toThrow(/outside|boundary|working.*dir/i);
  });
});
