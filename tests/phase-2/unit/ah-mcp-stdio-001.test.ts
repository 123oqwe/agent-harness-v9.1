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
  it('handles disconnect of already disconnected connection', async () => {
    await connectMcpStdio('temp-conn', { command: 'echo' });
    await disconnectMcpStdio('temp-conn');
    const result = await disconnectMcpStdio('temp-conn');
    expect(result.success).toBe(false);
  });

  it('preserves allowlist across multiple operations', async () => {
    const original = getMcpAllowlist();
    setMcpAllowlist(['echo', 'cat']);
    await connectMcpStdio('conn1', { command: 'echo' });
    await connectMcpStdio('conn2', { command: 'cat' });
    expect(getConnection('conn1')).toBeDefined();
    expect(getConnection('conn2')).toBeDefined();
    await disconnectMcpStdio('conn1');
    await disconnectMcpStdio('conn2');
    setMcpAllowlist(original);
  });

});

  it('rejects empty command', async () => {
    const result = await connectMcpStdio('empty-cmd', { command: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty command');
  });

  it('rejects command with only whitespace', async () => {
    const result = await connectMcpStdio('ws-cmd', { command: '   ' });
    expect(result.success).toBe(false);
  });

  it('resolves Windows-style path basename', async () => {
    const result = await connectMcpStdio('win-path', { command: 'C:\\usr\\bin\\echo' });
    expect(result.success).toBe(true);
  });

  it('rejects shell metacharacter commands', async () => {
    const result = await connectMcpStdio('shell-inj', { command: 'echo; rm -rf /' });
    expect(result.success).toBe(false);
  });

  it('allowlist includes default commands', () => {
    const allowlist = getMcpAllowlist();
    expect(allowlist).toContain('echo');
    expect(allowlist).toContain('node');
    expect(allowlist).toContain('python3');
    expect(allowlist).toContain('npx');
  });

  it('setMcpAllowlist with empty array blocks all commands', async () => {
    const original = getMcpAllowlist();
    setMcpAllowlist([]);
    const result = await connectMcpStdio('blocked-conn', { command: 'echo' });
    expect(result.success).toBe(false);
    setMcpAllowlist(original);
  });

  it('setMcpAllowlist trims whitespace from commands', () => {
    const original = getMcpAllowlist();
    setMcpAllowlist(['  echo  ', 'node']);
    const allowlist = getMcpAllowlist();
    expect(allowlist).toContain('echo');
    expect(allowlist).not.toContain('  echo  ');
    setMcpAllowlist(original);
  });

  it('setMcpAllowlist filters empty strings', () => {
    const original = getMcpAllowlist();
    setMcpAllowlist(['echo', '', '  ', 'node']);
    const allowlist = getMcpAllowlist();
    expect(allowlist).toHaveLength(2);
    setMcpAllowlist(original);
  });

  it('handles connection with env vars', async () => {
    const result = await connectMcpStdio('env-conn', {
      command: 'echo',
      env: { MCP_TEST_VAR: 'test_value' },
    });
    expect(result.success).toBe(true);
    await disconnectMcpStdio('env-conn');
  });

  it('handles connection with args array', async () => {
    const result = await connectMcpStdio('args-conn', {
      command: 'echo',
      args: ['arg1', 'arg2', 'arg3'],
    });
    expect(result.success).toBe(true);
    await disconnectMcpStdio('args-conn');
  });

  it('handles connection with empty args array', async () => {
    const result = await connectMcpStdio('noargs-conn', {
      command: 'echo',
      args: [],
    });
    expect(result.success).toBe(true);
    await disconnectMcpStdio('noargs-conn');
  });

  it('multiple concurrent connections with unique IDs', async () => {
    await connectMcpStdio('multi-1', { command: 'echo' });
    await connectMcpStdio('multi-2', { command: 'echo' });
    await connectMcpStdio('multi-3', { command: 'echo' });
    expect(getConnection('multi-1')).toBeDefined();
    expect(getConnection('multi-2')).toBeDefined();
    expect(getConnection('multi-3')).toBeDefined();
    await disconnectMcpStdio('multi-1');
    await disconnectMcpStdio('multi-2');
    await disconnectMcpStdio('multi-3');
  });

  it('returns pid in connection output', async () => {
    const result = await connectMcpStdio('pid-conn', { command: 'echo' });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.pid).toBeDefined();
    expect(typeof output.pid).toBe('number');
    await disconnectMcpStdio('pid-conn');
  });
