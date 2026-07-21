import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand } from '../../tools/execute-command.js';

describe('AH-TOOL-EXEC-001 security', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'xecs-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('shell injection blocked (argv mode)', async () => {
    const r = await executeCommand({ workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, { argv: ['/bin/echo', 'a; rm -rf /'], cwd: tmp });
    expect(r.exit_code).toBe(0);
    expect(r.stdout.trim()).toBe('a; rm -rf /');
  });
  it('network denied by default', async () => {
    const r = await executeCommand({ workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, { argv: ['/bin/sh', '-c', 'curl -s --max-time 2 https://example.com >/dev/null 2>&1; echo $?'], cwd: tmp });
    expect(r.stdout.trim()).not.toBe('0');
  });
  it('credentials stripped from child env', async () => {
    process.env.X_SECRET_TOKEN = 'leak';
    const r = await executeCommand({ workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, { argv: ['/bin/sh', '-c', 'echo "${X_SECRET_TOKEN:-none}"'], cwd: tmp });
    expect(r.stdout.trim()).toBe('none');
    delete process.env.X_SECRET_TOKEN;
  });
});
