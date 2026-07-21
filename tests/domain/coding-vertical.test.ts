import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { runCodingVertical } from '../../domains/coding/ah_coding_vertical_001.js';

describe('AH-CODING-VERTICAL-001 coding vertical', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cod-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('reads repo, locates bug, modifies file, runs tests, produces diff', async () => {
    writeFileSync(join(tmp, 'bug.ts'), 'function add(a, b) { return a - b; }'); // bug: subtracts instead of adds
    const r = await runCodingVertical(vfs, { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, {
      repo_path: '/workspace', bug_file: '/workspace/bug.ts', bug_pattern: 'return a - b', fix: 'return a + b',
      test_command: ['/bin/echo', 'tests passed'],
    });
    expect(r.bug_located).toBe(true);
    expect(r.edited).toBe(true);
    expect(r.test_exit_code).toBe(0);
    expect(r.diff_before).toContain('a - b');
    expect(r.diff_after).toContain('a + b');
  });
  it('crash restore: no duplicate side effects on re-run', async () => {
    writeFileSync(join(tmp, 'f.ts'), 'BUG');
    const r1 = await runCodingVertical(vfs, { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, { repo_path: '/workspace', bug_file: '/workspace/f.ts', bug_pattern: 'BUG', fix: 'FIXED', test_command: ['/bin/echo', 'ok'] });
    expect(r1.edited).toBe(true);
    // re-run: pattern already replaced, so not edited again (idempotent)
    const r2 = await runCodingVertical(vfs, { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, { repo_path: '/workspace', bug_file: '/workspace/f.ts', bug_pattern: 'BUG', fix: 'FIXED', test_command: ['/bin/echo', 'ok'] });
    expect(r2.edited).toBe(false);
    expect(r2.bug_located).toBe(false);
  });
});
