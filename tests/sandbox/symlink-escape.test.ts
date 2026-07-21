import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSandboxed, detectMechanism, type SandboxProfile } from '../../runtime/sandbox.js';

const mechanism = detectMechanism();
const hasSandbox = mechanism !== 'none';
function ws(tmp: string): SandboxProfile {
  return { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
}

describe('AH-SANDBOX-001 symlink escape blocked', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sbx-sl-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('cannot write outside workspace via symlink', async () => {
    if (!hasSandbox) return;
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      symlinkSync(outside, join(tmp, 'escape'));
      const r = await execSandboxed({
        argv: ['/bin/sh', '-c', 'echo x > "' + join(tmp, 'escape', 'stolen.txt') + '"'],
        cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
      });
      const fs = await import('node:fs');
      expect(fs.existsSync(join(outside, 'stolen.txt'))).toBe(false);
      expect(r.exitCode).not.toBe(0);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  }, 12000);
});
