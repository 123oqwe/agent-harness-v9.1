/**
 * AH-MCP-STDIO-001: MCP stdio transport with lazy load.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolResult } from './types.js';

interface McpStdioConfig {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

interface McpConnection {
  child: ChildProcess;
  initialized: boolean;
}

const connections = new Map<string, McpConnection>();

// Drain stdout/stderr to prevent pipe deadlock
function drainStreams(child: ChildProcess): void {
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
}

// Clean up child processes on parent exit
process.on('exit', () => {
  for (const conn of connections.values()) {
    try { conn.child.kill('SIGKILL'); } catch { /* already dead */ }
  }
});

export async function connectMcpStdio(id: string, config: McpStdioConfig): Promise<ToolResult> {
  if (connections.has(id)) {
    return { success: true, output: { id, status: 'already_connected' } };
  }
  try {
    const proc = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });
    drainStreams(proc);
    proc.on('exit', () => {
      connections.delete(id);
    });
    proc.on('error', () => {
      connections.delete(id);
    });
    connections.set(id, { child: proc, initialized: false });
    proc.unref();
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
  try { conn.child.kill('SIGTERM'); } catch { /* already dead */ }
  // SIGKILL fallback after 5s
  setTimeout(() => {
    try { conn.child.kill('SIGKILL'); } catch { /* already dead */ }
  }, 5000);
  connections.delete(id);
  return { success: true, output: { id, status: 'disconnected' } };
}

export function getConnection(id: string): McpConnection | undefined {
  return connections.get(id);
}
