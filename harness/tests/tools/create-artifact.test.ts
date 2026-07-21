import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFilesystem, StoreBackend } from '../../vfs/virtual-filesystem.js';
import { createArtifact } from '../../tools/create-artifact.js';

describe('AH-TOOL-ARTIFACT-001 create_artifact', () => {
  let vfs: VirtualFilesystem;
  beforeEach(() => { vfs = new VirtualFilesystem([{ prefix: '/artifacts', read: true, write: true }]); vfs.mount(new StoreBackend('/artifacts')); });

  it('stores an artifact and returns sha256', async () => {
    const r = await createArtifact(vfs, { path: '/artifacts/a.txt', content: 'hello' });
    expect(r.bytes).toBe(5);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('content is retrievable', async () => {
    await createArtifact(vfs, { path: '/artifacts/b.txt', content: 'data' });
    expect(vfs.readText('/artifacts/b.txt')).toBe('data');
  });
});
