import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSandboxed, type SandboxProfile } from '../../sandbox/process-sandbox.js';

function ws(tmp: string): SandboxProfile {
  return { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
}

describe('AH-SANDBOX-001 limits enforced', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sbx-lim-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('kills a sleeping process after timeoutMs', async () => {
    const r = await execSandboxed({
      argv: ['/bin/sh', '-c', 'sleep 5'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 800 },
    });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(3000);
  }, 10000);

  it('truncates stdout beyond outputBytes', async () => {
    const r = await execSandboxed({
      argv: ['/bin/sh', '-c', 'yes hello'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 1000, outputBytes: 256 },
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(256);
    expect(r.limitExceeded).toBe('output');
  }, 10000);

  it('AbortSignal cancels a running process', async () => {
    const ctrl = new AbortController();
    const p = execSandboxed({
      argv: ['/bin/sh', '-c', 'sleep 5'], cwd: tmp, profile: ws(tmp),
      limits: { timeoutMs: 10000 }, signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 150);
    const r = await p;
    expect(r.canceled).toBe(true);
  }, 10000);

  it('binary output captured as Buffer', async () => {
    const bytes = String.raw`\000\001\002`;
    const r = await execSandboxed({
      argv: ['/bin/sh', '-c', `printf '${bytes}'`],
      cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
    });
    expect(Buffer.isBuffer(r.stdout)).toBe(true);
    expect(r.stdout[0]).toBe(0x00);
  }, 8000);

  it('stdin hang prevented (closed)', async () => {
    const r = await execSandboxed({ argv: ['/bin/sh', '-c', 'cat'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 3000 } });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  }, 8000);

  it('provided stdin delivered then closed', async () => {
    const r = await execSandboxed({ argv: ['/bin/cat'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 3000 }, stdin: 'payload' });
    expect(r.stdout.toString()).toBe('payload');
  }, 8000);
});
