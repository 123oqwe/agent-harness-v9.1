import { describe, expect, it } from 'vitest';
import { runInOciSandbox, ToolUnavailableError } from '../../../packages/tools/src/index.js';

describe('AH-SANDBOX-OCI-001: OCI sandbox adapter', () => {
  it('throws typed unavailable when no OCI runtime', async () => {
    await expect(runInOciSandbox({
      image: 'alpine', command: ['echo', 'hi'], workspace_mount: '/tmp',
    })).rejects.toThrow(ToolUnavailableError);
  });
});
