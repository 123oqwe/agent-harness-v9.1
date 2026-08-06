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

/**
 * P2-10: MCP command allowlist.
 *
 * Only commands whose basename appears in this set may be spawned via
 * connectMcpStdio. This prevents arbitrary command execution through
 * the MCP stdio transport.
 */
const DEFAULT_MCP_ALLOWLIST = new Set<string>([
  'echo',
  'npx',
  'node',
  'python3',
  'python',
  'uvx',
  'docker',
  'mcp-server',
]);

let mcpAllowlist: Set<string> = new Set(DEFAULT_MCP_ALLOWLIST);

/** Configure the MCP command allowlist. Replaces the previous set. */
export function setMcpAllowlist(commands: readonly string[]): void {
  mcpAllowlist = new Set(commands.map((c) => c.trim()).filter(Boolean));
}

/** Returns a copy of the current allowlist. */
export function getMcpAllowlist(): string[] {
  return [...mcpAllowlist];
}

/** Resolve the basename of a command path (e.g. /usr/bin/node -> node). */
function commandBasename(command: string): string {
  const trimmed = command.trim();
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** P2-10: Validate that the command is on the allowlist before spawning. */
function validateMcpCommand(command: string): { allowed: boolean; reason?: string } {
  const basename = commandBasename(command);
  if (basename.length === 0) {
    return { allowed: false, reason: 'empty command' };
  }
  if (!mcpAllowlist.has(basename)) {
    return {
      allowed: false,
      reason: `command "${basename}" is not on the MCP allowlist (allowed: ${[...mcpAllowlist].sort().join(', ')})`,
    };
  }
  return { allowed: true };
}

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
  // P2-10: allowlist gate — reject before spawning
  const allowlistCheck = validateMcpCommand(config.command);
  if (!allowlistCheck.allowed) {
    return { success: false, output: null, error: allowlistCheck.reason ?? 'command not allowed' };
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
