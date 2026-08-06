import { describe, expect, it } from 'vitest';
import { webFetch } from '../../../packages/tools/src/index.js';

describe('AH-TOOL-WEB-FETCH-001: Web fetch with SSRF/redirect/DNS rebinding protection', () => {
  it('rejects non-http protocols (file)', async () => {
    const result = await webFetch({ url: 'file:///etc/passwd' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('only http/https');
  });

  it('rejects non-http protocols (ftp)', async () => {
    const result = await webFetch({ url: 'ftp://example.com/file' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid URLs', async () => {
    const result = await webFetch({ url: 'not-a-url' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects localhost hostname', async () => {
    const result = await webFetch({ url: 'http://localhost:8080' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked host');
  });

  it('rejects cloud metadata endpoint by IP', async () => {
    const result = await webFetch({ url: 'http://169.254.169.254/latest/meta-data' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects metadata.google.internal hostname', async () => {
    const result = await webFetch({ url: 'http://metadata.google.internal/computeMetadata/v1' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked host');
  });

  it('rejects private IP range 127.x.x.x', async () => {
    const result = await webFetch({ url: 'http://127.0.0.1:8080' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects private IP range 10.x.x.x', async () => {
    const result = await webFetch({ url: 'http://10.0.0.1' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects private IP range 192.168.x.x', async () => {
    const result = await webFetch({ url: 'http://192.168.1.1' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects obfuscated decimal IP for private range', async () => {
    // 127.0.0.1 = 2130706433 in decimal
    const result = await webFetch({ url: 'http://2130706433' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF');
  });
});
