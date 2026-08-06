import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand } from '../../tools/execute-command.js';

describe('AH-TOOL-EXEC-001 execute_command', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'xec-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('executes a command in the sandbox', async () => {
    const r = await executeCommand({ workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, { argv: ['/bin/echo', 'hello'], cwd: tmp });
    expect(r.exit_code).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });
  it('enforces timeout', async () => {
    const r = await executeCommand({ workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, { argv: ['/bin/sh', '-c', 'sleep 5'], cwd: tmp, timeout_ms: 500 });
    expect(r.timed_out).toBe(true);
  });
  it('captures stderr', async () => {
    const r = await executeCommand({ workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, { argv: ['/bin/sh', '-c', 'echo err >&2; exit 1'], cwd: tmp });
    expect(r.exit_code).toBe(1);
    expect(r.stderr.trim()).toBe('err');
  });
  it('forwards stdin without changing its contents', async () => {
    const r = await executeCommand(
      { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] },
      { argv: ['/bin/cat'], cwd: tmp, stdin: 'input payload\n' },
    );
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe('input payload\n');
  });

  it('captures stdout via on_output callback', async () => {
    const chunks: Array<{ stream: string; chunk: string }> = [];
    const r = await executeCommand(
      { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] },
      { argv: ['/bin/echo', 'streamed'], cwd: tmp, on_output: (stream, chunk) => chunks.push({ stream, chunk }) },
    );
    expect(r.exit_code).toBe(0);
    expect(chunks.some(c => c.stream === 'stdout' && c.chunk.includes('streamed'))).toBe(true);
  });

  it('captures stderr via on_output callback', async () => {
    const chunks: Array<{ stream: string; chunk: string }> = [];
    const r = await executeCommand(
      { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] },
      { argv: ['/bin/sh', '-c', 'echo err >&2'], cwd: tmp, on_output: (stream, chunk) => chunks.push({ stream, chunk }) },
    );
    expect(r.exit_code).toBe(0);
    expect(chunks.some(c => c.stream === 'stderr' && c.chunk.includes('err'))).toBe(true);
  });

  it('reports duration_ms for completed commands', async () => {
    const r = await executeCommand(
      { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] },
      { argv: ['/bin/echo', 'fast'], cwd: tmp },
    );
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports timed_out flag correctly for non-timeout exits', async () => {
    const r = await executeCommand(
      { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] },
      { argv: ['/bin/echo', 'ok'], cwd: tmp },
    );
    expect(r.timed_out).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it('handles commands that exit with non-zero codes', async () => {
    const r = await executeCommand(
      { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] },
      { argv: ['/bin/sh', '-c', 'exit 42'], cwd: tmp },
    );
    expect(r.exit_code).toBe(42);
  });
});
