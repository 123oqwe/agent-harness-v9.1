import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSandboxed, detectMechanism, assertWithinWorkspace, SandboxError, type SandboxProfile } from '../../runtime/sandbox.js';

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
});
