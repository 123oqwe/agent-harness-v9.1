import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import { parseDocument } from '../../ingestion/parse-document.js';

describe('AH-TOOL-PARSE-001 parse_document', () => {
  let tmp: string, vfs: VirtualFilesystem;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'pd-')); vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]); vfs.mount(new LocalBackend('/workspace', tmp)); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('parses a plain text document with page boundaries', async () => {
    writeFileSync(join(tmp, 'doc.txt'), 'Page 1\fPage 2\fPage 3');
    const r = await parseDocument(vfs, { path: '/workspace/doc.txt' });
    expect(r.pages).toHaveLength(3);
    expect(r.pages[0]!.text).toBe('Page 1');
    expect(r.pages[1]!.page).toBe(2);
  });
  it('respects max_pages', async () => {
    writeFileSync(join(tmp, 'doc.txt'), 'a\fb\fc');
    const r = await parseDocument(vfs, { path: '/workspace/doc.txt', max_pages: 2 });
    expect(r.pages).toHaveLength(2);
  });
  it('parses markdown', async () => {
    writeFileSync(join(tmp, 'md.md'), '# Title\n\nContent');
    const r = await parseDocument(vfs, { path: '/workspace/md.md' });
    expect(r.pages).toHaveLength(1);
    expect(r.total_chars).toBeGreaterThan(0);
  });
});
