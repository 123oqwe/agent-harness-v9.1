import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, type SandboxConfig } from '../../runtime/sandbox.js';

function cfg(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    allowedExecutables: ['/bin/echo', '/bin/cat'],
    workingDirectory: mkdtempSync(join(tmpdir(), 'sandbox-test-')),
    envAllowlist: ['PATH'],
    timeoutMs: 5000,
    maxOutputBytes: 1024 * 1024,
    networkDenied: true,
    ...overrides,
  };
}

describe('AH-SANDBOX-001: symlink escape prevention', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = new Sandbox(cfg());
  });

  it('rejects arguments containing symlink-like traversal patterns', () => {
    expect(() => sandbox.execute({
      executable: '/bin/cat',
      args: ['link/../../../etc/shadow'],
    })).toThrow(/traversal|escape|\.\./i);
  });

  it('rejects executable that is a symlink to outside allowlist', () => {
    // A symlink could point to a different executable.
    // The sandbox should resolve and verify the real path.
    expect(() => sandbox.execute({
      executable: '/tmp/fake-echo',
      args: [],
    })).toThrow(/allowlist|not.*allowed|forbidden/i);
  });
});
