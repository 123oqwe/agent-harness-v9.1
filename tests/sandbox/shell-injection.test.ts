import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSandboxed, type SandboxProfile } from '../../sandbox/process-sandbox.js';

function ws(tmp: string): SandboxProfile {
  return { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
}

describe('AH-SANDBOX-001 shell injection blocked', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sbx-sh-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('argv mode does not interpret shell metacharacters', async () => {
    const r = await execSandboxed({
      argv: ['/bin/echo', 'a; rm -rf /'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe('a; rm -rf /');
  }, 10000);

  it('credentials stripped from child env', async () => {
    process.env.HACK_SECRET_TOKEN = 'leak-me';
    const r = await execSandboxed({
      argv: ['/bin/sh', '-c', 'echo "${HACK_SECRET_TOKEN:-none}"'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
    });
    expect(r.stdout.toString().trim()).toBe('none');
    delete process.env.HACK_SECRET_TOKEN;
  }, 10000);
});
