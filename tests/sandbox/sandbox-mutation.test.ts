import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  execSandboxed, runSandboxedText, detectMechanism, assertWithinWorkspace,
  SandboxError, DEFAULT_LIMITS, type SandboxProfile,
} from '../../runtime/sandbox.js';

function ws(tmp: string, extra?: Partial<SandboxProfile>): SandboxProfile {
  return { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [], ...extra };
}

describe('AH-SANDBOX-001 mutation-killing tests', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sbx-mut-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('detectMechanism returns seatbelt on macOS', () => {
    const m = detectMechanism();
    if (process.platform === 'darwin') expect(m).toBe('seatbelt');
    else if (process.platform === 'linux') expect(['bubblewrap', 'none']).toContain(m);
    else expect(m).toBe('none');
  });

  it('assertWithinWorkspace rejects paths outside workspace', () => {
    expect(() => assertWithinWorkspace('/etc/passwd', tmp)).toThrow(SandboxError);
    expect(() => assertWithinWorkspace('../escape', tmp)).toThrow(SandboxError);
  });

  it('assertWithinWorkspace accepts paths inside workspace', () => {
    expect(() => assertWithinWorkspace(join(tmp, 'subdir'), tmp)).not.toThrow();
    expect(() => assertWithinWorkspace(tmp, tmp)).not.toThrow();
  });

  it('execSandboxed rejects when cwd outside workspace', () => {
    expect(() => execSandboxed({
      argv: ['/bin/echo', 'hi'], cwd: '/etc', profile: ws(tmp),
    })).toThrow(SandboxError);
  });

  it('DEFAULT_LIMITS has expected values', () => {
    expect(DEFAULT_LIMITS.timeoutMs).toBe(10_000);
    expect(DEFAULT_LIMITS.memoryMb).toBe(256);
    expect(DEFAULT_LIMITS.outputBytes).toBe(1_024 * 1_024);
    expect(DEFAULT_LIMITS.processLimit).toBe(32);
  });

  it('env credentials stripped from sandboxed child', async () => {
    process.env.TEST_API_KEY = 'secret123';
    process.env.TEST_TOKEN = 'tok456';
    process.env.TEST_PASSWORD = 'pw789';
    try {
      const r = await execSandboxed({
        argv: ['/bin/sh', '-c', 'echo $TEST_API_KEY $TEST_TOKEN $TEST_PASSWORD'],
        cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
      });
      const out = r.stdout.toString().trim();
      expect(out).not.toContain('secret123');
      expect(out).not.toContain('tok456');
      expect(out).not.toContain('pw789');
    } finally {
      delete process.env.TEST_API_KEY;
      delete process.env.TEST_TOKEN;
      delete process.env.TEST_PASSWORD;
    }
  }, 10000);

  it('non-secret env preserved in sandboxed child', async () => {
    process.env.MY_SAFE_VAR = 'safevalue';
    try {
      const r = await execSandboxed({
        argv: ['/bin/sh', '-c', 'echo $MY_SAFE_VAR'],
        cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
      });
      expect(r.stdout.toString().trim()).toBe('safevalue');
    } finally {
      delete process.env.MY_SAFE_VAR;
    }
  }, 10000);

  it('runSandboxedText returns trimmed stdout on success', async () => {
    const out = await runSandboxedText({
      argv: ['/bin/echo', 'hello world'], cwd: tmp, profile: ws(tmp),
    });
    expect(out.trim()).toBe('hello world');
  }, 10000);

  it('runSandboxedText throws on non-zero exit', async () => {
    await expect(runSandboxedText({
      argv: ['/bin/sh', '-c', 'exit 1'], cwd: tmp, profile: ws(tmp),
    })).rejects.toThrow(SandboxError);
  }, 10000);

  it('runSandboxedText with ignoreExit does not throw', async () => {
    const out = await runSandboxedText({
      argv: ['/bin/sh', '-c', 'exit 42'], cwd: tmp, profile: ws(tmp),
    }, true);
    expect(typeof out).toBe('string');
  }, 10000);

  it('timeout does not produce exitCode 0', async () => {
    const r = await execSandboxed({
      argv: ['/bin/sh', '-c', 'sleep 10'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 500 },
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  }, 10000);

  it('cancel does not produce exitCode 0', async () => {
    const ctrl = new AbortController();
    const p = execSandboxed({
      argv: ['/bin/sh', '-c', 'sleep 10'], cwd: tmp, profile: ws(tmp),
      limits: { timeoutMs: 10000 }, signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 100);
    const r = await p;
    expect(r.canceled).toBe(true);
    expect(r.exitCode).not.toBe(0);
  }, 10000);

  it('stderr is captured separately from stdout', async () => {
    const r = await execSandboxed({
      argv: ['/bin/sh', '-c', 'echo out; echo err 1>&2'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
    });
    expect(r.stdout.toString().trim()).toBe('out');
    expect(r.stderr.toString().trim()).toBe('err');
  }, 10000);

  it('exitCode is reported for normal exit', async () => {
    const r = await execSandboxed({
      argv: ['/bin/sh', '-c', 'exit 7'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
    });
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.canceled).toBe(false);
  }, 10000);

  it('allowRead extra paths are accessible', async () => {
    const extraDir = mkdtempSync(join(tmpdir(), 'sbx-extra-'));
    writeFileSync(join(extraDir, 'data.txt'), 'readable');
    try {
      const r = await execSandboxed({
        argv: ['/bin/cat', join(extraDir, 'data.txt')],
        cwd: tmp, profile: ws(tmp, { allowRead: [extraDir] }), limits: { timeoutMs: 5000 },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString().trim()).toBe('readable');
    } finally {
      rmSync(extraDir, { recursive: true, force: true });
    }
  }, 10000);

  it('mechanism is reported in result', async () => {
    const r = await execSandboxed({
      argv: ['/bin/echo', 'test'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
    });
    if (process.platform === 'darwin') expect(r.mechanism).toBe('seatbelt');
  }, 10000);

  it('durationMs is positive and reasonable', async () => {
    const r = await execSandboxed({
      argv: ['/bin/echo', 'fast'], cwd: tmp, profile: ws(tmp), limits: { timeoutMs: 5000 },
    });
    expect(r.durationMs).toBeGreaterThan(0);
    expect(r.durationMs).toBeLessThan(10000);
  }, 10000);
});
