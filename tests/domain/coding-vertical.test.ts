import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { runCodingVertical } from '../../domains/coding/ah_coding_vertical_001.js';

describe('AH-CODING-VERTICAL-001 coding vertical (LLM-driven)', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cod-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('LLM reads code, finds bug, generates fix, runs tests', async () => {
    writeFileSync(join(tmp, 'bug.ts'), 'function add(a: number, b: number): number {\n  return a - b;\n}');
    // Simulated LLM: detects a-b should be a+b
    const modelCall = async (_sys: string, _user: string) => 'function add(a: number, b: number): number {\n  return a + b;\n}';
    const r = await runCodingVertical(vfs, { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, {
      repo_path: '/workspace', bug_file: '/workspace/bug.ts', test_command: ['/bin/echo', 'tests passed'],
    }, modelCall);
    expect(r.bug_located_by_llm).toBe(true);
    expect(r.fix_applied).toBe(true);
    expect(r.diff_after).toContain('a + b');
    expect(r.test_exit_code).toBe(0);
  });

  it('LLM finds no bug — fix not applied', async () => {
    writeFileSync(join(tmp, 'ok.ts'), 'function add(a: number, b: number): number {\n  return a + b;\n}');
    const modelCall = async (_sys: string, _user: string) => 'function add(a: number, b: number): number {\n  return a + b;\n}';
    const r = await runCodingVertical(vfs, { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }, {
      repo_path: '/workspace', bug_file: '/workspace/ok.ts', test_command: ['/bin/echo', 'ok'],
    }, modelCall);
    expect(r.bug_located_by_llm).toBe(false);
    expect(r.fix_applied).toBe(false);
  });
});
