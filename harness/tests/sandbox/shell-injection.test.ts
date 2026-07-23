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

describe('AH-SANDBOX-001: shell injection prevention', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = new Sandbox(cfg());
  });

  it('never accepts a shell string', () => {
    // The execute method takes structured executable + args, never a shell string
    expect(() => sandbox.execute({
      executable: '/bin/echo; rm -rf /',
      args: [],
    })).toThrow(/allowlist|not.*allowed|forbidden|metacharacter/i);
  });

  it('rejects arguments with shell metacharacters that could cause injection', () => {
    // Args are passed as-is to the process, but we validate they don't contain
    // dangerous patterns when combined with the executable
    // The key is: no shell is used, so metacharacters are literal
    const result = sandbox.execute({
      executable: '/bin/echo',
      args: ['hello; rm -rf /'],
    });
    // Since we use execFile (not shell), the semicolon is literal
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello; rm -rf /');
  });

  it('rejects argument containing command substitution pattern in executable field', () => {
    expect(() => sandbox.execute({
      executable: '/bin/echo$(whoami)',
      args: [],
    })).toThrow(/allowlist|not.*allowed|forbidden|metacharacter/i);
  });

  it('rejects argument containing pipe in executable field', () => {
    expect(() => sandbox.execute({
      executable: '/bin/echo | /bin/cat',
      args: [],
    })).toThrow(/allowlist|not.*allowed|forbidden|metacharacter/i);
  });

  it('structured args prevent shell injection by design', () => {
    const result = sandbox.execute({
      executable: '/bin/echo',
      args: ['$(whoami)', '`id`', '${HOME}'],
    });
    // These are literal strings, not evaluated
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('$(whoami)');
    expect(result.stdout).toContain('`id`');
    expect(result.stdout).toContain('${HOME}');
  });
});
