// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { runDocVertical } from '../../ingestion/ah_doc_vertical_001.js';

describe('AH-DOC-VERTICAL-001 documents vertical', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'doc-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('reads document, extracts text preserving structure, summarizes, cites page numbers', async () => {
    writeFileSync(join(tmp, 'doc.txt'), 'Page one has intro.\fPage two has details.\fPage three has conclusion.');
    const r = await runDocVertical(vfs, { path: '/workspace/doc.txt' });
    expect(r.pages).toHaveLength(3);
    expect(r.pages[0]!.page).toBe(1);
    expect(r.summary).toContain('p1:');
    expect(r.citations[0]!.page).toBe(1);
    expect(r.citations[0]!.excerpt).toBeTruthy();
  });
});
