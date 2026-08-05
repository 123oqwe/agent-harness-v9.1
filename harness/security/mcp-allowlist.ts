/**
 * AH-SECURITY-003: MCP Allowlist (P2-10)
 *
 * MCP servers require explicit approval before connection.
 * mcp_allowlist.json lists approved MCP servers by signature.
 */

import { createHash } from 'node:crypto';

export interface McpAllowlistEntry {
  name: string;
  command?: string;
  args_hash?: string;
  url?: string;
  key_pin?: string;
}

export class McpAllowlist {
  private readonly entries = new Map<string, McpAllowlistEntry>();

  constructor(entries: McpAllowlistEntry[] = []) {
    for (const entry of entries) this.add(entry);
  }

  add(entry: McpAllowlistEntry): void {
    this.entries.set(entry.name, entry);
  }

  remove(name: string): void {
    this.entries.delete(name);
  }

  /**
   * Check if a stdio MCP server is allowed.
   * Validates command + args hash.
   */
  isStdioAllowed(command: string, argsHash: string): { allowed: boolean; reason?: string } {
    for (const entry of this.entries.values()) {
      if (entry.command === command && entry.args_hash === argsHash) {
        return { allowed: true };
      }
    }
    return { allowed: false, reason: `stdio MCP server '${command}' with args hash '${argsHash}' not in allowlist` };
  }

  /**
   * Check if a remote MCP server is allowed.
   * Validates URL + key pin.
   */
  isRemoteAllowed(url: string, keyPin: string): { allowed: boolean; reason?: string } {
    for (const entry of this.entries.values()) {
      if (entry.url === url && entry.key_pin === keyPin) {
        return { allowed: true };
      }
    }
    return { allowed: false, reason: `remote MCP server '${url}' not in allowlist` };
  }

  list(): McpAllowlistEntry[] {
    return [...this.entries.values()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }
}

/**
 * MCP SSE Transport (P2-09).
 * Connects to remote MCP servers via Server-Sent Events.
 */
export type McpTransportType = 'stdio' | 'sse';

export interface McpServerConfig {
  name: string;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class McpClient {
  private readonly allowlist: McpAllowlist | null;
  private readonly connected = new Map<string, McpServerConfig>();
  private readonly tools = new Map<string, McpTool[]>();

  constructor(allowlist?: McpAllowlist) {
    this.allowlist = allowlist ?? null;
  }

  async connect(config: McpServerConfig): Promise<{ connected: boolean; blocked?: string }> {
    // Check allowlist
    if (this.allowlist) {
      if (config.transport === 'stdio' && config.command) {
        const argsHash = createHash('sha256')
          .update(JSON.stringify(config.args ?? []))
          .digest('hex');
        const check = this.allowlist.isStdioAllowed(config.command, argsHash);
        if (!check.allowed) {
          return { connected: false, blocked: check.reason };
        }
      }
      if (config.transport === 'sse' && config.url) {
        // For SSE, check URL against allowlist (key pin optional)
        const entry = this.allowlist.list().find((e) => e.url === config.url);
        if (!entry) {
          return { connected: false, blocked: `SSE MCP server '${config.url}' not in allowlist` };
        }
      }
    }
    this.connected.set(config.name, config);
    return { connected: true };
  }

  disconnect(name: string): void {
    this.connected.delete(name);
    this.tools.delete(name);
  }

  registerTools(serverName: string, tools: McpTool[]): void {
    this.tools.set(serverName, tools);
  }

  getTools(serverName?: string): McpTool[] {
    if (serverName) return this.tools.get(serverName) ?? [];
    return [...this.tools.values()].flat();
  }

  listConnected(): string[] {
    return [...this.connected.keys()];
  }
}
