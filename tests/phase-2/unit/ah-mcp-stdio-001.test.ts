import { describe, expect, it } from 'vitest';
import { connectMcpStdio, disconnectMcpStdio, getConnection, setMcpAllowlist, getMcpAllowlist } from '../../../packages/tools/src/index.js';

describe('AH-MCP-STDIO-001: MCP stdio transport with lazy load', () => {
  it('connects to MCP server with allowed command', async () => {
    const result = await connectMcpStdio('test-conn', { command: 'echo', args: ['mcp'] });
    expect(result.success).toBe(true);
    expect(getConnection('test-conn')).toBeDefined();
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('connected');
    expect(output.pid).toBeDefined();
  });

  it('handles duplicate connections by returning already_connected', async () => {
    await connectMcpStdio('dup-conn', { command: 'echo' });
    const result = await connectMcpStdio('dup-conn', { command: 'echo' });
    expect(result.success).toBe(true);
    expect((result.output as Record<string,string>).status).toBe('already_connected');
  });

  it('disconnects cleanly', async () => {
    await connectMcpStdio('disc-conn', { command: 'echo' });
    const result = await disconnectMcpStdio('disc-conn');
    expect(result.success).toBe(true);
    expect((result.output as Record<string,string>).status).toBe('disconnected');
    expect(getConnection('disc-conn')).toBeUndefined();
  });

  it('rejects commands not on the allowlist', async () => {
    const result = await connectMcpStdio('reject-test', { command: 'rm', args: ['-rf', '/'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not on the MCP allowlist');
    expect(getConnection('reject-test')).toBeUndefined();
  });

  it('accepts command paths and resolves basename for allowlist check', async () => {
    const result = await connectMcpStdio('path-test', { command: '/usr/bin/echo', args: ['test'] });
    expect(result.success).toBe(true);
  });

  it('setMcpAllowlist replaces the allowlist', () => {
    const original = getMcpAllowlist();
    setMcpAllowlist(['echo', 'node']);
    expect(getMcpAllowlist()).toEqual(expect.arrayContaining(['echo', 'node']));
    expect(getMcpAllowlist()).not.toContain('python3');
    // Restore
    setMcpAllowlist(original);
  });

  it('disconnecting a non-existent connection returns error', async () => {
    const result = await disconnectMcpStdio('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('connection not found');
  });
});
