import { describe, expect, it } from 'vitest';
import { webFetch } from '../../../packages/tools/src/index.js';

describe('AH-TOOL-WEB-FETCH-001: Web fetch with SSRF protection', () => {
  it('rejects non-http protocols', async () => {
    const result = await webFetch({ url: 'file:///etc/passwd' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects localhost', async () => {
    const result = await webFetch({ url: 'http://localhost:8080' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('rejects metadata endpoint', async () => {
    const result = await webFetch({ url: 'http://169.254.169.254/latest/meta-data' }, { workspace_root: '/tmp' });
    expect(result.success).toBe(false);
  });
});
