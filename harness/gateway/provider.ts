/**
 * AH-GATEWAY-PROVIDER-001: Provider Adapter Contract
 *
 * Shared types for model providers. The ScriptedTestProvider in
 * scripted-provider.ts implements this interface for deterministic testing.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ParsedResponse {
  content: string;
  tool_calls?: ToolCall[];
  stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter';
  usage?: Usage;
  model?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;  // o-series / Claude thinking
}

export interface ProviderRequest {
  messages: Message[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** Controls tool calling behavior: 'auto' (default), 'required', 'none', or a specific tool name. */
  tool_choice?: 'auto' | 'required' | 'none' | string;
}

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface DataPolicyResult {
  allowed: boolean;
  reason?: string;
}

export type ProviderError =
  | { kind: 'rate_limited'; retryable: boolean; detail: string }
  | { kind: 'auth'; retryable: boolean; detail: string }
  | { kind: 'invalid_request'; retryable: boolean; detail: string }
  | { kind: 'server'; retryable: boolean; detail: string }
  | { kind: 'timeout'; retryable: boolean; detail: string }
  | { kind: 'unknown'; retryable: boolean; detail: string };

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; tool_call: ToolCall }
  | { type: 'message_stop'; stop_reason: ParsedResponse['stop_reason']; usage?: Usage };

export interface ProviderAdapter {
  readonly provider_type: 'openai' | 'anthropic' | 'google' | 'local' | 'scripted_test';

  /**
   * Normalize a ProviderRequest into the provider's native HTTP request body.
   * Returns the body object that will be sent as JSON to the provider's API.
   */
  normalizeRequest(req: ProviderRequest): unknown;

  /**
   * Execute the HTTP request to the provider. Takes the normalized request body
   * and an API key, returns the raw JSON response. This is the actual network call.
   * For scripted_test providers, this is a no-op (returns the input directly).
   */
  executeRequest(normalizedReq: unknown, apiKey: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;

  /**
   * Parse the raw JSON response from the provider into a ParsedResponse.
   */
  parseResponse(raw: unknown): ParsedResponse;

  normalizeToolCall(raw: unknown): ToolCall;
  streamEvents(req: ProviderRequest): AsyncIterable<StreamEvent>;
  mapError(raw: unknown): ProviderError;
  meterUsage(res: ParsedResponse): Usage;
  checkHealth(): HealthStatus;
  validateDataPolicy(req: ProviderRequest): DataPolicyResult;
}

export interface ToolSpec {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}
