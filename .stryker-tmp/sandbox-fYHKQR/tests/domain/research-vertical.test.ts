// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { runResearchVertical } from '../../research/ah_research_vertical_001.js';

describe('AH-RESEARCH-VERTICAL-001 research vertical', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'res-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('reads sources, organizes evidence, identifies conflicts, cites sources', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'The sky is blue today');
    writeFileSync(join(tmp, 'b.txt'), 'The sky is gray today');
    const r = await runResearchVertical(vfs, { sources: ['/workspace/a.txt', '/workspace/b.txt'], query: 'sky is' });
    expect(r.evidence).toHaveLength(2);
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.citations).toContain('/workspace/a.txt');
    expect(r.report).toContain('sky is');
  });
});
