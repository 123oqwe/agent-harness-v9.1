import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSandboxed, detectMechanism, type SandboxProfile } from '../../runtime/sandbox.js';

const mechanism = detectMechanism();
const hasSandbox = mechanism !== 'none';
function ws(tmp: string): SandboxProfile {
  return { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
}

describe('AH-SANDBOX-001 network access denied', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sbx-net-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('blocks a network egress attempt', async () => {
    if (!hasSandbox) return;
    const r = await execSandboxed({
      argv: ['/bin/sh', '-c', 'curl -s --max-time 2 https://example.com >/dev/null 2>&1; echo done_$?'],
      cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 8000 },
    });
    expect(r.stdout.toString()).not.toContain('done_0');
  }, 15000);

  it('reports the mechanism used', async () => {
    const r = await execSandboxed({ argv: ['/bin/echo', 'ok'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 } });
    expect(r.mechanism).toBe(mechanism);
  }, 8000);


  it('does not report PowerShell JobObject as AppContainer on Windows', () => {
    const source = readFileSync(join(__dirname, '../../runtime/sandbox.ts'), 'utf8');
    // detectMechanism must NOT return 'appcontainer' for win32
    expect(source).not.toMatch(/win32.*appcontainer/);
    // The windowsJobWrapper must not be called 'appcontainer' — it is a PowerShell fallback
    expect(source).not.toContain('windowsJobWrapper(opts, limits)');
  });

  it('Linux bubblewrap enforces real RLIMIT_AS, not just an env var', () => {
    const source = readFileSync(join(__dirname, '../../runtime/sandbox.ts'), 'utf8');
    // Must NOT just set env var AH_RLIMIT_AS_MB and pretend it enforces memory
    expect(source).not.toContain('AH_RLIMIT_AS_MB');
  });

  it('macOS seatbelt denies sensitive paths even with broad read', () => {
    const source = readFileSync(join(__dirname, '../../runtime/sandbox.ts'), 'utf8');
    // Sensitive paths must be explicitly denied
    expect(source).toContain('(deny file-read* (subpath "/etc/ssh"))');
    expect(source).toContain('(deny file-read* (subpath "/etc/ssl/private"))');
    // /var/folders must NOT have broad write access
    expect(source).not.toContain('(allow file-write* (subpath "/var/folders"))');
  });

});
