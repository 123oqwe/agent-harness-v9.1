import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { CodingWorkspaceController } from '../../ui/ah_ui_coding_001.js';
describe('AH-UI-CODING-001 coding workspace', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'uic-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  it('runFix success state', async () => { writeFileSync(join(tmp, 'f.ts'), 'BUG'); const c = new CodingWorkspaceController(vfs, { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }); const r = await c.runFix({ repo_path: '/workspace', bug_file: '/workspace/f.ts', bug_pattern: 'BUG', fix: 'FIXED', test_command: ['/bin/echo', 'ok'] }); expect(r.state).toBe('success'); expect(r.data!.edited).toBe(true); });
  it('runFix error state on missing file', async () => { const c = new CodingWorkspaceController(vfs, { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] }); const r = await c.runFix({ repo_path: '/workspace', bug_file: '/workspace/missing.ts', bug_pattern: 'x', fix: 'y', test_command: ['/bin/echo', 'ok'] }); expect(r.state).toBe('error'); });
});
