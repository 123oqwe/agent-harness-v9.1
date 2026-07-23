import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, type SandboxConfig } from '../../runtime/sandbox.js';

function cfg(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    allowedExecutables: ['/bin/echo', '/bin/sleep'],
    workingDirectory: mkdtempSync(join(tmpdir(), 'sandbox-test-')),
    envAllowlist: ['PATH'],
    timeoutMs: 100,
    maxOutputBytes: 100,
    networkDenied: true,
    ...overrides,
  };
}

describe('AH-SANDBOX-001: resource limits', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = new Sandbox(cfg());
  });

  it('enforces timeout and kills process', () => {
    const result = sandbox.execute({
      executable: '/bin/sleep',
      args: ['10'],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.killed).toBe(true);
    expect(result.signal).toBeTruthy();
  });

  it('enforces output byte limit', () => {
    const result = sandbox.execute({
      executable: '/bin/echo',
      args: ['A'.repeat(200)],
    });
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });

  it('rejects environment variables not in allowlist', () => {
    expect(() => sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      env: { SECRET_KEY: 'leaked' },
    })).toThrow(/env|allowlist|not.*allowed/i);
  });

  it('allows environment variables in allowlist', () => {
    const result = sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('records normalized result with timing', () => {
    const result = sandbox.execute({
      executable: '/bin/echo',
      args: ['hello'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.executable).toBe('/bin/echo');
    expect(result.args).toEqual(['hello']);
  });
});
