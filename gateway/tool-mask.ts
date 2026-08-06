import type { CacheManager } from './cache-manager.js';

export type ExecutionState = 'setup' | 'planning' | 'executing' | 'verifying' | 'idle';

export type ToolGroup = 'fs_read' | 'fs_write' | 'web' | 'browser' | 'screen' | 'system' | 'mcp' | 'artifact';

export interface ToolMaskConfig {
  enabled: boolean;
  groupPrefixes: Record<ToolGroup, string[]>;
  allowedGroupsByState: Record<ExecutionState, ToolGroup[]>;
}

export interface ToolMaskCheckResult {
  allowed: boolean;
  tool_name: string;
  group: ToolGroup | null;
  state: ExecutionState;
  reason?: string;
}

const DEFAULT_GROUP_PREFIXES: Record<ToolGroup, string[]> = {
  fs_read: ['read_file', 'list_directory', 'search_files'],
  fs_write: ['write_file', 'edit_file'],
  web: ['web_', 'fetch_', 'search_web'],
  browser: ['browser_', 'navigate_', 'click_'],
  screen: ['screen_', 'screenshot_'],
  system: ['execute_command', 'parse_document', 'ask_user'],
  mcp: ['mcp_'],
  artifact: ['create_artifact', 'tool_load', 'tool_search'],
};

const DEFAULT_ALLOWED_BY_STATE: Record<ExecutionState, ToolGroup[]> = {
  setup: ['fs_read', 'system'],
  planning: ['fs_read', 'web', 'system'],
  executing: ['fs_read', 'fs_write', 'web', 'browser', 'screen', 'system', 'mcp', 'artifact'],
  verifying: ['fs_read', 'system'],
  idle: [],
};

export class ToolMaskStateMachine {
  private state: ExecutionState = 'idle';
  private readonly config: ToolMaskConfig;
  private readonly cacheManager: CacheManager | null;
  private readonly maskChanges: Array<{ timestamp: number; from: ExecutionState; to: ExecutionState; masked_groups: ToolGroup[] }> = [];

  constructor(opts: { enabled?: boolean; cacheManager?: CacheManager } = {}) {
    this.config = {
      enabled: opts.enabled ?? false,
      groupPrefixes: { ...DEFAULT_GROUP_PREFIXES },
      allowedGroupsByState: { ...DEFAULT_ALLOWED_BY_STATE },
    };
    this.cacheManager = opts.cacheManager ?? null;
  }

  get currentState(): ExecutionState { return this.state; }
  get isEnabled(): boolean { return this.config.enabled; }

  transition(newState: ExecutionState): void {
    if (newState === this.state) return;
    const oldState = this.state;
    this.state = newState;

    const previouslyAllowed = new Set(this.config.allowedGroupsByState[oldState] ?? []);
    const nowAllowed = new Set(this.config.allowedGroupsByState[newState] ?? []);
    const maskedGroups: ToolGroup[] = [];
    for (const group of Object.keys(this.config.groupPrefixes) as ToolGroup[]) {
      if (previouslyAllowed.has(group) && !nowAllowed.has(group)) {
        maskedGroups.push(group);
      }
    }

    this.maskChanges.push({
      timestamp: Date.now(),
      from: oldState,
      to: newState,
      masked_groups: maskedGroups,
    });

    // Key: tool definitions stay STABLE in the prompt — only the mask changes.
    // This does NOT invalidate the system_prompt cache layer (CTRL-TOOL-MASK-001).
    // Only report to cache manager if definitions actually changed (they didn't).
  }

  classifyTool(toolName: string): ToolGroup | null {
    for (const [group, prefixes] of Object.entries(this.config.groupPrefixes)) {
      for (const prefix of prefixes) {
        if (toolName === prefix || toolName.startsWith(prefix)) {
          return group as ToolGroup;
        }
      }
    }
    return null;
  }

  isToolAllowed(toolName: string): ToolMaskCheckResult {
    if (!this.config.enabled) {
      return { allowed: true, tool_name: toolName, group: null, state: this.state };
    }

    const group = this.classifyTool(toolName);
    if (group === null) {
      return { allowed: true, tool_name: toolName, group: null, state: this.state, reason: 'unclassified tool — allowed by default' };
    }

    const allowedGroups = this.config.allowedGroupsByState[this.state] ?? [];
    const allowed = allowedGroups.includes(group);

    return {
      allowed,
      tool_name: toolName,
      group,
      state: this.state,
      ...(allowed ? {} : { reason: `tool group '${group}' is masked in state '${this.state}' (allowed: ${allowedGroups.join(', ')})` }),
    };
  }

  /**
   * Filter a list of tool definitions to only those allowed in the current state.
   * When tool_masking is enabled, the FULL tool set stays in the prompt (stable prefix),
   * but tool calls are rejected at execution time if masked.
   *
   * This method is for providers that don't support constrained decoding —
   * it returns the full set so the prefix is stable, and rejection happens post-hoc.
   * For providers that support response prefill/constrained decoding, the full set
   * is still sent, but a tool_mask hint is added to the system prompt.
   */
  getPromptToolSet(allTools: string[]): string[] {
    if (!this.config.enabled) return allTools;
    return allTools;
  }

  /**
   * Get the set of tools that are MASKED (disabled) in the current state.
   * Used to build the mask hint for the system prompt.
   */
  getMaskedTools(allTools: string[]): string[] {
    if (!this.config.enabled) return [];
    return allTools.filter(t => !this.isToolAllowed(t).allowed);
  }

  /**
   * Build a mask hint string for the system prompt.
   * This tells the model which tools are currently unavailable,
   * without changing the tool definitions block (preserving cache).
   */
  getMaskHint(allTools: string[]): string | null {
    if (!this.config.enabled) return null;
    const masked = this.getMaskedTools(allTools);
    if (masked.length === 0) return null;
    return `[tool_mask] The following tools are currently disabled: ${masked.join(', ')}. Do not call these tools.`;
  }

  /**
   * Called when MCP servers connect/disconnect — this DOES change tool definitions
   * and invalidates the system_prompt cache layer.
   */
  onToolDefinitionsChanged(reason: string): void {
    if (this.cacheManager) {
      this.cacheManager.invalidateToolDefinitions(reason);
    }
  }

  getMaskHistory(): Array<{ timestamp: number; from: ExecutionState; to: ExecutionState; masked_groups: ToolGroup[] }> {
    return [...this.maskChanges];
  }

  reset(): void {
    this.state = 'idle';
    this.maskChanges.length = 0;
  }
}
