/**
 * AH-SECURITY-003: MCP Allowlist (P2-09, P2-10)
 */
import { createHash } from 'node:crypto';

export interface McpAllowlistEntry { name: string; command?: string | undefined; args_hash?: string | undefined; url?: string | undefined; key_pin?: string | undefined }
export type McpTransportType = 'stdio' | 'sse';
export interface McpServerConfig { name: string; transport: McpTransportType; command?: string | undefined; args?: string[] | undefined; url?: string | undefined; headers?: Record<string, string> | undefined }
export interface McpTool { name: string; description: string; input_schema: Record<string, unknown> }

export class McpAllowlist {
  private readonly entries = new Map<string, McpAllowlistEntry>();
  constructor(entries: McpAllowlistEntry[] = []) { for (const e of entries) this.add(e); }
  add(e: McpAllowlistEntry): void { this.entries.set(e.name, e); }
  isStdioAllowed(command: string, argsHash: string): { allowed: boolean; reason?: string | undefined } {
    for (const e of this.entries.values()) if (e.command === command && e.args_hash === argsHash) return { allowed: true };
    return { allowed: false, reason: `stdio MCP '${command}' not in allowlist` };
  }
  isRemoteAllowed(url: string, keyPin: string): { allowed: boolean; reason?: string | undefined } {
    for (const e of this.entries.values()) if (e.url === url && e.key_pin === keyPin) return { allowed: true };
    return { allowed: false, reason: `remote MCP '${url}' not in allowlist` };
  }
  list(): McpAllowlistEntry[] { return [...this.entries.values()]; }
}

export class McpClient {
  private readonly allowlist: McpAllowlist | null;
  private readonly connected = new Map<string, McpServerConfig>();
  private readonly tools = new Map<string, McpTool[]>();

  constructor(allowlist?: McpAllowlist) { this.allowlist = allowlist ?? null; }

  async connect(config: McpServerConfig): Promise<{ connected: boolean; blocked?: string | undefined }> {
    if (this.allowlist) {
      if (config.transport === 'stdio' && config.command) {
        const hash = createHash('sha256').update(JSON.stringify(config.args ?? [])).digest('hex');
        const check = this.allowlist.isStdioAllowed(config.command, hash);
        if (!check.allowed) return { connected: false, blocked: check.reason };
      }
      if (config.transport === 'sse' && config.url) {
        const entry = this.allowlist.list().find(e => e.url === config.url);
        if (!entry) return { connected: false, blocked: `SSE MCP '${config.url}' not in allowlist` };
      }
    }
    this.connected.set(config.name, config);
    return { connected: true };
  }

  disconnect(name: string): void { this.connected.delete(name); this.tools.delete(name); }
  registerTools(name: string, tools: McpTool[]): void { this.tools.set(name, tools); }
  getTools(name?: string): McpTool[] { if (name) return this.tools.get(name) ?? []; return [...this.tools.values()].flat(); }
  listConnected(): string[] { return [...this.connected.keys()]; }
}
