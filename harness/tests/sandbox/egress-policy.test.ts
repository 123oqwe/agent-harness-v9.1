import { describe, it, expect } from 'vitest';
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
    networkDenied: false,
    ...overrides,
  };
}

describe('AH-SANDBOX-001: egress policy (P1-04)', () => {
  it('denies network target not in allowlist', () => {
    const sandbox = new Sandbox(cfg({
      egressPolicy: {
        mode: 'allowlist',
        domain_rules: [{ action: 'allow', host: 'api.openai.com' }],
      },
    }));
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: 'evil.com',
    })).toThrow(/egress policy denied/);
  });

  it('allows network target in allowlist', () => {
    const sandbox = new Sandbox(cfg({
      egressPolicy: {
        mode: 'allowlist',
        domain_rules: [{ action: 'allow', host: 'api.openai.com' }],
      },
    }));
    const result = sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: 'api.openai.com',
    });
    expect(result.exitCode).toBe(0);
  });

  it('denies target in denylist', () => {
    const sandbox = new Sandbox(cfg({
      egressPolicy: {
        mode: 'denylist',
        domain_rules: [{ action: 'deny', host: 'evil.com' }],
      },
    }));
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: 'evil.com',
    })).toThrow(/egress policy denied/);
  });
});

describe('AH-SANDBOX-001: SSRF protection (P1-04)', () => {
  it('blocks access to 10.x.x.x private range', () => {
    const sandbox = new Sandbox(cfg({ egressPolicy: { mode: 'open' } }));
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: '10.0.0.1',
    })).toThrow(/SSRF.*private/);
  });

  it('blocks access to 169.254.x.x link-local range', () => {
    const sandbox = new Sandbox(cfg({ egressPolicy: { mode: 'open' } }));
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: '169.254.169.254',
    })).toThrow(/SSRF.*private/);
  });

  it('blocks access to localhost', () => {
    const sandbox = new Sandbox(cfg({ egressPolicy: { mode: 'open' } }));
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: 'localhost',
    })).toThrow(/SSRF.*private/);
  });

  it('blocks access to 127.x.x.x loopback', () => {
    const sandbox = new Sandbox(cfg({ egressPolicy: { mode: 'open' } }));
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: '127.0.0.1',
    })).toThrow(/SSRF.*private/);
  });

  it('blocks access to 192.168.x.x private range', () => {
    const sandbox = new Sandbox(cfg({ egressPolicy: { mode: 'open' } }));
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: '192.168.1.1',
    })).toThrow(/SSRF.*private/);
  });

  it('allows public hostname when egress is open', () => {
    const sandbox = new Sandbox(cfg({ egressPolicy: { mode: 'open' } }));
    const result = sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      requiresNetwork: true,
      networkTarget: 'api.openai.com',
    });
    expect(result.exitCode).toBe(0);
  });
});
