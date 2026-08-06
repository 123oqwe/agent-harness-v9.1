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
  requestId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>;
  buffer: string;
}

/** JSON-RPC 2.0 request message. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response message. */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool definition as returned by tools/list. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
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

// Drain stdout/stderr to prevent pipe deadlock and parse JSON-RPC responses
function setupStreamHandlers(conn: McpConnection): void {
  conn.child.stdout?.on('data', (data: Buffer) => {
    conn.buffer += data.toString('utf8');
    // Process complete JSON-RPC messages (newline-delimited)
    let newlineIdx: number;
    while ((newlineIdx = conn.buffer.indexOf('\n')) >= 0) {
      const line = conn.buffer.slice(0, newlineIdx).trim();
      conn.buffer = conn.buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = conn.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          conn.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch { /* not a valid JSON-RPC message, ignore */ }
    }
  });
  conn.child.stderr?.on('data', () => {});
}

/** Send a JSON-RPC 2.0 request and wait for the response. */
function sendRequest(conn: McpConnection, method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  const id = ++conn.requestId;
  const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    conn.pending.set(id, { resolve, reject, timeout });
    conn.child.stdin?.write(JSON.stringify(request) + '\n');
  });
}

/** Initialize the MCP connection via JSON-RPC initialize handshake. */
export async function initializeMcp(id: string): Promise<ToolResult> {
  const conn = connections.get(id);
  if (!conn) return { success: false, output: null, error: 'connection not found' };
  if (conn.initialized) return { success: true, output: { id, status: 'already_initialized' } };
  try {
    const result = await sendRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-harness', version: '0.1.0' },
    }) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
    // Send initialized notification (no response expected)
    conn.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    conn.initialized = true;
    return {
      success: true,
      output: {
        id, status: 'initialized',
        protocol_version: result?.protocolVersion,
        server_name: result?.serverInfo?.name,
        server_version: result?.serverInfo?.version,
      },
    };
  } catch (e) {
    return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** List available tools from an MCP server via JSON-RPC tools/list. */
export async function listMcpTools(id: string): Promise<ToolResult> {
  const conn = connections.get(id);
  if (!conn) return { success: false, output: null, error: 'connection not found' };
  if (!conn.initialized) return { success: false, output: null, error: 'connection not initialized' };
  try {
    const result = await sendRequest(conn, 'tools/list') as { tools?: McpToolDefinition[] };
    return {
      success: true,
      output: { id, tools: result?.tools ?? [] },
    };
  } catch (e) {
    return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Call a tool on an MCP server via JSON-RPC tools/call. */
export async function callMcpTool(id: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const conn = connections.get(id);
  if (!conn) return { success: false, output: null, error: 'connection not found' };
  if (!conn.initialized) return { success: false, output: null, error: 'connection not initialized' };
  try {
    const result = await sendRequest(conn, 'tools/call', { name: toolName, arguments: args }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (result?.content ?? []).map(c => c.text ?? '').join('\n');
    return {
      success: !result?.isError,
      output: { id, tool: toolName, result: text },
      ...(result?.isError ? { error: text } : {}),
    };
  } catch (e) {
    return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
  }
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
    const conn: McpConnection = { child: proc, initialized: false, requestId: 0, pending: new Map(), buffer: '' };
    setupStreamHandlers(conn);
    proc.on('exit', () => {
      // Reject all pending requests
      for (const pending of conn.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('MCP server process exited'));
      }
      conn.pending.clear();
      connections.delete(id);
    });
    proc.on('error', () => {
      for (const pending of conn.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('MCP server process error'));
      }
      conn.pending.clear();
      connections.delete(id);
    });
    connections.set(id, conn);
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
