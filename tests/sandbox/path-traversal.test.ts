import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertWithinWorkspace,
  execSandboxed,
  SandboxError,
  type SandboxProfile,
} from '../../sandbox/process-sandbox.js';

function ws(tmp: string): SandboxProfile {
  return { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
}

describe('AH-SANDBOX-001 path traversal blocked', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sbx-pt-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('assertWithinWorkspace rejects cwd outside workspace root', () => {
    expect(() => assertWithinWorkspace('/etc', tmp)).toThrow(SandboxError);
  });
  it('assertWithinWorkspace accepts cwd inside workspace root', () => {
    mkdirSync(join(tmp, 'proj'), { recursive: true });
    expect(() => assertWithinWorkspace(join(tmp, 'proj'), tmp)).not.toThrow();
  });
  it('sandboxed process cannot read /etc/passwd outside workspace', async () => {
    const r = await execSandboxed({
      argv: ['/bin/cat', '/etc/passwd'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
    });
    expect(['seatbelt','bubblewrap']).toContain(r.mechanism);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toHaveLength(0);
  }, 10000);
});
