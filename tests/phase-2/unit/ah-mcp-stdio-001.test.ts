import { describe, expect, it } from 'vitest';
import { connectMcpStdio, disconnectMcpStdio, getConnection } from '../../../packages/tools/src/index.js';

describe('AH-MCP-STDIO-001: MCP stdio transport with lazy load', () => {
  it('connects to MCP server', async () => {
    const result = await connectMcpStdio('test-conn', { command: 'echo', args: ['mcp'] });
    expect(result.success).toBe(true);
    expect(getConnection('test-conn')).toBeDefined();
  });

  it('handles duplicate connections', async () => {
    await connectMcpStdio('dup-conn', { command: 'echo' });
    const result = await connectMcpStdio('dup-conn', { command: 'echo' });
    expect(result.success).toBe(true);
    expect((result.output as Record<string,string>).status).toBe("already_connected");
  });

  it('disconnects', async () => {
    await connectMcpStdio('disc-conn', { command: 'echo' });
    const result = await disconnectMcpStdio('disc-conn');
    expect(result.success).toBe(true);
  });
});
