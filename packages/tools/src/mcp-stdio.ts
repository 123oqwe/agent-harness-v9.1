/**
 * AH-MCP-STDIO-001: MCP stdio transport with lazy load.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolResult } from './types.js';
import { ToolUnavailableError } from './types.js';

interface McpStdioConfig {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

interface McpConnection {
  process: ChildProcess;
  initialized: boolean;
}

const connections = new Map<string, McpConnection>();

export async function connectMcpStdio(id: string, config: McpStdioConfig): Promise<ToolResult> {
  if (connections.has(id)) {
    return { success: true, output: { id, status: 'already_connected' } };
  }
  try {
    const proc = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });
    connections.set(id, { process: proc, initialized: false });
    return {
      success: true,
      output: { id, status: 'connected', pid: proc.pid },
    };
  } catch (e) {
    return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disconnectMcpStdio(id: string): Promise<ToolResult> {
  const conn = connections.get(id);
  if (!conn) return { success: false, output: null, error: 'connection not found' };
  conn.process.kill();
  connections.delete(id);
  return { success: true, output: { id, status: 'disconnected' } };
}

export function getConnection(id: string): McpConnection | undefined {
  return connections.get(id);
}
