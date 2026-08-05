export interface ToolResult {
  readonly success: boolean;
  readonly output: unknown;
  readonly error?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolContext {
  readonly workspace_root: string;
  readonly signal?: AbortSignal;
  readonly credentials?: Readonly<Record<string, string>>;
}

export interface TypedTool<I, _O> {
  readonly name: string;
  readonly version: string;
  readonly requires_credentials: boolean;
  readonly credential_keys: readonly string[];
  execute(input: I, context: ToolContext): Promise<ToolResult>;
}

export class ToolUnavailableError extends Error {
  constructor(message: string, readonly tool_name: string, readonly reason: 'no_credentials' | 'not_implemented' | 'provider_unavailable') {
    super(message);
    this.name = 'ToolUnavailableError';
    Object.setPrototypeOf(this, ToolUnavailableError.prototype);
  }
}
