import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand } from '../../tools/execute-command.js';

describe('AH-TOOL-EXEC-001 execute_command_sandboxed', () => {
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
});
